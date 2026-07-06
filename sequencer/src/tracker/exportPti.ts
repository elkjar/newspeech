// Export a Sequence sample voice to a Polyend Tracker instrument (.pti).
//
// A .pti holds ONE sample; Sequence melodic voices are multisampled
// (roots:[{midi,files}]). We export the MEDIAN root so the Tracker's
// pitch-stretch is spread evenly across the range (picking the top root makes
// low notes downshift 4 octaves → artifacting). `tune` stays 0 — the Tracker
// transposes by played note, not by the sample's recorded pitch (validated on
// hardware 2026-06-18; see docs/tracker-instrument-voice.md). The Tracker wants
// 16-bit 44.1k; Sequence samples are 48k, so we resample on the way out.
import Tracker, {
  AudioUtil,
  InstrumentPlayMode,
  InstrumentFilterType,
  GranularShape,
  GranularType,
  LFO_SHAPE,
  LFO_SPEED,
} from '@polyend/tracker-lib';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getRegisteredKits } from '../instruments/manifestRegistry';
import {
  voiceGainOverride,
  voiceTune,
  voiceFinetune,
  voiceReverbSend,
  voiceSaturation,
  voiceDelaySend,
  voiceTrim,
  voiceFilter,
  voiceFilterLfo,
  voiceGranular,
  resolveVoiceEnvelope,
  resolvedVoiceEdit,
  LFO_SHAPE_CODE,
  LFO_DIVISIONS,
  type LfoDivision,
} from '../instruments/voiceEditsStore';

// Our tempo-synced division → the Tracker's LFO_SPEED, matched BY NAME (both
// are "one cycle per this note value"), so the synced rate transfers exactly.
// The division label maps to the enum member `S${label}` with '/' → '_'
// (e.g. '3/4' → S3_4, '1/64' → S1_64); '1/1' is the legacy alias of '1' → S1.
const DIVISION_TO_SPEED = Object.fromEntries(
  LFO_DIVISIONS.map((d) => [d, LFO_SPEED[`S${d.replace('/', '_')}` as keyof typeof LFO_SPEED]]),
) as Record<LfoDivision, LFO_SPEED>;
DIVISION_TO_SPEED['1/1'] = LFO_SPEED.S1;

const PTI_MAX_RESONANCE = 4.3; // .pti resonance ceiling (our 0..1 maps onto it)

const PTI_MAX_POINT = 65535; // 16-bit frame addressing ceiling

export interface ResolvedSample {
  url: string; // `${baseUrl}/${file}` — a filesystem path (native) or a URL (web)
  label: string;
}

// Find the voice in the registered kits and pick the sample file to export:
// the median root for multisampled voices, else the first flat file (drums /
// one-shots). Returns null for voices with no sample (e.g. the synth `bass`).
// Exported so the waveform display resolves the same file the export does.
export function resolveExportSample(voiceId: string): ResolvedSample | null {
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
    return { url: `${kit.baseUrl}/${file}`, label: voice.label ?? voiceId };
  }
  return null;
}

export function voiceIsExportable(voiceId: string): boolean {
  return resolveExportSample(voiceId) !== null;
}

