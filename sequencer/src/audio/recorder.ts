// Web audio recorder. Three parallel AudioWorklet instances tap different
// points of the audio graph; which ones record on a given take depends on
// the `stems` toggle. All capture float32 PCM, build 16-bit PCM stereo WAVs
// on stop, and trigger browser downloads.
//
// Tap layout:
//   - combined: dual input (processedTap from master output + rawTap from
//     samplesBus), crossfaded by `recordRaw`. The "single WAV" path.
//   - rhythm:   tapped from rhythmBus + clickBus. Stem 1.
//   - melody:   tapped from melodyBus + clickBus. Stem 2.
//
// clickBus into the stem worklets is what puts count-in clicks into every
// stem for DAW alignment; the audible click path is independent.
//
// Take-time mode is snapshotted into `currentTakeMode` so a mid-take stems
// toggle doesn't break the finalize step. The mode you start in is the mode
// you finish in.
//
// Web RAM limit: each active worklet buffers float32 frames until stop.
// Stems doubles RAM (two buffers in flight), so the ~20-min single-take
// ceiling drops to ~10-min for stems. Tauri streamed-to-disk lifts both.

import {
  getAudioContext,
  getSamplesBus,
  getRhythmBus,
  getMelodyBus,
  getClickBus,
} from './audioContext';
import { tapMasterOutput } from './master';
import { useSequencerStore, type BankSlot } from '../state/store';

const WORKLET_NAME = 'recorder-processor';
const TAP_RAMP_S = 0.02;
const TAIL_CAPTURE_MS = 250;

interface RecorderInstance {
  worklet: AudioWorkletNode;
  chunksL: Float32Array[];
  chunksR: Float32Array[];
  recording: boolean;
}

let combined: RecorderInstance | null = null;
let rhythm: RecorderInstance | null = null;
let melody: RecorderInstance | null = null;
let processedTap: GainNode | null = null;
let rawTap: GainNode | null = null;

let initialized = false;
let initializing: Promise<void> | null = null;
let captureSampleRate = 48000;
let pendingFinalize: number | null = null;
let subscribed = false;
type TakeMode = 'combined' | 'stems';
let currentTakeMode: TakeMode = 'combined';

function buildInstance(ctx: AudioContext): RecorderInstance {
  const worklet = new AudioWorkletNode(ctx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  const instance: RecorderInstance = {
    worklet,
    chunksL: [],
    chunksR: [],
    recording: false,
  };
  worklet.port.onmessage = (e) => {
    if (!instance.recording) return;
    const { left, right } = e.data;
    if (left) instance.chunksL.push(left);
    if (right) instance.chunksR.push(right);
  };
  return instance;
}

export async function initRecorder(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const ctx = getAudioContext();
    const url = `${import.meta.env.BASE_URL}worklets/recorder.js`;
    await ctx.audioWorklet.addModule(url);

    combined = buildInstance(ctx);
    rhythm = buildInstance(ctx);
    melody = buildInstance(ctx);

    // Combined: processedTap + rawTap crossfade into the same worklet.
    processedTap = ctx.createGain();
    rawTap = ctx.createGain();
    const initialRaw = useSequencerStore.getState().recordRaw;
    processedTap.gain.value = initialRaw ? 0 : 1;
    rawTap.gain.value = initialRaw ? 1 : 0;
    tapMasterOutput(processedTap);
    getSamplesBus().connect(rawTap);
    processedTap.connect(combined.worklet);
    rawTap.connect(combined.worklet);

    // Stems: section buses + clickBus into each stem worklet so count-in
    // clicks land in both alignment files.
    getRhythmBus().connect(rhythm.worklet);
    getClickBus().connect(rhythm.worklet);
    getMelodyBus().connect(melody.worklet);
    getClickBus().connect(melody.worklet);

    captureSampleRate = ctx.sampleRate;
    initialized = true;
  })();
  return initializing;
}

