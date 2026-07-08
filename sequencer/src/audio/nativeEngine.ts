// Native audio engine bridge — Tauri-only. The invoke surface over the Rust
// cpal audio module: device open, sample load/trigger, per-track DSP, FX bus,
// master chain, recording. This is the app's ONLY audio path (the Web Audio
// engine was removed 2026-07-05); it grows alongside src-tauri/src/audio.rs.

import { invoke, isTauri } from '@tauri-apps/api/core';

export interface NativeDeviceInfo {
  name: string;
  isDefault: boolean;
  maxOutputChannels: number;
  defaultSampleRate: number;
  supportedSampleRates: number[];
  minBufferSize: number | null;
  maxBufferSize: number | null;
}

export interface NativeOpenedInfo {
  deviceName: string;
  channels: number;
  sampleRate: number;
  bufferSize: number;
}

export interface NativeAudioStatus {
  channels: number;
  sampleRate: number;
}

// Rust types use snake_case + Option<>. Normalize at the boundary so the
// rest of the TS code can ignore the IPC wire format.

interface RawDeviceInfo {
  name: string;
  is_default: boolean;
  max_output_channels: number;
  default_sample_rate: number;
  supported_sample_rates: number[];
  min_buffer_size: number | null;
  max_buffer_size: number | null;
}

interface RawOpenedInfo {
  device_name: string;
  channels: number;
  sample_rate: number;
  buffer_size: number;
}

interface RawAudioStatus {
  channels: number;
  sample_rate: number;
}

function normalizeDevice(d: RawDeviceInfo): NativeDeviceInfo {
  return {
    name: d.name,
    isDefault: d.is_default,
    maxOutputChannels: d.max_output_channels,
    defaultSampleRate: d.default_sample_rate,
    supportedSampleRates: d.supported_sample_rates,
    minBufferSize: d.min_buffer_size,
    maxBufferSize: d.max_buffer_size,
  };
}

function normalizeOpened(o: RawOpenedInfo): NativeOpenedInfo {
  return {
    deviceName: o.device_name,
    channels: o.channels,
    sampleRate: o.sample_rate,
    bufferSize: o.buffer_size,
  };
}

export async function listOutputDevices(): Promise<NativeDeviceInfo[]> {
  const raw = await invoke<RawDeviceInfo[]>('audio_list_output_devices');
  return raw.map(normalizeDevice);
}

// Lightweight probe: one device's CURRENT default config, off the main
// thread (async Rust command) and without the supported-range scans the
// full enumeration does. This is what the rate watch polls — the full
// listOutputDevices every 2s was hitching the whole UI (sync command =
// main thread + slow CoreAudio reads with Bluetooth present).
export async function deviceDefaultConfig(
  deviceName: string,
): Promise<{ sampleRate: number; channels: number } | null> {
  const raw = await invoke<{ sample_rate: number; channels: number } | null>(
    'audio_device_default_config',
    { deviceName },
  );
  return raw ? { sampleRate: raw.sample_rate, channels: raw.channels } : null;
}

export async function openOutputDevice(opts: {
  deviceName: string;
  channels: number;
  sampleRate: number;
  bufferSize?: number;
}): Promise<NativeOpenedInfo> {
  const raw = await invoke<RawOpenedInfo>('audio_open_device', {
    deviceName: opts.deviceName,
    channels: opts.channels,
    sampleRate: opts.sampleRate,
    bufferSize: opts.bufferSize ?? null,
  });
  return normalizeOpened(raw);
}

// --- persistence + auto-open ---------------------------------------------
//
// Saves the last device + channel/SR/buffer values to localStorage and
// auto-opens on app launch. The manual open/close UX from Phase 0 is
// retired — the cpal stream should be alive whenever the app is, and the
// user shouldn't have to click "open" every time they relaunch.

const LS_PREFIX = 'newspeech.sequencer.nativeAudio.';
const LS_DEVICE = `${LS_PREFIX}deviceName`;
const LS_CHANNELS = `${LS_PREFIX}channels`;
const LS_SAMPLE_RATE = `${LS_PREFIX}sampleRate`;
const LS_BUFFER = `${LS_PREFIX}bufferSize`;

export interface PersistedNativeAudioSettings {
  deviceName?: string;
  channels?: number;
  bufferSize?: number;
}

// Sample rate is intentionally not persisted — every launch should pick
// up the device's native default via cpal. A stale 44.1 from a previous
// session was masking real device defaults (often 48k), causing rate
// mismatches against bundled samples and the FX bus DSP.
export function readPersistedNativeAudioSettings(): PersistedNativeAudioSettings {
  if (typeof localStorage === 'undefined') return {};
  // Clean up any leftover sample-rate value from prior versions so it
  // can't be revived later. Safe to no-op if it was never written.
  try {
    localStorage.removeItem(LS_SAMPLE_RATE);
  } catch {
    /* private mode — silent */
  }
  const out: PersistedNativeAudioSettings = {};
  const d = localStorage.getItem(LS_DEVICE);
  if (d) out.deviceName = d;
  const ch = parseInt(localStorage.getItem(LS_CHANNELS) ?? '', 10);
  if (Number.isFinite(ch) && ch > 0) out.channels = ch;
  const bs = parseInt(localStorage.getItem(LS_BUFFER) ?? '', 10);
  if (Number.isFinite(bs) && bs >= 0) out.bufferSize = bs;
  return out;
}

