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
function reduce(buf: AudioBuffer, columns: number): WaveformPeaks {
  const frames = buf.length;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const peaks = new Float32Array(columns * 2);
  const per = frames / columns;
  for (let col = 0; col < columns; col++) {
    const i0 = Math.floor(col * per);
    const i1 = Math.min(frames, Math.floor((col + 1) * per));
    let min = 1;
    let max = -1;
    for (let i = i0; i < i1; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][i];
      s /= chans.length;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    if (i1 <= i0) {
      min = 0;
      max = 0;
    }
    peaks[col * 2] = min;
    peaks[col * 2 + 1] = max;
  }
  return { peaks, columns, frames };
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
