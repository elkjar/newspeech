let ctx: AudioContext | null = null;
let masterBus: GainNode | null = null;
let voicesBus: GainNode | null = null;
let voicesPostFX: GainNode | null = null;
let dryGain: GainNode | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  return ctx;
}

// Final bus to destination. Stage 2 + Stage 3 FX inserts will eventually live
// between the voices/wet mix and destination on this node.
export function getMasterBus(): GainNode {
  if (!masterBus) {
    const c = getAudioContext();
    masterBus = c.createGain();
    masterBus.gain.value = 1;
    masterBus.connect(c.destination);
  }
  return masterBus;
}

// Dry-path attenuator between voicesBus and masterBus. Tape's mix knob
// crossfades this against the wet (tape) gain — at mix=1 we hear only the bed.
export function getDryGain(): GainNode {
  if (!dryGain) {
    const c = getAudioContext();
    dryGain = c.createGain();
    dryGain.gain.value = 1;
    dryGain.connect(getMasterBus());
  }
  return dryGain;
}

// Voices/synth output collector. Routes through voicesPostFX (pre-saturation
// insertion point) into dryGain. Voices CONNECT TO this bus.
export function getVoicesBus(): GainNode {
  if (!voicesBus) {
    const c = getAudioContext();
    voicesBus = c.createGain();
    voicesBus.gain.value = 1;
    voicesBus.connect(getVoicesPostFX());
  }
  return voicesBus;
}

// Tap point AFTER pre-saturation. Initially a passthrough joining voicesBus
// to dryGain; pre-saturation inserts itself between voicesBus and this node
// when initialized. Stage 1 (tape) taps HERE so its captured material is
// already saturated when pre-drive is up — "before tape" semantically.
export function getVoicesPostFX(): GainNode {
  if (!voicesPostFX) {
    const c = getAudioContext();
    voicesPostFX = c.createGain();
    voicesPostFX.gain.value = 1;
    voicesPostFX.connect(getDryGain());
  }
  return voicesPostFX;
}

export async function ensureAudioRunning(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state === 'suspended') {
    await c.resume();
  }
  return c;
}