function writePersistedNativeAudioSettings(s: {
  deviceName: string;
  channels: number;
  bufferSize: number;
}): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_DEVICE, s.deviceName);
    localStorage.setItem(LS_CHANNELS, String(s.channels));
    localStorage.setItem(LS_BUFFER, String(s.bufferSize));
  } catch {
    /* quota / private mode — silent */
  }
}

// Wraps openOutputDevice with reported-channel-count update and
// persistence. NativeAudioPanel + initNativeAudio both go through this.
export async function applyOutputDeviceConfig(config: {
  deviceName: string;
  channels: number;
  sampleRate: number;
  bufferSize?: number;
}): Promise<NativeOpenedInfo> {
  const info = await openOutputDevice(config);
  setReportedChannelCount(info.channels);
  writePersistedNativeAudioSettings({
    deviceName: config.deviceName,
    channels: config.channels,
    bufferSize: config.bufferSize ?? 0,
  });
  // Anchor the rate watch: this is a DELIBERATE open (boot or Settings), so
  // the requested channel count becomes the desired count auto-reopens clamp
  // against (and un-clamp back to when the device recovers).
  currentOpen = { ...config, sampleRate: info.sampleRate };
  desiredChannels = config.channels;
  anchorDefaultRate = null; // re-observe the device baseline on next poll
  return info;
}

// Called once on app launch. Reads persisted settings, validates against
// currently-attached devices, falls back to defaults where needed, opens
// the device. Returns null on hard failure — failure is non-fatal; user
// can still open via Settings.
//
// Guarded against double-invocation: React StrictMode runs the boot
// effect twice in dev, and the resulting double device-open left TWO
// live cpal streams both advancing the engine clock (tracks at 2x,
// 2026-07-05). One boot open only; explicit re-opens go through
// applyOutputDeviceConfig.
let bootOpenStarted = false;
export async function initNativeAudio(): Promise<NativeOpenedInfo | null> {
  if (bootOpenStarted) return null;
  bootOpenStarted = true;
  let devices: NativeDeviceInfo[];
  try {
    devices = await listOutputDevices();
  } catch (err) {
    console.warn('[nativeAudio] device list failed:', err);
    return null;
  }
  if (devices.length === 0) {
    console.warn('[nativeAudio] no output devices');
    return null;
  }
  const persisted = readPersistedNativeAudioSettings();
  // Validate persisted device — if it's been unplugged, fall back to
  // system default (or first available).
  const device =
    devices.find((d) => d.name === persisted.deviceName) ??
    devices.find((d) => d.isDefault) ??
    devices[0];
  const channels =
    persisted.channels && persisted.channels <= device.maxOutputChannels
      ? persisted.channels
      : device.maxOutputChannels;
  // Sample rate always follows the device's native default — never the
  // persisted/previous value. Catches the case where a prior session
  // saved 44.1 but the actual device runs at 48 (or vice versa for an
  // external interface). Floored at 44.1k: a Bluetooth headset held in
  // HFP by a call reports 16k, and opening THERE glitches the engine —
  // a 44.1k client stream instead lets CoreAudio resample down to the
  // degraded device (phone-call fidelity, but coherent).
  const deviceRate =
    device.defaultSampleRate || device.supportedSampleRates[0] || 48000;
  const sampleRate = Math.max(deviceRate, MIN_OPEN_SAMPLE_RATE);
  const bufferSize = persisted.bufferSize ?? 0;
  try {
    const info = await applyOutputDeviceConfig({
      deviceName: device.name,
      channels,
      sampleRate,
      bufferSize: bufferSize > 0 ? bufferSize : undefined,
    }).catch((err) => {
      // Device refused the floored rate — fall back to its own default
      // rather than booting silent.
      if (sampleRate !== deviceRate) {
        console.warn(
          `[nativeAudio] open at ${sampleRate} failed (${err}) — retrying at device rate ${deviceRate}`,
        );
        return applyOutputDeviceConfig({
          deviceName: device.name,
          channels,
          sampleRate: deviceRate,
          bufferSize: bufferSize > 0 ? bufferSize : undefined,
        });
      }
      throw err;
    });
    // Booting mid-call can clamp channels to a degraded profile (BT HFP =
    // mono). The rate watch un-clamps against the DESIRED count, so keep
    // the persisted preference as the target rather than the boot clamp —
    // otherwise a call-time launch stays mono after the headset recovers.
    if (persisted.channels && persisted.channels > channels) {
      desiredChannels = persisted.channels;
    }
    return info;
  } catch (err) {
    console.warn('[nativeAudio] open failed:', err);
    return null;
  }
}

// --- device-rate watch ----------------------------------------------------
//
// A Zoom/FaceTime mic grab flips a Bluetooth headset from A2DP (48k stereo)
// to HFP (16k mono) MID-SESSION. Since the engine-clock rework the whole app
// schedules on an absolute sample-frame timebase pinned to the rate captured
// at device open, so a silent device-rate change desyncs JS scheduling from
// rendering — the "crazy noises" glitch (2026-07-07). Nothing surfaces the
// change (cpal has no device-format listener; the stream error callback only
// logs), so we poll: compare the open device's currently-reported default
// rate / channel ceiling against what the stream was opened with, and reopen
// to match. The scheduler + engine clock already recover from a reopen's
// frame-counter reset (CLOCK_RESET_SLACK_S / RESET_JUMP_S) — this is the
// same recovery as re-applying in Settings, minus the hands.
//
// Deliberately NOT persisted: auto-reopens keep the user's saved channel
// count untouched and clamp against `desiredChannels` per-open, so when the
// call releases the headset back to 48k stereo the next poll restores the
// full config automatically.

