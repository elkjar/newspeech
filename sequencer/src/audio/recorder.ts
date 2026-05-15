// Web audio recorder. Three parallel AudioWorklet instances tap different
// points of the audio graph; which ones record on a given take depends on
// the `stems` toggle. All capture float32 PCM.
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
// Write path branches on runtime:
//   - Browser: chunks accumulate in JS arrays; on stop a WAV is built in
//     RAM and downloaded via anchor click. RAM ceiling ~20 min single /
//     ~10 min stems before the float32 backlog tips browsers over.
//   - Tauri: chunks are batched (~250 ms) into int16 stereo interleaved
//     byte payloads and streamed via invoke('recording_write_chunk') to a
//     Rust-side BufWriter. On stop the WAV header is patched. No RAM
//     ceiling — only disk.

import {
  getAudioContext,
  getSamplesBus,
  getRhythmBus,
  getMelodyBus,
  getClickBus,
} from './audioContext';
import { tapMasterOutput } from './master';
import { useSequencerStore, type BankSlot } from '../state/store';
import { invoke, isTauri } from '@tauri-apps/api/core';

const WORKLET_NAME = 'recorder-processor';
const TAP_RAMP_S = 0.02;
const TAIL_CAPTURE_MS = 250;
const TAURI_BATCH_QUANTA = 96; // ~256 ms at 48 kHz, 128-sample quanta

const TAURI = isTauri();

const LS_RECORDINGS_DIR = 'newspeech.sequencer.recordingsDir';

export function getConfiguredRecordingsDir(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(LS_RECORDINGS_DIR);
  return v && v.trim() ? v : null;
}

export function setConfiguredRecordingsDir(dir: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (dir && dir.trim()) localStorage.setItem(LS_RECORDINGS_DIR, dir);
  else localStorage.removeItem(LS_RECORDINGS_DIR);
}

interface RecorderInstance {
  worklet: AudioWorkletNode;
  chunksL: Float32Array[];
  chunksR: Float32Array[];
  recording: boolean;
  filename: string;
  // Tauri streaming state — null in browser mode.
  tauriFilename: string | null;
  tauriPendingL: Float32Array[];
  tauriPendingR: Float32Array[];
  tauriPendingFrames: number;
  tauriDrain: Promise<void>;
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
    filename: '',
    tauriFilename: null,
    tauriPendingL: [],
    tauriPendingR: [],
    tauriPendingFrames: 0,
    tauriDrain: Promise.resolve(),
  };
  worklet.port.onmessage = (e) => {
    if (!instance.recording) return;
    const { left, right } = e.data;
    if (!left) return;
    if (instance.tauriFilename) {
      instance.tauriPendingL.push(left);
      if (right) instance.tauriPendingR.push(right);
      instance.tauriPendingFrames += left.length;
      if (instance.tauriPendingFrames >= TAURI_BATCH_QUANTA * 128) {
        flushTauriPending(instance);
      }
    } else {
      instance.chunksL.push(left);
      if (right) instance.chunksR.push(right);
    }
  };
  return instance;
}

