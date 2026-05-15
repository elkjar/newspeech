// Output-device picker via HTMLMediaElement.setSinkId (Safari 17+, WKWebView
// Tahoe, Chromium 110+). AudioContext.setSinkId is the cleaner API but it's
// not exposed in WKWebView yet, so we route the audio graph into a
// MediaStreamDestination and pipe it through a hidden <audio> element that
// owns the setSinkId call. Speaker path stays alive too — destGain (in
// audioContext.ts) is muted whenever a custom device is active, so the user
// hears the chosen device only.
//
// Persisted to localStorage. Restored on next boot, but `audio.play()`
// usually requires a user gesture; first real playback (transport play)
// kicks the element into life automatically.

import { getAudioContext, getRoutingStream, setOutputDestinationMute } from './audioContext';

const LS_DEVICE_ID = 'newspeech.sequencer.audioOutDeviceId';

export interface AudioOutputInfo {
  deviceId: string;
  label: string;
}

type HTMLAudioWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

let outputs: AudioOutputInfo[] = [];
let activeId: string | null =
  typeof localStorage !== 'undefined' ? localStorage.getItem(LS_DEVICE_ID) : null;
let initialized = false;
let routingAudio: HTMLAudioWithSink | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

export function getAudioOutputs(): AudioOutputInfo[] {
  return outputs.slice();
}

export function getActiveAudioOutputId(): string | null {
  return activeId;
}

export function onAudioOutputsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function isSetSinkIdSupported(): boolean {
  if (typeof HTMLMediaElement === 'undefined') return false;
  return typeof (HTMLMediaElement.prototype as HTMLAudioWithSink).setSinkId === 'function';
}

function ensureRoutingAudio(): HTMLAudioWithSink {
  if (!routingAudio) {
    // Force the audio context (+ output router + stream) to exist before we
    // bind srcObject. Without this the stream destination wouldn't be wired.
    getAudioContext();
    const el = document.createElement('audio') as HTMLAudioWithSink;
    el.autoplay = false;
    el.muted = true; // Default off; flipped on when custom device selected.
    el.style.display = 'none';
    document.body.appendChild(el);
    el.srcObject = getRoutingStream();
    routingAudio = el;
  }
  return routingAudio;
}

async function refreshOutputs(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    outputs = devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || (d.deviceId === 'default' ? 'default' : `output ${i + 1}`),
      }));
    notify();
  } catch (err) {
    console.warn('[audioOut] enumerate failed:', err);
  }
}

export async function initAudioOutputs(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await refreshOutputs();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    void refreshOutputs();
  });
  if (activeId) {
    // Attempt restore. Will fail silently if autoplay policy blocks; user
    // gesture (clicking play in the transport) wakes it up.
    try {
      await applyDeviceId(activeId);
    } catch (err) {
      console.warn('[audioOut] restore deviceId failed:', err);
    }
  }
}

async function applyDeviceId(deviceId: string): Promise<void> {
  if (!deviceId) {
    // Default routing: speakers via destGain, audio element silent.
    setOutputDestinationMute(false);
    if (routingAudio) {
      routingAudio.muted = true;
      try {
        routingAudio.pause();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const audio = ensureRoutingAudio();
  if (typeof audio.setSinkId !== 'function') {
    throw new Error('setSinkId not supported on HTMLAudioElement');
  }
  await audio.setSinkId(deviceId);
  audio.muted = false;
  setOutputDestinationMute(true);
  // play() may reject under autoplay policy if no user gesture has fired
  // yet. Swallow — first real transport play will resume.
  audio.play().catch(() => {
    /* awaiting user gesture */
  });
}

export async function setActiveAudioOutput(deviceId: string): Promise<void> {
  await applyDeviceId(deviceId);
  activeId = deviceId || null;
  if (typeof localStorage !== 'undefined') {
    if (deviceId) localStorage.setItem(LS_DEVICE_ID, deviceId);
    else localStorage.removeItem(LS_DEVICE_ID);
  }
  notify();
}

export async function requestDeviceLabels(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await refreshOutputs();
    return true;
  } catch {
    return false;
  }
}