// Floor for any automatic open (boot + rate watch). Nothing musical ever
// wants less: samples/DSP assume music rates, and CoreAudio resamples the
// client stream down to a degraded device (BT HFP 16k) on its own. Manual
// Settings choices are not clamped.
export const MIN_OPEN_SAMPLE_RATE = 44100;

let currentOpen: {
  deviceName: string;
  channels: number;
  sampleRate: number;
  bufferSize?: number;
} | null = null;
let desiredChannels: number | null = null;
// The device's reported default rate as of the last deliberate open —
// observed lazily on the first poll after it. The watch triggers on THIS
// changing, not on `open rate ≠ device default`: the Settings panel lets the
// user pick a custom rate on purpose, and the watcher must not fight it.
let anchorDefaultRate: number | null = null;

const DEVICE_RATE_POLL_MS = 2000;
let rateWatchStarted = false;
let rateWatchBusy = false;

async function checkDeviceRate(): Promise<void> {
  if (!currentOpen || rateWatchBusy) return;
  rateWatchBusy = true;
  try {
    const open = currentOpen;
    // Cheap poll: default-config probe only (async command, off the main
    // thread). Device gone (unplugged / renamed) — don't device-hop
    // mid-session; boot fallback handles it next launch, Settings now.
    const probe = await deviceDefaultConfig(open.deviceName);
    if (!probe) return;
    const freshRate = probe.sampleRate || 0;
    if (freshRate <= 0) return;
    if (anchorDefaultRate === null) {
      // First look after a deliberate open — record the baseline only.
      anchorDefaultRate = freshRate;
      return;
    }
    if (freshRate === anchorDefaultRate) return;
    // Rate actually changed — NOW pay for one full enumeration to get the
    // device's real channel ceiling for the reopen clamp. (The probe's
    // default channel count is not a ceiling — a multi-out interface
    // reports its default pair there, and clamping to it would tear down
    // a 16-channel rig.)
    const devices = await listOutputDevices();
    const dev = devices.find((d) => d.name === open.deviceName);
    if (!dev) return;
    const wantChannels = Math.min(
      desiredChannels ?? open.channels,
      Math.max(1, dev.maxOutputChannels),
    );
    const next = {
      deviceName: open.deviceName,
      channels: wantChannels,
      // Reopen floored at 44.1k — never chase a degraded device's rate
      // down; CoreAudio resamples the client stream to it instead.
      sampleRate: Math.max(freshRate, MIN_OPEN_SAMPLE_RATE),
      bufferSize: open.bufferSize,
    };
    const info = await openOutputDevice(next).catch((err) => {
      if (next.sampleRate === freshRate) throw err;
      // Device refused the floored rate — its own rate beats silence.
      console.warn(
        `[nativeAudio] rate-watch open at ${next.sampleRate} failed (${err}) — retrying at device rate ${freshRate}`,
      );
      return openOutputDevice({ ...next, sampleRate: freshRate });
    });
    setReportedChannelCount(info.channels);
    currentOpen = { ...next, sampleRate: info.sampleRate };
    anchorDefaultRate = freshRate;
    console.info(
      `[nativeAudio] device rate change — reopened ${next.deviceName} at ${info.sampleRate} Hz / ${next.channels}ch`,
    );
    void import('../state/store').then(({ useSequencerStore }) => {
      useSequencerStore.getState().pushToast({
        kind: 'success',
        text: `output rate changed — reopened at ${(info.sampleRate / 1000).toFixed(1)}k ${next.channels}ch`,
      });
    });
  } catch (err) {
    // Mid-transition opens can fail (device busy) — leave state as-is and
    // let the next poll retry.
    console.warn('[nativeAudio] rate-watch reopen failed:', err);
  } finally {
    rateWatchBusy = false;
  }
}

// Call once at boot, after initNativeAudio. Idles until a device is open.
export function installDeviceRateWatch(): void {
  if (rateWatchStarted || !isTauri()) return;
  rateWatchStarted = true;
  window.setInterval(() => void checkDeviceRate(), DEVICE_RATE_POLL_MS);
}

export async function getAudioStatus(): Promise<NativeAudioStatus> {
  const raw = await invoke<RawAudioStatus>('audio_status');
  return { channels: raw.channels, sampleRate: raw.sample_rate };
}

// channel === null stops the tone.
export async function setTestTone(channel: number | null, frequencyHz = 440): Promise<void> {
  await invoke<void>('audio_test_tone', {
    channel,
    frequencyHz,
  });
}

// --- sample voice (phase 1a) ---

export interface NativeSampleLoadInfo {
  path: string;
  channels: number;
  sampleRate: number;
  frames: number;
  durationSecs: number;
}

interface RawSampleLoadInfo {
  path: string;
  channels: number;
  sample_rate: number;
  frames: number;
  duration_secs: number;
}

function normalizeSampleLoad(r: RawSampleLoadInfo): NativeSampleLoadInfo {
  return {
    path: r.path,
    channels: r.channels,
    sampleRate: r.sample_rate,
    frames: r.frames,
    durationSecs: r.duration_secs,
  };
}

export async function loadSample(path: string): Promise<NativeSampleLoadInfo> {
  const raw = await invoke<RawSampleLoadInfo>('audio_load_sample', { path });
  return normalizeSampleLoad(raw);
}