function floatStereoToInt16Bytes(left: Float32Array, right: Float32Array): Uint8Array {
  const frames = Math.min(left.length, right.length);
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(i * 4, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(i * 4 + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
  }
  return bytes;
}

function flushTauriPending(instance: RecorderInstance): void {
  const filename = instance.tauriFilename;
  if (!filename) return;
  if (instance.tauriPendingFrames === 0) return;
  const left = concatChunks(instance.tauriPendingL);
  const right =
    instance.tauriPendingR.length > 0 ? concatChunks(instance.tauriPendingR) : left;
  instance.tauriPendingL = [];
  instance.tauriPendingR = [];
  instance.tauriPendingFrames = 0;
  const bytes = floatStereoToInt16Bytes(left, right);
  // Chain on tauriDrain so writes hit the file in order even if multiple
  // flushes are inflight when the next quantum arrives.
  instance.tauriDrain = instance.tauriDrain
    .then(() => invoke('recording_write_chunk', { filename, bytes }))
    .catch((err) => {
      console.error('[recorder] write_chunk failed:', err);
    });
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

async function startInstance(instance: RecorderInstance, filename: string): Promise<void> {
  instance.chunksL = [];
  instance.chunksR = [];
  instance.tauriPendingL = [];
  instance.tauriPendingR = [];
  instance.tauriPendingFrames = 0;
  instance.tauriDrain = Promise.resolve();
  instance.filename = filename;
  if (TAURI) {
    instance.tauriFilename = filename;
    try {
      await invoke('recording_start', {
        filename,
        sampleRate: captureSampleRate,
        dir: getConfiguredRecordingsDir(),
      });
    } catch (err) {
      console.error('[recorder] recording_start failed:', err);
      instance.tauriFilename = null;
      return;
    }
  }
  instance.recording = true;
  instance.worklet.port.postMessage({ cmd: 'start' });
}

interface FinalizedTake {
  wav: Blob | null;
  path: string | null;
  durationS: number;
  filename: string;
}

async function stopInstance(instance: RecorderInstance): Promise<FinalizedTake | null> {
  if (!instance.recording) return null;
  instance.recording = false;
  instance.worklet.port.postMessage({ cmd: 'stop' });
  const filename = instance.filename;

  if (instance.tauriFilename) {
    // Flush remaining buffered samples + await all inflight writes before
    // patching the header.
    flushTauriPending(instance);
    await instance.tauriDrain;
    const activeName = instance.tauriFilename;
    instance.tauriFilename = null;
    try {
      const result = await invoke<{
        path: string;
        duration_s: number;
        data_bytes: number;
      }>('recording_finalize', { filename: activeName });
      if (result.data_bytes === 0) return null;
      return {
        wav: null,
        path: result.path,
        durationS: result.duration_s,
        filename,
      };
    } catch (err) {
      console.error('[recorder] recording_finalize failed:', err);
      return null;
    }
  }

  const left = concatChunks(instance.chunksL);
  const right = concatChunks(instance.chunksR);
  instance.chunksL = [];
  instance.chunksR = [];
  if (left.length === 0) return null;
  const wav = buildWav(left, right, captureSampleRate);
  return {
    wav,
    path: null,
    durationS: left.length / captureSampleRate,
    filename,
  };
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
      const base = buildFilenameBase(state);
      if (currentTakeMode === 'stems') {
        if (rhythm) void startInstance(rhythm, `${base}_rhythm.wav`);
        if (melody) void startInstance(melody, `${base}_melody.wav`);
      } else if (combined) {
        void startInstance(combined, `${base}.wav`);
      }
    } else {
      const mode = currentTakeMode;
      pendingFinalize = window.setTimeout(() => {
        pendingFinalize = null;
        void finalizeTake(mode);
      }, TAIL_CAPTURE_MS);
    }
  });
}

async function finalizeTake(mode: TakeMode): Promise<void> {
  try {
    if (mode === 'stems') {
      const tasks: Promise<FinalizedTake | null>[] = [];
      if (rhythm && rhythm.recording) tasks.push(stopInstance(rhythm));
      if (melody && melody.recording) tasks.push(stopInstance(melody));
      const results = await Promise.all(tasks);
      for (const take of results) {
        if (take) deliverTake(take);
      }
    } else if (combined && combined.recording) {
      const take = await stopInstance(combined);
      if (take) deliverTake(take);
    }
  } finally {
    useSequencerStore.getState().setArmed(false);
  }
}

function deliverTake(take: FinalizedTake): void {
  if (take.wav) {
    downloadWav(take.wav, take.filename);
  } else if (take.path) {
    console.info(`[recorder] saved ${take.filename} (${take.durationS.toFixed(2)}s) → ${take.path}`);
  }
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
