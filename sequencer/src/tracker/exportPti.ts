// Export a Sequence sample voice to a Polyend Tracker instrument (.pti).
//
// A .pti holds ONE sample; Sequence melodic voices are multisampled
// (roots:[{midi,files}]). We export the MEDIAN root so the Tracker's
// pitch-stretch is spread evenly across the range (picking the top root makes
// low notes downshift 4 octaves → artifacting). `tune` stays 0 — the Tracker
// transposes by played note, not by the sample's recorded pitch (validated on
// hardware 2026-06-18; see docs/tracker-instrument-voice.md). The Tracker wants
// 16-bit 44.1k; Sequence samples are 48k, so we resample on the way out.
import Tracker, { AudioUtil, InstrumentPlayMode } from '@polyend/tracker-lib';
import { invoke } from '@tauri-apps/api/core';
import { getRegisteredKits } from '../instruments/manifestRegistry';

interface ResolvedSample {
  url: string; // `${baseUrl}/${file}` — a URL for bundled kits, a filesystem path for user kits
  source: 'bundled' | 'user';
  label: string;
}

// Find the voice in the registered kits and pick the sample file to export:
// the median root for multisampled voices, else the first flat file (drums /
// one-shots). Returns null for voices with no sample (e.g. the synth `bass`).
function resolveExportSample(voiceId: string): ResolvedSample | null {
  for (const kit of getRegisteredKits()) {
    const voice = kit.manifest.voices[voiceId];
    if (!voice) continue;
    let file: string | undefined;
    if (voice.roots && voice.roots.length > 0) {
      const sorted = [...voice.roots].sort((a, b) => a.midi - b.midi);
      const median = sorted[Math.floor((sorted.length - 1) / 2)];
      file = median.files[0];
    } else if (voice.files && voice.files.length > 0) {
      file = voice.files[0];
    }
    if (!file) return null;
    return { url: `${kit.baseUrl}/${file}`, source: kit.source, label: voice.label ?? voiceId };
  }
  return null;
}

export function voiceIsExportable(voiceId: string): boolean {
  return resolveExportSample(voiceId) !== null;
}

async function readBytes(s: ResolvedSample): Promise<ArrayBuffer> {
  if (s.source === 'user') {
    // user kits live on disk; the native command returns raw file bytes
    const bytes = await invoke<number[]>('read_audio_file', { path: s.url });
    return new Uint8Array(bytes).buffer;
  }
  const res = await fetch(s.url);
  if (!res.ok) throw new Error(`fetch ${s.url}: ${res.status}`);
  return res.arrayBuffer();
}

// Decode + resample to 44.1k in one step: decodeAudioData resamples to the
// context's sample-rate, so decoding inside a 44.1k OfflineAudioContext yields
// a 44.1k buffer (browser-quality resampler, no custom DSP). Returns
// interleaved Float32 + the source channel count (mono stays mono).
async function decodeResample(ab: ArrayBuffer): Promise<{ inter: Float32Array; channels: number }> {
  const octx = new OfflineAudioContext(2, 1, 44100);
  const buf = await octx.decodeAudioData(ab);
  const channels = buf.numberOfChannels;
  const frames = buf.length;
  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buf.getChannelData(c));
  const inter = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) inter[i * channels + c] = chans[c][i];
  }
  return { inter, channels };
}

// Tracker shows the instrument name from sample.filename (≤32 bytes); an empty
// one reads as "untitled" on the device.
function sanitizeName(label: string): string {
  const clean = label.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-');
  return (clean || 'instrument').slice(0, 32);
}

export interface PtiExportResult {
  ok: boolean;
  name?: string;
  error?: string;
}

export async function exportVoiceToPti(voiceId: string): Promise<PtiExportResult> {
  try {
    const resolved = resolveExportSample(voiceId);
    if (!resolved) return { ok: false, error: 'no sample to export for this voice' };
    const ab = await readBytes(resolved);
    const { inter, channels } = await decodeResample(ab);
    const wav = AudioUtil.createWavFile(inter, {
      numChannels: channels,
      sampleRate: 44100,
      bitsPerSample: 16,
    });
    const inst = Tracker.createInstrument(wav);
    inst.playmode = InstrumentPlayMode.OneShot;
    inst.volume = 1.0;
    inst.tune = 0;
    const name = sanitizeName(resolved.label);
    inst.sample.filename = name;
    // Browser write path builds a Blob + <a download> (works in the app's
    // WKWebView, same as the JSON instrument export). Lands in the download dir.
    await Tracker.writeInstrument(inst, `${name}.pti`);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