export async function readBytes(s: ResolvedSample): Promise<ArrayBuffer> {
  if (isTauri()) {
    // Native: kits live on disk; the command returns raw file bytes.
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
async function decodeResample(
  ab: ArrayBuffer,
): Promise<{ inter: Float32Array; channels: number; frames: number }> {
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
  return { inter, channels, frames };
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
    const { inter, channels, frames } = await decodeResample(ab);
    const wav = AudioUtil.createWavFile(inter, {
      numChannels: channels,
      sampleRate: 44100,
      bitsPerSample: 16,
    });
    const inst = Tracker.createInstrument(wav);
    // Carry the authored instrument edits (the same global voiceEdits the
    // local engine plays) into the file. Defaults (gain 1 / tune 0 / window
    // 0..1 / loop off) reproduce the prior full-length one-shot export.
    const trim = voiceTrim(voiceId);
    const gran = voiceGranular(voiceId);
    // Granular playmode (7) overrides the loop-derived playmode; otherwise the
    // loop mode IS the playmode (off→OneShot 0 · fwd 1 · bwd 2 · ping 3 — codes
    // match the enum 1:1). The app-only reverse one-shot (`rev`, code 4) has no
    // `.pti` equivalent (4 is Slice there), so clamp it to OneShot.
    inst.playmode = gran.on
      ? InstrumentPlayMode.Granular
      : ((trim.loop === 4 ? 0 : trim.loop) as InstrumentPlayMode);
    inst.volume = voiceGainOverride(voiceId);
    inst.tune = Math.max(-24, Math.min(24, Math.round(voiceTune(voiceId))));
    // Fine pitch trim → the .pti `finetune` field (integer cents, ±100). Separate
    // from `tune` in both models, so it maps straight across with no decomposition.
    inst.finetune = Math.max(-100, Math.min(100, Math.round(voiceFinetune(voiceId))));
    // Per-instrument reverb + delay sends — both models use a 0..1 float, so
    // they map straight across (both audible in-app via the native aux sends as
    // of 0.8.2, and carried to the real Tracker's effects).
    inst.reverbSend = Math.max(0, Math.min(1, voiceReverbSend(voiceId)));
    inst.delaySend = Math.max(0, Math.min(1, voiceDelaySend(voiceId)));
    // Per-instrument saturation → the .pti `overdrive` (0-100). Curves
    // differ (ours is the mangler tanh, the Tracker's is its own drive) so
    // this is character-approximate, but the exported instrument keeps its
    // dirt rather than arriving clean.
    inst.overdrive = Math.round(Math.max(0, Math.min(1, voiceSaturation(voiceId))) * 100);
    // Window fractions → frame points. The Tracker addresses points with a
    // 16-bit value, so samples longer than 65535 frames clamp here (the
    // device can only seek into the first 65535 frames).
    const last = Math.max(0, Math.min(frames - 1, PTI_MAX_POINT));
    const startPt = Math.round(trim.start * last);
    const endPt = Math.max(startPt, Math.round(trim.end * last));
    inst.startPoint = startPt;
    inst.endPoint = endPt;
    // Loop region tracks the trim window so a looped export loops the same
    // span you auditioned (the .pti has separate loop points; we pin them
    // to start/end — no independent loop-point control in this slice).
    inst.loopPoint1 = startPt;
    inst.loopPoint2 = endPt;
    // Per-instrument filter. type 0 = off; 1/2/3 → LowPass/HighPass/BandPass.
    // cutoff is normalized 0..1 in both models; resonance maps our 0..1 onto
    // the .pti 0..4.3 range.
    const filter = voiceFilter(voiceId);
    inst.filterEnabled = filter.type !== 0;
    if (filter.type !== 0) {
      inst.filterType =
        filter.type === 1
          ? InstrumentFilterType.LowPass
          : filter.type === 2
            ? InstrumentFilterType.HighPass
            : InstrumentFilterType.BandPass;
      inst.cutoff = Math.max(0, Math.min(1, filter.cutoff));
      inst.resonance = Math.max(0, Math.min(1, filter.resonance)) * PTI_MAX_RESONANCE;
    }
    // Cutoff LFO → automations[2] (Cutoff), LFO mode. shape codes match
    // LFO_SHAPE 1:1; depth → amount; rate → nearest synced division
    // (approximate — see hzToLfoSpeed). Only when filter + LFO are active.
    const lfo = voiceFilterLfo(voiceId);
    if (lfo.depth > 0 && inst.automations[2]) {
      inst.automations[2].enabled = true;
      inst.automations[2].isLFO = true;
      inst.automations[2].lfo = {
        shape: lfo.shape as LFO_SHAPE,
        speed: DIVISION_TO_SPEED[lfo.division],
        amount: Math.max(0, Math.min(1, lfo.depth)),
      };
    }
    // Amplitude envelope → automations[0] (Volume), envelope mode. Times are
    // integer ms in the .pti; sustain is 0..1; amount 1 = full depth. Only
    // written when the voice actually has an envelope (authored edit or
    // manifest); flat voices keep createInstrument's default.
    const env = resolveVoiceEnvelope(voiceId);
    if (env && inst.automations[0]) {
      inst.automations[0].enabled = true;
      inst.automations[0].isLFO = false;
      inst.automations[0].envelope = {
        amount: 1,
        delay: 0, // the Tracker ignores the envelope delay field — always 0
        attack: Math.max(0, Math.round(env.attack * 1000)),
        decay: Math.max(0, Math.round((env.decay ?? 0) * 1000)),
        sustain: Math.max(0, Math.min(1, env.sustain ?? 1)),
        release: Math.max(0, Math.round(env.release * 1000)),
      };
    }
    // Granular params (Phase C) → the .pti Granular block + position automation.
    // grainLength is in samples at the file's 44.1k rate (our grainMs → frames),
    // clamped to the device's 44..44100 range; currentPosition is 0..65535 over
    // the sample. shape/type codes match GranularShape/GranularType 1:1.
    if (gran.on) {
      const grainFrames = Math.round((gran.grainMs / 1000) * 44100);
      inst.granular = {
        grainLength: Math.max(44, Math.min(44100, grainFrames)),
        currentPosition: Math.round(Math.max(0, Math.min(1, gran.position)) * PTI_MAX_POINT),
        shape: gran.shape as GranularShape,
        type: gran.direction as GranularType,
      };
      // Granular-position automation → automations[4]. The slot is env-XOR-LFO;
      // prefer the LFO when on, else the envelope. depth/amount 0..1. Read
      // through the resolver so saved + unsaved edits both export.
      const edit = resolvedVoiceEdit(voiceId);
      const posLfo = edit?.granPosLfo;
      const posEnv = edit?.granPosEnv;
      if (inst.automations[4]) {
        if (posLfo?.on) {
          inst.automations[4].enabled = true;
          inst.automations[4].isLFO = true;
          inst.automations[4].lfo = {
            shape: LFO_SHAPE_CODE[posLfo.shape] as LFO_SHAPE,
            speed: DIVISION_TO_SPEED[posLfo.division],
            amount: Math.max(0, Math.min(1, Math.abs(posLfo.depth))),
          };
        } else if (posEnv?.on) {
          inst.automations[4].enabled = true;
          inst.automations[4].isLFO = false;
          inst.automations[4].envelope = {
            amount: Math.max(0, Math.min(1, Math.abs(posEnv.depth))),
            delay: 0,
            attack: Math.max(0, Math.round(posEnv.attack * 1000)),
            decay: Math.max(0, Math.round(posEnv.decay * 1000)),
            sustain: Math.max(0, Math.min(1, posEnv.sustain)),
            release: Math.max(0, Math.round(posEnv.release * 1000)),
          };
        }
      }
    }
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
