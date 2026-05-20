// Web audio recorder. Multiple parallel AudioWorklet instances tap different
// points of the audio graph; which ones record on a given take depends on
// the `splits` and `multitrack` toggles. All capture float32 PCM.
//
// Tap layout:
//   - combined: dual input (processedTap from master output + rawTap from
//     samplesBus), crossfaded by `recordRaw`. The "single WAV" path.
//   - rhythm:   tapped from rhythmBus + clickBus. Splits file 1.
//   - melody:   tapped from melodyBus + clickBus. Splits file 2.
//   - per-track (multitrack): one worklet per trackId, tapped from the
//     corresponding per-track bus + clickBus. Created on take start,
//     torn down on finalize. Pre-FX/pre-master; "raw" tap territory.
//
// clickBus into the splits/multitrack worklets is what puts count-in clicks
// into every file for DAW alignment; the audible click path is independent.
//
// Take-time mode is snapshotted into `currentTakeMode` so a mid-take toggle
// doesn't break the finalize step. The mode you start in is the mode you
// finish in.
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
  getTrackBus,
} from './audioContext';
import { tapMasterOutput } from './master';
import { useSequencerStore, type Track } from '../state/store';
import { invoke, isTauri } from '@tauri-apps/api/core';

const WORKLET_NAME = 'recorder-processor';
const TAP_RAMP_S = 0.02;
// Tail capture is silence-detected, not fixed: after `stop`, keep recording
// until the worklet output stays below TAIL_SILENCE_PEAK for TAIL_SILENCE_MS
// continuously (reverbs / sample tails / glitch fires all flush out). A hard
// cap of TAIL_MAX_MS guards against a stuck noise floor never crossing the
// threshold. A short LEAD_MS is enforced before silence-watch arms so the
// audio graph has time to settle past `stop` (avoids a one-quantum-of-zeros
// glitch finalizing instantly when the bus is momentarily empty).
const TAIL_SILENCE_PEAK = 0.001; // ~-60 dBFS
const TAIL_SILENCE_MS = 500;
const TAIL_LEAD_MS = 80;
const TAIL_MAX_MS = 15000;
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

interface TailWatch {
  silentFrames: number;
  totalFrames: number;
  onComplete: () => void;
}

interface RecorderInstance {
  worklet: AudioWorkletNode;
  chunksL: Float32Array[];
  chunksR: Float32Array[];
  recording: boolean;
  filename: string;
  tailWatch: TailWatch | null;
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

// Multitrack instances are created lazily at take start and stored keyed by
// trackId. They share buildInstance / startInstance / stopInstance with the
// fixed instances. Held in a Map across the take's lifecycle so finalizeTake
// can iterate them; cleared after finalize so each take re-snapshots the
// current track list.
const multitrackInstances = new Map<string, RecorderInstance>();

let initialized = false;
let initializing: Promise<void> | null = null;
let captureSampleRate = 48000;
let pendingFinalize: number | null = null;
let subscribed = false;
type TakeMode = 'combined' | 'splits' | 'multitrack';
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
    tailWatch: null,
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
    if (instance.tailWatch) updateTailWatch(instance, left, right);
  };
  return instance;
}

function chunkPeak(left: Float32Array, right: Float32Array | undefined): number {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i] < 0 ? -left[i] : left[i];
    if (a > peak) peak = a;
  }
  if (right && right !== left) {
    for (let i = 0; i < right.length; i++) {
      const a = right[i] < 0 ? -right[i] : right[i];
      if (a > peak) peak = a;
    }
  }
  return peak;
}

function updateTailWatch(
  instance: RecorderInstance,
  left: Float32Array,
  right: Float32Array | undefined,
): void {
  const w = instance.tailWatch;
  if (!w) return;
  const frames = left.length;
  w.totalFrames += frames;
  const leadFrames = (TAIL_LEAD_MS / 1000) * captureSampleRate;
  const silenceFrames = (TAIL_SILENCE_MS / 1000) * captureSampleRate;
  const maxFrames = (TAIL_MAX_MS / 1000) * captureSampleRate;
  if (w.totalFrames < leadFrames) return;
  const peak = chunkPeak(left, right);
  if (peak < TAIL_SILENCE_PEAK) {
    w.silentFrames += frames;
  } else {
    w.silentFrames = 0;
  }
  if (w.silentFrames >= silenceFrames || w.totalFrames >= maxFrames) {
    const cb = w.onComplete;
    instance.tailWatch = null;
    cb();
  }
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
    .then(async () => {
      await invoke('recording_write_chunk', { filename, bytes });
    })
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

    // Splits: section buses + clickBus into each split worklet so count-in
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
  if (combined?.recording || rhythm?.recording || melody?.recording) return true;
  for (const ins of multitrackInstances.values()) {
    if (ins.recording) return true;
  }
  return false;
}

