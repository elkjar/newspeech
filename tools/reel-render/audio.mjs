// Offline audio analysis — turn a WAV into per-frame {level, low, mid, high,
// onsets} features that match what core.js's live AnalyserNode tap produces, so
// the headless render reacts the way the page would live.
//
// Mirrors core.js: AnalyserNode fftSize 1024 (→ 512 bins) with the default
// Blackman window + getByteFrequencyData dB mapping, then the exact band splits
// (8% / 25% / 60% of bins), the per-tick smoothing lerps, and the peak/onset
// detector (PEAK_DECAY / ONSET_RISE / ONSET_COOL_MS). ffmpeg decodes the WAV to
// mono float32 so we don't parse WAV containers by hand.
import { spawn } from 'node:child_process';

const FFT_SIZE = 1024;
const BINS = FFT_SIZE / 2; // frequencyBinCount
const MIN_DB = -100; // AnalyserNode defaults
const MAX_DB = -30;

// core.js tickAudio constants (keep in sync with core.js)
const PEAK_DECAY = 0.995;
const ONSET_RISE = 0.06;
const ONSET_COOL_MS = 80;

// Decode the first `seconds` of a WAV to mono float32 at `sampleRate` via ffmpeg.
export function decodeMonoF32(wavPath, seconds, sampleRate) {
  return new Promise((res, rej) => {
    const args = [
      '-v', 'error',
      '-t', String(seconds),
      '-i', wavPath,
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      '-',
    ];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', rej);
    p.on('close', (code) => {
      if (code !== 0) return rej(new Error('ffmpeg decode exit ' + code));
      const buf = Buffer.concat(chunks);
      res(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

// Blackman window (what AnalyserNode applies before the FFT).
const WINDOW = (() => {
  const w = new Float32Array(FFT_SIZE);
  for (let n = 0; n < FFT_SIZE; n++) {
    w[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (FFT_SIZE - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (FFT_SIZE - 1));
  }
  return w;
})();

// In-place iterative radix-2 FFT (re/im length FFT_SIZE).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// One byte-frequency spectrum (0..1 per bin) for a window centred near `center`.
function spectrumAt(samples, center) {
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const start = center - FFT_SIZE / 2;
  for (let n = 0; n < FFT_SIZE; n++) {
    const idx = start + n;
    const s = idx >= 0 && idx < samples.length ? samples[idx] : 0;
    re[n] = s * WINDOW[n];
  }
  fft(re, im);
  const out = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / FFT_SIZE;
    const db = mag > 0 ? 20 * Math.log10(mag) : MIN_DB;
    out[i] = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
  }
  return out;
}

// Build the per-frame feature track. Returns an array length totalFrames.
export async function computeFeatures(wavPath, { fps, seconds, sampleRate = 48000 }) {
  const samples = await decodeMonoF32(wavPath, seconds, sampleRate);
  const totalFrames = Math.round(seconds * fps);
  const dtMs = 1000 / fps;

  const lowEnd = Math.max(1, Math.floor(BINS * 0.08));
  const midEnd = Math.max(lowEnd + 1, Math.floor(BINS * 0.25));
  const highEnd = Math.max(midEnd + 1, Math.floor(BINS * 0.6));

  // Smoothing + onset state (mirrors core.js module state).
  let aLevel = 0;
  const bLevel = { low: 0, mid: 0, high: 0 };
  const bPeak = { low: 1e-3, mid: 1e-3, high: 1e-3 };
  const bCool = { low: 0, mid: 0, high: 0 };

  const frames = [];
  for (let f = 0; f < totalFrames; f++) {
    const center = Math.round((f / fps) * sampleRate);
    const spec = spectrumAt(samples, center);
    let sumAll = 0, sumLow = 0, sumMid = 0, sumHigh = 0;
    for (let i = 0; i < highEnd; i++) {
      const v = spec[i];
      sumAll += v;
      if (i < lowEnd) sumLow += v;
      else if (i < midEnd) sumMid += v;
      else sumHigh += v;
    }
    const overall = sumAll / highEnd;
    const low = sumLow / lowEnd;
    const mid = sumMid / (midEnd - lowEnd);
    const high = sumHigh / (highEnd - midEnd);

    aLevel += (overall - aLevel) * 0.25;
    bLevel.low += (low - bLevel.low) * 0.35;
    bLevel.mid += (mid - bLevel.mid) * 0.35;
    bLevel.high += (high - bLevel.high) * 0.4;

    bCool.low = Math.max(0, bCool.low - dtMs);
    bCool.mid = Math.max(0, bCool.mid - dtMs);
    bCool.high = Math.max(0, bCool.high - dtMs);
    const onLow = bCool.low === 0 && low > bPeak.low + ONSET_RISE;
    const onMid = bCool.mid === 0 && mid > bPeak.mid + ONSET_RISE;
    const onHigh = bCool.high === 0 && high > bPeak.high + ONSET_RISE;
    if (onLow) bCool.low = ONSET_COOL_MS;
    if (onMid) bCool.mid = ONSET_COOL_MS;
    if (onHigh) bCool.high = ONSET_COOL_MS;
    bPeak.low = Math.max(low, bPeak.low * PEAK_DECAY);
    bPeak.mid = Math.max(mid, bPeak.mid * PEAK_DECAY);
    bPeak.high = Math.max(high, bPeak.high * PEAK_DECAY);

    frames.push({
      level: aLevel,
      low: bLevel.low,
      mid: bLevel.mid,
      high: bLevel.high,
      onsets: { low: onLow, mid: onMid, high: onHigh },
    });
  }
  return frames;
}
