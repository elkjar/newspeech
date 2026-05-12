let ctx: AudioContext | null = null;
let fxBus: GainNode | null = null;
let mixBus: GainNode | null = null;
let voicesBus: GainNode | null = null;
let voicesPostFX: GainNode | null = null;
let dryGain: GainNode | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  return ctx;
}

// Final summing bus, immediately before the master stage. Everything that
// reaches destination flows through here:
//   • FX chain output (glitch → reverb → mixBus)
//   • Per-track dry legs (fxSend < 1 portion → mixBus)
// The master stage, once initialized, inserts itself between mixBus and
// destination. Until then, mixBus → destination directly.
export function getMixBus(): GainNode {
  if (!mixBus) {
    const c = getAudioContext();
    mixBus = c.createGain();
    mixBus.gain.value = 1;
    mixBus.connect(c.destination);
  }
  return mixBus;
}

// FX-chain entry bus. Voices + tape sum here; glitch / reverb insert between
// this and mixBus on init. NOT the final output — that's mixBus → master →
// destination.
export function getFxBus(): GainNode {
  if (!fxBus) {
    const c = getAudioContext();
    fxBus = c.createGain();
    fxBus.gain.value = 1;
    fxBus.connect(getMixBus());
  }
  return fxBus;
}

// Dry-path attenuator between voicesBus and fxBus. Tape's mix knob
// crossfades this against the wet (tape) gain — at mix=1 we hear only the bed.
export function getDryGain(): GainNode {
  if (!dryGain) {
    const c = getAudioContext();
    dryGain = c.createGain();
    dryGain.gain.value = 1;
    dryGain.connect(getFxBus());
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
