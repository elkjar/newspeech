// Waveform peaks for the instrument editor. Resolves the same sample file the
// .pti export uses (median root / flat file), decodes it, and reduces it to
// per-column min/max peaks for canvas display. Cached by voiceId so reopening
// the editor (or resizing) doesn't re-decode. App-only path — decode runs in
// the WKWebView's Web Audio, the audio itself plays through the native engine.

import { resolveExportSample, readBytes } from './exportPti';

export interface WaveformPeaks {
  // Per-column min/max in [-1, 1], interleaved [min0, max0, min1, max1, ...].
  peaks: Float32Array;
  columns: number;
  frames: number;
}

const cache = new Map<string, WaveformPeaks>();
let decodeCtx: OfflineAudioContext | null = null;

function ctx(): OfflineAudioContext {
  // A throwaway context purely for decodeAudioData. Rate is irrelevant —
  // peaks are positional fractions of the sample, not time.
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(1, 1, 44100);
  return decodeCtx;
}

// Reduce an AudioBuffer (downmixed to mono) to `columns` min/max pairs.
// Each column is seeded with the previous column's closing sample so adjacent
// columns always overlap by one value — without the carry, smooth or short
// audio reduces to zero-height (min == max) columns, which canvas draws as
// nothing, and the waveform renders hollow/gappy.
function reduce(buf: AudioBuffer, columns: number): WaveformPeaks {
  const frames = buf.length;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const mono = (i: number): number => {
    let s = 0;
    for (let c = 0; c < chans.length; c++) s += chans[c][i];
    return s / chans.length;
  };
  const peaks = new Float32Array(columns * 2);
  const per = frames / columns;
  let carry = frames > 0 ? mono(0) : 0;
  for (let col = 0; col < columns; col++) {
    const i0 = Math.floor(col * per);
    // Always read at least one sample (short samples make per < 1, which left
    // i1 <= i0 and produced empty columns before).
    const i1 = Math.min(frames, Math.max(i0 + 1, Math.floor((col + 1) * per)));
    let min = carry;
    let max = carry;
    for (let i = i0; i < i1; i++) {
      const s = mono(i);
      if (s < min) min = s;
      if (s > max) max = s;
    }
    if (i1 > i0) carry = mono(i1 - 1);
    peaks[col * 2] = min;
    peaks[col * 2 + 1] = max;
  }
  return { peaks, columns, frames };
}

// Decoded mono buffer for a voice, retained for analysis (slice-mode onset
// detection). Same resolve/decode path as the peaks, cached separately by
// voiceId (column-independent). decodeAudioData resamples to the context rate
// (44.1k), so `sampleRate` is 44100 — consistent with the peaks + slice fractions.
export interface VoiceMono {
  mono: Float32Array;
  frames: number;
  sampleRate: number;
}

const monoCache = new Map<string, VoiceMono>();

export async function loadVoiceMono(voiceId: string): Promise<VoiceMono | null> {
  const hit = monoCache.get(voiceId);
  if (hit) return hit;
  const resolved = resolveExportSample(voiceId);
  if (!resolved) return null;
  const ab = await readBytes(resolved);
  const buf = await ctx().decodeAudioData(ab.slice(0));
  const frames = buf.length;
  const nch = buf.numberOfChannels;
  const mono = new Float32Array(frames);
  for (let c = 0; c < nch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < frames; i++) mono[i] += d[i] / nch;
  }
  const out: VoiceMono = { mono, frames, sampleRate: buf.sampleRate };
  monoCache.set(voiceId, out);
  return out;
}

// Load (and cache) the waveform peaks for a voice at a target column count.
// Returns null when the voice has no resolvable sample. The cache key folds in
// the column count so a wider editor recomputes rather than upscaling.
export async function loadVoicePeaks(
  voiceId: string,
  columns: number,
): Promise<WaveformPeaks | null> {
  const key = `${voiceId}@${columns}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const resolved = resolveExportSample(voiceId);
  if (!resolved) return null;
  const ab = await readBytes(resolved);
  // decodeAudioData detaches the buffer; copy so a cached ArrayBuffer (if any)
  // stays intact for re-decodes.
  const buf = await ctx().decodeAudioData(ab.slice(0));
  const reduced = reduce(buf, columns);
  cache.set(key, reduced);
  return reduced;
}