// For samples that live behind a URL (bundled kits served by Vite) instead
// of a real filesystem path — fetch bytes JS-side, hand them to Rust to
// decode via hound's in-memory Cursor reader. Same registry key (`path`)
// as `loadSample`, so the matching `triggerSample(path, ...)` works after
// either load route. NOTE: this path is the slow one — JSON-array IPC
// encoding of the Uint8Array dominates cold-boot time. Prefer
// `loadBundledSample` for any path the Rust side can reach via its real
// filesystem location; keep this as the universal fallback.
export async function loadSampleFromBytes(
  path: string,
  bytes: Uint8Array,
): Promise<NativeSampleLoadInfo> {
  const raw = await invoke<RawSampleLoadInfo>('audio_load_sample_from_bytes', {
    path,
    bytes: Array.from(bytes),
  });
  return normalizeSampleLoad(raw);
}

// Fast path for bundled kits. The Vite URL (`/samples/drums/...`) is
// resolved Rust-side to a real filesystem path (source tree in dev,
// `resource_dir()/samples` in production) and `hound` opens it
// directly. No fetch, no IPC bytes, no in-memory decode. Registry key
// stays the URL so `triggerSample(url, ...)` lookups still match.
// Throws if the URL doesn't resolve to a bundled sample on disk —
// caller falls back to `loadSampleFromBytes` for non-bundled paths.
export async function loadBundledSample(
  path: string,
): Promise<NativeSampleLoadInfo> {
  const raw = await invoke<RawSampleLoadInfo>('audio_load_bundled_sample', {
    path,
  });
  return normalizeSampleLoad(raw);
}

export interface TriggerOpts {
    gain?: number;
    pan?: number;
    pitch?: number;
    // 0-indexed physical output channel. With outStereo=true this is L
    // and outFirst+1 is R; with outStereo=false the voice sums to this
    // single channel (pan ignored).
    outFirst?: number;
    outStereo?: boolean;
    // Optional track id — when provided, the voice attaches to the
    // track's filter params and gets per-track ladder filtering. Without
    // it the voice plays dry (manual triggers from the phase-0 panel).
    trackId?: string;
    // Seconds in the future to fire (relative to when the audio
    // callback drains this trigger). 0 = fire immediately at next
    // block boundary. The RELATIVE path — live monitoring uses it with
    // 0; scheduled playback should pass targetFrame instead.
    delaySecs?: number;
    // Absolute engine-clock frame to fire at (see engineClock.ts
    // frameAtTime). The jitter-free scheduling path: Rust compares the
    // deadline against its own sample counter, so fire time doesn't
    // depend on which audio block drains the IPC. Overrides delaySecs.
    targetFrame?: number;
    // Monophonic track flag — when true, on dispatch all OTHER active
    // voices sharing the same trackId get a ~20ms release ramp before
    // this trigger claims its slot. Matches the web bass/lead
    // workflow where a new note chokes the prior tail.
    monophonic?: boolean;
    // Manifest choke-group name (hats etc.). A trigger carrying one gives
    // every in-flight voice tagged with the same group a ~20ms release
    // ramp, ACROSS tracks — closed hat chokes open hat even though they
    // live on different tracks. Mirrors the web samplePlayer's manifest
    // chokeGroups. undefined/empty = no group.
    chokeGroup?: string;
    // Section tag for splits recording. 0/undefined = none (skipped
    // from splits), 1 = 'drum', 2 = 'melodic', 3 = 'click' (writes to
    // both rhythm + melody splits so count-in lands in either stem).
    section?: number;
    // Texture-role flag. When true, this voice fades out (rather than
    // hard-cutting) on transport stop — see fadeAndStop. Sustained
    // texture material rings down gracefully; everything else cuts.
    isTexture?: boolean;
    // Optional ADSR envelope (seconds). Pass all of attack / release /
    // hold to enable; native applies a per-sample envelope multiplier
    // and deactivates the voice once the release tail completes.
    // Skipping any of attack/release/hold leaves the voice on flat
    // gain (drums, leads without an envelope config).
    envelopeAttack?: number;
    envelopeDecay?: number;
    envelopeSustain?: number;
    envelopeRelease?: number;
    envelopeHold?: number;
    // Voice handle for targeted release. Only live-input monitoring sets it
    // (so the matching note-off can release this exact voice). 0/undefined
    // for every sequencer trigger.
    noteId?: number;
    // Per-instrument sample window + loop (editor A3). start/end are 0..1
    // fractions of the sample; loopMode is 0 off · 1 fwd · 2 bwd · 3 pingpong ·
    // 4 rev one-shot. Defaults (0 / 1 / 0) make the voice a full-length one-shot.
    start?: number;
    end?: number;
    loopMode?: number;
    // Per-instrument filter (editor B1). filterType 0 off · 1 lp · 2 hp · 3 bp;
    // cutoff/resonance normalized 0..1. Default (0) bypasses — distinct from
    // the per-track mixer filter.
    filterType?: number;
    cutoff?: number;
    resonance?: number;
    // Per-instrument saturation drive 0..1 (0/undefined = bypass). Applied
    // post-filter in the voice — same tanh family as the mangler pre-drive.
    satDrive?: number;
    // Per-instrument bit crush, integer 4..16 (16/undefined = bypass).
    // Applied after saturation: drive → crush.
    bitDepth?: number;
    // Per-instrument cutoff LFO (editor B2). lfoShape 0 revsaw · 1 saw · 2 tri
    // · 3 square · 4 random; rate in Hz (free-running); depth 0..1 bipolar.
    // depth 0 = off.
    lfoShape?: number;
    lfoRateHz?: number;
    lfoDepth?: number;
    // Generic modulator grid (editor B2 full grid): vol-LFO / pan-env / pan-LFO
    // / cutoff-env / pitch-env / pitch-LFO. Each carries a fixed slot role +
    // env-or-LFO params; the engine sums them onto the target. Omitted = none.
    mods?: Array<{
      slot: number;
      isLfo: boolean;
      depth: number;
      attack: number;
      decay: number;
      sustain: number;
      release: number;
      shape: number;
      rateHz: number;
    }>;
    // Per-instrument granular (editor Phase C). on=false → normal sample
    // playback (the single windowed read-head is bypassed). grainMs = grain
    // length; position 0..1 into the sample; shape 0 square · 1 tri · 2 gauss;
    // direction 0 fwd · 1 bwd · 2 pingpong.
    granular?: {
      on: boolean;
      grainMs: number;
      position: number;
      shape: number;
      direction: number;
      spray: number;
    };
}

