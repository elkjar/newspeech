// Native audio engine bridge — Tauri-only.
//
// Phase 0 surface: device enumeration, open/close, per-channel test tone.
// Sample voices, synths, FX, and the scheduler land in later phases; this
// file grows alongside the Rust audio module. The Web Audio engine
// (audioContext.ts and friends) remains the entirety of the web build —
// nothing here touches it.

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

export function isNativeAudioAvailable(): boolean {
  return isTauri();
}

export async function listOutputDevices(): Promise<NativeDeviceInfo[]> {
  const raw = await invoke<RawDeviceInfo[]>('audio_list_output_devices');
  return raw.map(normalizeDevice);
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

export async function closeOutputDevice(): Promise<void> {
  await invoke<void>('audio_close_device');
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

export async function triggerSample(
  path: string,
  opts: {
    gain?: number;
    pan?: number;
    pitch?: number;
    // 0-indexed physical output channel. With outStereo=true this is L
    // and outFirst+1 is R; with outStereo=false the voice sums to this
    // single channel (pan ignored).
    outFirst?: number;
    outStereo?: boolean;
  } = {},
): Promise<void> {
  await invoke<void>('audio_trigger_sample', {
    path,
    gain: opts.gain ?? null,
    pan: opts.pan ?? null,
    pitch: opts.pitch ?? null,
    outFirst: opts.outFirst ?? null,
    outStereo: opts.outStereo ?? null,
  });
}

export async function stopAllVoices(): Promise<void> {
  await invoke<void>('audio_stop_all');
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