async function startInstance(instance: RecorderInstance, filename: string): Promise<void> {
  instance.chunksL = [];
  instance.chunksR = [];
  instance.tailWatch = null;
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
      useSequencerStore.getState().pushToast({
        kind: 'error',
        text: `recording finalize failed · ${String(err)}`,
      });
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
      // Clear stale tail watchers from a prior take. startInstance clears
      // tailWatch on instances it restarts, but a mode change (e.g., splits
      // → combined re-arm) wouldn't restart rhythm/melody, leaving their
      // watchers alive to finalize the new take prematurely.
      if (combined) combined.tailWatch = null;
      if (rhythm) rhythm.tailWatch = null;
      if (melody) melody.tailWatch = null;
      // Snapshot the mode at take start. A mid-take toggle won't re-route
      // in flight — what you armed is what you finalize.
      currentTakeMode = state.multitrack ? 'multitrack' : state.splits ? 'splits' : 'combined';
      const base = buildFilenameBase(state);
      if (currentTakeMode === 'multitrack') {
        const audioTracks = state.tracks.filter(isAudioTrack);
        logMultitrackStart(audioTracks.length);
        const ctx = getAudioContext();
        for (let i = 0; i < audioTracks.length; i++) {
          const t = audioTracks[i];
          const ins = buildInstance(ctx);
          multitrackInstances.set(t.id, ins);
          const trackBus = getTrackBus(t.id);
          trackBus.connect(ins.worklet);
          getClickBus().connect(ins.worklet);
          const slot = String(i + 1).padStart(2, '0');
          const voiceSlug = trackVoiceSlug(t);
          void startInstance(ins, `${base}_track-${slot}-${voiceSlug}.wav`);
        }
      } else if (currentTakeMode === 'splits') {
        if (rhythm) void startInstance(rhythm, `${base}_rhythm.wav`);
        if (melody) void startInstance(melody, `${base}_melody.wav`);
      } else if (combined) {
        void startInstance(combined, `${base}.wav`);
      }
    } else {
      const mode = currentTakeMode;
      const instances: RecorderInstance[] = [];
      if (mode === 'multitrack') {
        for (const ins of multitrackInstances.values()) {
          if (ins.recording) instances.push(ins);
        }
      } else if (mode === 'splits') {
        if (rhythm && rhythm.recording) instances.push(rhythm);
        if (melody && melody.recording) instances.push(melody);
      } else if (combined && combined.recording) {
        instances.push(combined);
      }
      if (instances.length === 0) {
        void finalizeTake(mode);
        return;
      }
      // Tail-aware finalize: each active instance gets a silence watcher on
      // its worklet chunks. Finalize fires once every instance has either
      // observed continuous silence past TAIL_SILENCE_MS or hit the cap. A
      // setTimeout backstop catches the impossible case of chunks not
      // arriving (worklet stalled, audio context suspended mid-take).
      let finalized = false;
      let pending = instances.length;
      const doFinalize = () => {
        if (finalized) return;
        finalized = true;
        if (pendingFinalize !== null) {
          clearTimeout(pendingFinalize);
          pendingFinalize = null;
        }
        for (const ins of instances) ins.tailWatch = null;
        void finalizeTake(mode);
      };
      pendingFinalize = window.setTimeout(doFinalize, TAIL_MAX_MS + 1000);
      for (const ins of instances) {
        ins.tailWatch = {
          silentFrames: 0,
          totalFrames: 0,
          onComplete: () => {
            if (--pending === 0) doFinalize();
          },
        };
      }
    }
  });
}