// Flatten (path, opts) into the Rust TriggerSpec IPC shape — shared by
// the single-shot and batched dispatch below.
function buildTriggerSpec(path: string, opts: TriggerOpts): Record<string, unknown> {
  return {
    path,
    gain: opts.gain ?? null,
    pan: opts.pan ?? null,
    pitch: opts.pitch ?? null,
    outFirst: opts.outFirst ?? null,
    outStereo: opts.outStereo ?? null,
    trackId: opts.trackId ?? null,
    monophonic: opts.monophonic ?? null,
    chokeGroup: opts.chokeGroup ?? null,
    section: opts.section ?? null,
    isTexture: opts.isTexture ?? null,
    envelopeAttack: opts.envelopeAttack ?? null,
    envelopeDecay: opts.envelopeDecay ?? null,
    envelopeSustain: opts.envelopeSustain ?? null,
    envelopeRelease: opts.envelopeRelease ?? null,
    envelopeHold: opts.envelopeHold ?? null,
    delaySecs: opts.delaySecs ?? null,
    targetFrame: opts.targetFrame ?? null,
    noteId: opts.noteId ?? null,
    startFrac: opts.start ?? null,
    endFrac: opts.end ?? null,
    loopMode: opts.loopMode ?? null,
    instFilterType: opts.filterType ?? null,
    instCutoff: opts.cutoff ?? null,
    instResonance: opts.resonance ?? null,
    satDrive: opts.satDrive ?? null,
    bitDepth: opts.bitDepth ?? null,
    lfoShape: opts.lfoShape ?? null,
    lfoRateHz: opts.lfoRateHz ?? null,
    lfoDepth: opts.lfoDepth ?? null,
    mods: opts.mods && opts.mods.length > 0 ? opts.mods : null,
    granOn: opts.granular?.on ?? null,
    granGrainMs: opts.granular?.grainMs ?? null,
    granPosition: opts.granular?.position ?? null,
    granShape: opts.granular?.shape ?? null,
    granDir: opts.granular?.direction ?? null,
    granSpray: opts.granular?.spray ?? null,
  };
}

export async function triggerSample(
  path: string,
  opts: TriggerOpts = {},
): Promise<void> {
  await invoke<void>('audio_trigger_sample', {
    spec: buildTriggerSpec(path, opts),
  });
}

// Batched dispatch — a tick's simultaneous triggers (chord tones, arp
// spread) in one invoke instead of N JSON round-trips. Each entry still
// carries its own targetFrame, so batching changes IPC cost only, not
// timing.
export async function triggerBatch(
  items: Array<{ path: string; opts: TriggerOpts }>,
): Promise<void> {
  if (items.length === 0) return;
  await invoke<void>('audio_trigger_batch', {
    triggers: items.map((i) => buildTriggerSpec(i.path, i.opts)),
  });
}

// Release a single voice tagged with `noteId` (live-input monitoring
// note-off). Starts a soft release ramp; leaves every other voice — including
// the armed track's pattern voices on the same trackId — untouched. fadeSecs
// defaults to a short ramp Rust-side when omitted.
export async function releaseNote(noteId: number, fadeSecs?: number): Promise<void> {
  await invoke<void>('audio_release_note', {
    noteId,
    fadeSecs: fadeSecs ?? null,
  });
}

// Instrument-editor playhead. Tell the engine which preview voice (by
// noteId) to publish a read position for; pass 0 to stop publishing.
export async function setMonitorVoice(noteId: number): Promise<void> {
  await invoke<void>('audio_set_monitor_voice', { noteId });
}

// Normalized read position (0..1 over the whole sample) of the monitored
// voice, or a negative value when none is playing. Polled while previewing.
export async function getMonitorPlayhead(): Promise<number> {
  return invoke<number>('audio_monitor_playhead');
}

// Live re-pitch of a tagged, in-flight voice. `ratio` is the playback-rate
// multiplier (2^(semitones/12)) — the voice's pitch scales by it from its
// current read position, no retrigger. Used by the voicing macro to slide a
// held chord's tones to a new inversion/spread. No-op if the voice has ended.
export async function repitchNote(noteId: number, ratio: number): Promise<void> {
  await invoke<void>('audio_repitch_note', {
    noteId,
    ratio,
  });
}

// Batched track DSP updates — one IPC round-trip carrying many tracks.
// Used by App.tsx's RAF push to send raw store bases to Rust whenever
// they change. Phase 6 moved the LFO compute Rust-side, so this no
// longer carries modulated values — it's hand-edit / cold-start state.
export interface TrackFilterUpdate {
  trackId: string;
  cutoffNorm: number;
  resonance: number;
  fxSend: number;
  // Per-instrument reverb send (the active voice's reverbSend), 0..1.
  reverbSend: number;
  // Per-instrument delay send (the active voice's delaySend), 0..1.
  delaySend: number;
  // Active voice's static tune / finetune, normalized 0..1 — the LFO swing
  // center for the trackTune / trackFineTune destinations.
  tuneNorm: number;
  finetuneNorm: number;
}