export function isRecording(): boolean {
  return !!(combined?.recording || rhythm?.recording || melody?.recording);
}

function startInstance(instance: RecorderInstance): void {
  instance.chunksL = [];
  instance.chunksR = [];
  instance.recording = true;
  instance.worklet.port.postMessage({ cmd: 'start' });
}

interface FinalizedTake {
  wav: Blob;
  durationS: number;
}

function stopInstance(instance: RecorderInstance): FinalizedTake | null {
  if (!instance.recording) return null;
  instance.recording = false;
  instance.worklet.port.postMessage({ cmd: 'stop' });
  const left = concatChunks(instance.chunksL);
  const right = concatChunks(instance.chunksR);
  instance.chunksL = [];
  instance.chunksR = [];
  if (left.length === 0) return null;
  const wav = buildWav(left, right, captureSampleRate);
  return { wav, durationS: left.length / captureSampleRate };
}

export function subscribeRecorder(): void {
  if (subscribed) return;
  subscribed = true;
  let prev = false;
  let prevRaw = useSequencerStore.getState().recordRaw;
  useSequencerStore.subscribe((state) => {
    if (!initialized) return;
    if (state.recordRaw !== prevRaw && processedTap && rawTap) {
      prevRaw = state.recordRaw;
      const ctx = getAudioContext();
      const t = ctx.currentTime;
      processedTap.gain.setTargetAtTime(state.recordRaw ? 0 : 1, t, TAP_RAMP_S);
      rawTap.gain.setTargetAtTime(state.recordRaw ? 1 : 0, t, TAP_RAMP_S);
    }
    const shouldRecord = state.armed && state.playing;
    if (shouldRecord === prev) return;
    prev = shouldRecord;
    if (shouldRecord) {
      if (pendingFinalize !== null) {
        clearTimeout(pendingFinalize);
        pendingFinalize = null;
      }
      // Snapshot the mode at take start. A mid-take stems toggle won't
      // re-route in flight — what you armed is what you finalize.
      currentTakeMode = state.stems ? 'stems' : 'combined';
      if (currentTakeMode === 'stems') {
        if (rhythm) startInstance(rhythm);
        if (melody) startInstance(melody);
      } else if (combined) {
        startInstance(combined);
      }
    } else {
      const base = buildFilenameBase(state);
      const mode = currentTakeMode;
      pendingFinalize = window.setTimeout(() => {
        pendingFinalize = null;
        if (mode === 'stems') {
          if (rhythm) {
            const r = stopInstance(rhythm);
            if (r) downloadWav(r.wav, `${base}_rhythm.wav`);
          }
          if (melody) {
            const m = stopInstance(melody);
            if (m) downloadWav(m.wav, `${base}_melody.wav`);
          }
        } else if (combined) {
          const c = stopInstance(combined);
          if (c) downloadWav(c.wav, `${base}.wav`);
        }
        useSequencerStore.getState().setArmed(false);
      }, TAIL_CAPTURE_MS);
    }
  });
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function buildWav(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  const numChannels = 2;
  const bitsPerSample = 16;
  const numFrames = Math.min(left.length, right.length);
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = numFrames * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    offset += 2;
    view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function downloadWav(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const NOTE_NAMES_FOR_FILE = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];

function buildFilenameBase(state: ReturnType<typeof useSequencerStore.getState>): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const note = NOTE_NAMES_FOR_FILE[((state.rootNote % 12) + 12) % 12];
  const scaleSlug = state.scale === 'major' ? 'maj' : state.scale === 'minor' ? 'min' : state.scale;
  const active: BankSlot | null =
    state.activeBank !== null ? state.banks[state.activeBank] : null;
  const recipe = active?.recipe?.replace('compose-', '') ?? 'manual';
  return `newspeech_${ts}_${state.bpm}bpm_${note}${scaleSlug}_${recipe}`;
}