async function finalizeTake(mode: TakeMode): Promise<void> {
  const successful: FinalizedTake[] = [];
  try {
    if (mode === 'multitrack') {
      const tasks: Promise<FinalizedTake | null>[] = [];
      const ids: string[] = [];
      for (const [trackId, ins] of multitrackInstances) {
        if (!ins.recording) continue;
        ids.push(trackId);
        tasks.push(stopInstance(ins));
      }
      const results = await Promise.all(tasks);
      for (let i = 0; i < results.length; i++) {
        const take = results[i];
        if (take) {
          deliverTake(take);
          successful.push(take);
        }
        const ins = multitrackInstances.get(ids[i]);
        if (ins) {
          try {
            const trackBus = getTrackBus(ids[i]);
            trackBus.disconnect(ins.worklet);
            getClickBus().disconnect(ins.worklet);
          } catch {
            /* node already torn down */
          }
        }
      }
      logMultitrackEnd();
      multitrackInstances.clear();
    } else if (mode === 'splits') {
      const tasks: Promise<FinalizedTake | null>[] = [];
      if (rhythm && rhythm.recording) tasks.push(stopInstance(rhythm));
      if (melody && melody.recording) tasks.push(stopInstance(melody));
      const results = await Promise.all(tasks);
      for (const take of results) {
        if (take) {
          deliverTake(take);
          successful.push(take);
        }
      }
    } else if (combined && combined.recording) {
      const take = await stopInstance(combined);
      if (take) {
        deliverTake(take);
        successful.push(take);
      }
    }
    if (successful.length > 0) {
      pushFinalizeSuccessToast(successful, mode);
    }
  } finally {
    useSequencerStore.getState().setArmed(false);
  }
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : path;
}

function pushFinalizeSuccessToast(
  takes: FinalizedTake[],
  mode: TakeMode,
): void {
  // Tauri-only — web mode does per-file `downloadWav` calls and the browser
  // shows its own download UI per file. No app-toast needed there.
  const first = takes[0];
  if (!first?.path) return;
  const duration = formatDuration(first.durationS);
  const count = takes.length;
  let label: string;
  if (count === 1) {
    label = `recording saved · ${duration}`;
  } else if (mode === 'multitrack') {
    label = `saved ${count} stems · ${duration}`;
  } else if (mode === 'splits') {
    label = `saved ${count} splits · ${duration}`;
  } else {
    label = `saved ${count} files · ${duration}`;
  }
  // Reveal target: for batches, open the parent dir so Finder lands on the
  // folder; for single takes, open the file directly so it lands selected.
  const revealPath = count === 1 ? first.path : parentDir(first.path);
  useSequencerStore.getState().pushToast({
    kind: 'success',
    text: label,
    revealPath,
  });
}

function isAudioTrack(t: Track): boolean {
  return t.source.kind === 'voice';
}

function trackVoiceSlug(t: Track): string {
  if (t.source.kind === 'voice') return t.source.id.replace(/[^a-z0-9-]/gi, '_');
  return 'midi';
}

// Lightweight perf logging for multitrack takes. Single console.info at
// take start (worklet count + base/output latency) and another at finalize
// (wall-clock elapsed). Goal is "is this glitching?" — anything more
// involved gets in the way of just listening to the take.
let multitrackStartWall = 0;
let multitrackStartCtx = 0;
function logMultitrackStart(trackCount: number): void {
  const ctx = getAudioContext();
  multitrackStartWall = performance.now();
  multitrackStartCtx = ctx.currentTime;
  const baseMs = (ctx.baseLatency ?? 0) * 1000;
  const outMs = ((ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0) * 1000;
  console.info(
    `[recorder/multitrack] start — ${trackCount} worklets · sampleRate ${ctx.sampleRate} · baseLatency ${baseMs.toFixed(2)}ms · outputLatency ${outMs.toFixed(2)}ms`,
  );
}
function logMultitrackEnd(): void {
  const ctx = getAudioContext();
  const wallS = (performance.now() - multitrackStartWall) / 1000;
  const ctxS = ctx.currentTime - multitrackStartCtx;
  const drift = wallS - ctxS;
  console.info(
    `[recorder/multitrack] end — wall ${wallS.toFixed(2)}s · audio ${ctxS.toFixed(2)}s · drift ${drift >= 0 ? '+' : ''}${(drift * 1000).toFixed(1)}ms`,
  );
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
  return `newspeech_${ts}_${state.bpm}bpm_${note}${scaleSlug}`;
}