export async function setTrackFiltersBulk(
  updates: TrackFilterUpdate[],
): Promise<void> {
  if (updates.length === 0) return;
  // Rust side expects snake_case keys; payload is the updates array
  // serialized via serde.
  await invoke<void>('audio_set_track_filters_bulk', {
    updates: updates.map((u) => ({
      track_id: u.trackId,
      cutoff_norm: u.cutoffNorm,
      resonance: u.resonance,
      fx_send: u.fxSend,
      reverb_send: u.reverbSend,
      delay_send: u.delaySend,
      tune_norm: u.tuneNorm,
      finetune_norm: u.finetuneNorm,
    })),
  });
}

// Phase 6 — push the full LFO panel state (rate / depth / destinations)
// to the audio thread. Called whenever `state.lfos` changes. Rust builds
// a snapshot, Arc-swaps it in, and the audio callback consumes it
// lock-free at the top of each block. Bases stay in their existing
// `set*Params` invokes — this command only governs modulation.
//
// Destinations: per-track {trackId} for `trackFilterCutoff` /
// `trackFilterResonance` / `trackFxSend`; trackId omitted for globals.
export type LfoDestKind =
  | 'trackFilterCutoff'
  | 'trackFilterResonance'
  | 'trackFxSend'
  | 'trackReverbSend'
  | 'trackDelaySend'
  | 'trackTune'
  | 'trackFineTune'
  | 'reverbSize'
  | 'reverbMix'
  | 'reverbDiffusion'
  | 'reverbDamping'
  | 'preSaturationDrive'
  | 'glitchMix'
  | 'tapePosition'
  | 'tapeLength'
  | 'tapeMix'
  | 'tapeGrainRate'
  | 'tapeGrainMix'
  | 'masterInput'
  | 'masterHiCut'
  | 'masterTrim'
  | 'masterComp'
  | 'masterDrive'
  | 'masterBias'
  | 'masterMix'
  | 'masterGateThreshold';

export interface NativeLfoDestination {
  knob: LfoDestKind;
  trackId?: string;
}

export interface NativeLfo {
  id: number;
  rate: number;
  depth: number;
  destinations: NativeLfoDestination[];
}

export async function setLfos(lfos: NativeLfo[]): Promise<void> {
  await invoke<void>('audio_set_lfos', { lfos });
}

// Global reverb params. `wetGain` is the post-reverb bus gain (0..1
// roughly, the user-facing "mix" knob remapped — the DSP's internal
// wet/dry crossfade is pinned to fully-wet on the Rust side, our
// per-voice fx_send is the parallel send into the wet bus). wetGain=0
// is the bypass — no separate flag.
export async function setReverbParams(opts: {
  size: number;
  wetGain: number;
  diffusion: number;
  damping: number;
}): Promise<void> {
  await invoke<void>('audio_set_reverb_params', {
    size: opts.size,
    wetGain: opts.wetGain,
    diffusion: opts.diffusion,
    damping: opts.damping,
  });
}

// Global ping-pong delay. `delaySeconds` is the tempo-synced time (computed
// JS-side from the note division + bpm); `feedback` 0..1.1 (engine clamps).
export async function setDelayParams(opts: {
  delaySeconds: number;
  feedback: number;
  pingpong: number;
  lofi: number;
}): Promise<void> {
  await invoke<void>('audio_set_delay_params', {
    delaySeconds: opts.delaySeconds,
    feedback: opts.feedback,
    pingpong: opts.pingpong,
    lofi: opts.lofi,
  });
}

// Pre-reverb saturation in the wet bus. preDrive 0..1 with quadratic
// scaling (web parity). Drive at 0 is a true no-op so no bypass arg.
export async function setSaturationParams(opts: {
  preDrive: number;
}): Promise<void> {
  await invoke<void>('audio_set_saturation_params', {
    preDrive: opts.preDrive,
  });
}

// Glitch stage in the FX bus (between tape and drive). `mix` is the
// wet level DURING a fire event (k-rate, 0..1). The chance dice live
// in JS — App.tsx subscribes to scheduler.onStep, rolls per beat, and
// calls `fireGlitch()` on hits. Outside fire events the stage is
// pass-through regardless of mix.
export async function setGlitchParams(opts: {
  mix: number;
}): Promise<void> {
  await invoke<void>('audio_set_glitch_params', {
    mix: opts.mix,
  });
}

// Fire the glitch stage. Pass an absolute engine-clock frame (see
// engineClock.ts frameAtTime) to align the stutter with the audible
// beat the scheduler targeted; omit to fire ASAP at the next block.
export async function fireGlitch(targetFrame?: number): Promise<void> {
  await invoke<void>('audio_glitch_fire', {
    targetFrame: targetFrame ?? null,
  });
}

// Master stage filters — phase 7e-1 covers the static character
// shaping (input gain → DC block → lo-cut → hi-cut → trim → tail EQ).
// `loCut` is an integer index 0..3 [Flat, 75Hz, 150Hz, 300Hz];
// `input`, `hiCut`, `trim` are 0..1 (mapped Rust-side to the matching
// curves in web `master.ts`). Compressor / distortion / gate land in
// later phases via their own IPCs.
export async function setMasterFilters(opts: {
  input: number;
  loCut: number;
  hiCut: number;
  trim: number;
}): Promise<void> {
  await invoke<void>('audio_set_master_filters', {
    input: opts.input,
    loCut: Math.round(opts.loCut),
    hiCut: opts.hiCut,
    trim: opts.trim,
  });
}

