let ctx: AudioContext | null = null;
let fxBus: GainNode | null = null;
let mixBus: GainNode | null = null;
let voicesBus: GainNode | null = null;
let voicesPostFX: GainNode | null = null;
let dryGain: GainNode | null = null;
let outputRouter: GainNode | null = null;
let destGain: GainNode | null = null;
let routingStreamDest: MediaStreamAudioDestinationNode | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  return ctx;
}

// Final fan-out before destination. Everything that USED to connect to
// ctx.destination now connects here. It fans the signal into:
//   • destGain → ctx.destination (the speaker path; gain crossfaded
//     to mute when an alternate sink is active)
//   • routingStreamDest (a MediaStreamDestination; an offscreen <audio>
//     element pipes it to a specific device via setSinkId for output-
//     routing without WebKit's AudioContext.setSinkId)
// Always live in both directions; audioOutput.ts toggles destGain only.
export function getOutputRouter(): GainNode {
  if (!outputRouter) {
    const c = getAudioContext();
    outputRouter = c.createGain();
    outputRouter.gain.value = 1;

    destGain = c.createGain();
    destGain.gain.value = 1;
    outputRouter.connect(destGain);
    destGain.connect(c.destination);

    routingStreamDest = c.createMediaStreamDestination();
    outputRouter.connect(routingStreamDest);
  }
  return outputRouter;
}

export function setOutputDestinationMute(muted: boolean): void {
  // Force-init the chain on first call.
  getOutputRouter();
  if (destGain) destGain.gain.value = muted ? 0 : 1;
}

export function getRoutingStream(): MediaStream {
  getOutputRouter();
  return routingStreamDest!.stream;
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
    mixBus.connect(getOutputRouter());
  }
  return mixBus;
}

// Tap point AFTER the output router — primarily for the recorder's
// processed-master tap. Currently identical to the router itself; declared
// here to keep recorder code agnostic about routing topology.
// (Reserved for future use; current code taps master.outNode directly.)

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

// Three parallel passive buses tracking recorder taps, all pre-trackfilter /
// pre-FX / pre-master. samplesBus is the full sample sum (rhythm + melody);
// rhythmBus and melodyBus are the per-section feeds that drive splits output.
// rhythm/melody both connect into samples so a single connect at the trigger
// site populates both the section bus and the combined sum.
//
// trackBuses are per-track recording taps for multitrack mode, keyed by
// Track.id and lazily created when samplePlayer.trigger first runs for that
// trackId. They live alongside (not in series with) the section buses — each
// per-trigger busHead fans into both the section bus AND its trackBus, so
// splits + multitrack recording paths stay independent.
//
// clickBus carries count-in clicks. Routed so clicks land in EVERY captured
// path: into mixBus for audible playback / master-tap recording, into
// samplesBus for raw single-WAV recording, and directly into the splits
// worklets (wired in recorder.ts) for splits WAVs. The dedicated bus avoids
// the "click appears 2x in samples" problem that would happen if clicks
// connected to both rhythmBus and melodyBus (both feed samples).
let samplesBus: GainNode | null = null;
let rhythmBus: GainNode | null = null;
let melodyBus: GainNode | null = null;
let clickBus: GainNode | null = null;
const trackBuses = new Map<string, GainNode>();

export function getSamplesBus(): GainNode {
  if (!samplesBus) {
    const c = getAudioContext();
    samplesBus = c.createGain();
    samplesBus.gain.value = 1;
  }
  return samplesBus;
}

export function getRhythmBus(): GainNode {
  if (!rhythmBus) {
    const c = getAudioContext();
    rhythmBus = c.createGain();
    rhythmBus.gain.value = 1;
    rhythmBus.connect(getSamplesBus());
  }
  return rhythmBus;
}

export function getMelodyBus(): GainNode {
  if (!melodyBus) {
    const c = getAudioContext();
    melodyBus = c.createGain();
    melodyBus.gain.value = 1;
    melodyBus.connect(getSamplesBus());
  }
  return melodyBus;
}

export function getTrackBus(trackId: string): GainNode {
  let bus = trackBuses.get(trackId);
  if (!bus) {
    const c = getAudioContext();
    bus = c.createGain();
    bus.gain.value = 1;
    trackBuses.set(trackId, bus);
  }
  return bus;
}

export function getActiveTrackBusIds(): string[] {
  return Array.from(trackBuses.keys());
}

export function getClickBus(): GainNode {
  if (!clickBus) {
    const c = getAudioContext();
    clickBus = c.createGain();
    clickBus.gain.value = 1;
    clickBus.connect(getMixBus());
    clickBus.connect(getSamplesBus());
  }
  return clickBus;
}

export async function ensureAudioRunning(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state === 'suspended') {
    await c.resume();
  }
  return c;
}