// Master compressor (phase 7e-2). `amount` 0..1 is the one-knob;
// `attackIdx` / `releaseIdx` are integer indices 0..5 into the static
// ms tables (matching `COMP_ATTACK_MS` / `COMP_RELEASE_MS` in
// `audio/master.ts`).
export async function setMasterComp(opts: {
  amount: number;
  attackIdx: number;
  releaseIdx: number;
}): Promise<void> {
  await invoke<void>('audio_set_master_comp', {
    amount: opts.amount,
    attackIdx: Math.round(opts.attackIdx),
    releaseIdx: Math.round(opts.releaseIdx),
  });
}

// Master distortion (phase 7e-3). `mode` is an integer 0..3
// (0=Boost, 1=Tube, 2=Fuzz, 3=Square). `drive` + `bias` + `mix` are
// 0..1 (bias is also clamped Rust-side to 0..0.2, matching the
// web range). Sits between comp and hi-cut in the master chain;
// dry/wet crossfade wraps the pre-emph → shaper → de-emph stage.
export async function setMasterDist(opts: {
  mode: number;
  drive: number;
  bias: number;
  mix: number;
}): Promise<void> {
  await invoke<void>('audio_set_master_dist', {
    mode: Math.round(opts.mode),
    drive: opts.drive,
    bias: opts.bias,
    mix: opts.mix,
  });
}

// Master gate (phase 7e-4). `enabled` toggles between passthrough and
// active gating; `threshold` is 0..1 mapped to -30..0 dB Rust-side.
// Threshold goes up to 0dB so the gate doubles as a chopper at high
// thresholds. Attack (1ms) / release (30ms) are baked in — web panel
// only exposes enabled + threshold.
export async function setMasterGate(opts: {
  enabled: boolean;
  threshold: number;
}): Promise<void> {
  await invoke<void>('audio_set_master_gate', {
    enabled: opts.enabled,
    threshold: opts.threshold,
  });
}

// Master full-unit bypass (phase 7e-5). Crossfades the master output
// toward the dry input over ~5ms. The internal chain (comp / dist /
// gate envelopes etc.) keeps running so toggling back finds its state
// intact.
export async function setMasterBypass(bypass: boolean): Promise<void> {
  await invoke<void>('audio_set_master_bypass', { bypass });
}

// Combined recording (phase 7f-1). Path is absolute filesystem path —
// caller builds it from the configured recordings dir + a timestamped
// filename. Rust opens the WAV (16-bit PCM, stereo, device sample
// rate), spawns a worker thread that drains a lock-free queue, and
// audio callback pushes interleaved samples each block.
export async function startRecordingCombined(path: string): Promise<void> {
  await invoke<void>('audio_start_recording_combined', { path });
}

// Sends StopCombinedRecording to the audio thread; worker drains the
// remaining queue and finalizes the WAV header on its own.
export async function stopRecordingCombined(): Promise<void> {
  await invoke<void>('audio_stop_recording_combined');
}

// Full-stems recording. One sample-locked take → master (post-master mix),
// fx (mangler bus), reverb + delay (wet returns), and one dry WAV per track.
// All files land in `stemDir`. `trackIds` / `trackPaths` are parallel arrays
// (index i = the i-th track, capped at 16 in Rust); the id assigns the track
// its stem slot so its dry signal routes to `trackPaths[i]`. Σ(track stems) +
// fx + reverb + delay reconstructs the pre-master mix.
export async function startRecordingStems(opts: {
  stemDir: string;
  masterPath: string;
  fxPath: string;
  reverbPath: string;
  delayPath: string;
  trackIds: string[];
  trackPaths: string[];
}): Promise<void> {
  await invoke<void>('audio_start_recording_stems', {
    stemDir: opts.stemDir,
    masterPath: opts.masterPath,
    fxPath: opts.fxPath,
    reverbPath: opts.reverbPath,
    delayPath: opts.delayPath,
    trackIds: opts.trackIds,
    trackPaths: opts.trackPaths,
  });
}

export async function stopRecordingStems(): Promise<void> {
  await invoke<void>('audio_stop_recording_stems');
}

// Tape (full bed + grains). `stretch1`/`stretch2` are actual playback
// rates (0.25..4, 1.0 = live pitch) — the store's 0..1 knobs are
// mapped to that range JS-side via the web's `stretchToRate` formula.
// `mix` is the wet/dry crossfade within the FX bus stage. `reverse`
// flips per-sample advance; `hold` freezes the write head so reads
// keep playing the captured material. `grainRate` is 0..1 → 0..16
// events/sec on the spawner; `grainMix` is 0..1 (capped internally
// at TAPE_GRAIN_MIX_MAX so the grain layer can't clip the bed).
export async function setTapeParams(opts: {
  position: number;
  length: number;
  stretch1: number;
  gain1: number;
  stretch2: number;
  gain2: number;
  mix: number;
  reverse: boolean;
  hold: boolean;
  grainRate: number;
  grainMix: number;
}): Promise<void> {
  await invoke<void>('audio_set_tape_params', {
    position: opts.position,
    length: opts.length,
    stretch1: opts.stretch1,
    gain1: opts.gain1,
    stretch2: opts.stretch2,
    gain2: opts.gain2,
    mix: opts.mix,
    reverse: opts.reverse,
    hold: opts.hold,
    grainRate: opts.grainRate,
    grainMix: opts.grainMix,
  });
}

// Mix routing — multi-out mode, FX bus output channels, FX chain
// bypass. See store.ts NativeMix for the semantics.
export async function setMixRouting(opts: {
  multiOut: boolean;
  fxOutFirst: number;
  fxOutStereo: boolean;
  fxBypass: boolean;
}): Promise<void> {
  await invoke<void>('audio_set_mix_routing', {
    multiOut: opts.multiOut,
    fxOutFirst: opts.fxOutFirst,
    fxOutStereo: opts.fxOutStereo,
    fxBypass: opts.fxBypass,
  });
}

// Cutoff mapping — tight log range from 50 Hz (very dark) to 18 kHz
// (effectively open). Defaults stay transparent so a fresh track sounds
// the same as no filter.
export const CUTOFF_MIN_HZ = 50;
export const CUTOFF_MAX_HZ = 18000;
const CUTOFF_RATIO = CUTOFF_MAX_HZ / CUTOFF_MIN_HZ;
export function cutoffNormToHz(norm: number): number {
  const clamped = Math.max(0, Math.min(1, norm));
  return CUTOFF_MIN_HZ * Math.pow(CUTOFF_RATIO, clamped);
}

// Hard panic: stop every voice AND clear the reverb + delay buffers so a
// runaway / self-oscillating FX tail is silenced instantly (StopAll alone
// leaves the feedback loops ringing).
export async function audioPanic(): Promise<void> {
  await invoke<void>('audio_panic');
}

// Transport-stop texture fade. Rings down texture-role voices over
// `fadeSecs` while every other voice keeps playing untouched.
export async function fadeTextures(fadeSecs: number): Promise<void> {
  await invoke<void>('audio_fade_textures', { fadeSecs });
}

// Perform punch edges — drop queued-but-unfired triggers whose absolute
// deadline is at or past `minFrame` so the dispatcher can re-emit the
// scheduling horizon under the new perform state. Sounding voices are
// untouched. See MixerCommand::FlushPending.
export async function flushPendingTriggers(minFrame: number): Promise<void> {
  await invoke<void>('audio_flush_pending', { minFrame });
}

// Loop/resample capture unit — copy an absolute engine-frame span (in the
// PAST — retroactive capture) out of the post-master ring and loop it
// bar-phase-locked. See src/audio/loops.ts for the bar math.
export async function loopCaptureSpan(
  startFrame: number,
  endFrame: number,
): Promise<void> {
  await invoke<void>('audio_loop_capture', { startFrame, endFrame });
}

export async function loopStopNative(): Promise<void> {
  await invoke<void>('audio_loop_stop');
}

// Save-to-library bounce: `frames` stereo frames of the loop unit's output
// to `path`, starting at the next bar-grid point. Finalize arrives via the
// `recorder:finalized` event with label "loop".
export async function loopBounceNative(
  path: string,
  frames: number,
  alignFrames: number,
): Promise<void> {
  await invoke<void>('audio_loop_bounce', { path, frames, alignFrames });
}

export async function loopGainNative(gain: number): Promise<void> {
  await invoke<void>('audio_loop_gain', { gain });
}

// P2 manipulation params — speed (thru-zero, octave-ladder values), size
// (grain size norm, 1 = tape mode), scan/spray (0..1), grains (1..8),
// rateHz (grain spawn rate 0.5..60).
export async function loopParamsNative(params: {
  speed: number;
  pitch: number;
  loopLock: boolean;
  loopLevel: number;
  grainLevel: number;
  size: number;
  random: number;
  grains: number;
  spawnFrames: number;
  rateSynced: boolean;
  sizeDev: number;
  pitchDev: number;
  rateDev: number;
}): Promise<void> {
  await invoke<void>('audio_loop_params', params);
}

export interface NativeLoopViz {
  version: number;
  pos: number; // 0..1 playhead fraction; negative = unit inactive
  bounce: number; // save progress 0..1; negative = no save in flight
  grains: number[]; // 8 × (position fraction, window level); pos -1 = idle
}

export async function loopViz(): Promise<NativeLoopViz> {
  return await invoke<NativeLoopViz>('audio_loop_viz');
}

// 512 columns × interleaved min/max of the captured loop.
export async function loopPeaks(): Promise<number[]> {
  return await invoke<number[]>('audio_loop_peaks');
}

// Freeze in-flight voice DSP params (filter cutoff/resonance + fx send)
// on a scene/bank/song swap, so ringing tails keep the OUTGOING scene's
// settings instead of jumping to the incoming scene's (a resonance jump
// would self-oscillate into a crash). New triggers are unaffected.
export async function freezeVoiceParams(): Promise<void> {
  await invoke<void>('audio_freeze_voice_params');
}

// --- reported channel count (for UI routing pickers) ---
//
// NativeAudioPanel updates this whenever it opens/closes the device or
// runs a status refresh; consumers (per-track output picker) subscribe.
// Tiny external-store so the Track row dropdown can render options for
// the actual hardware channel count without each Track polling on its
// own. Zero when no device is open.

let _reportedChannels = 0;
const channelListeners = new Set<() => void>();

export function setReportedChannelCount(n: number): void {
  if (n === _reportedChannels) return;
  _reportedChannels = n;
  for (const cb of channelListeners) cb();
}

export function getReportedChannelCount(): number {
  return _reportedChannels;
}

export function subscribeReportedChannelCount(cb: () => void): () => void {
  channelListeners.add(cb);
  return () => {
    channelListeners.delete(cb);
  };
}
