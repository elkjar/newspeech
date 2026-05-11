// MIDI mapping target enum + dispatcher. Routes incoming MIDI messages
// to store actions via a prefix-based dispatch.

import { useSequencerStore } from '../state/store';
import { togglePlayback, tapTempo } from '../audio/transport';
import type { MidiMessage } from './midiIn';

// Track knob targets carry a positional index (0..15) into `tracks[]`,
// not a track id, so bindings survive across `.seq` files as long as
// the slot at that position has a similar role.
export type TrackKnobTargetName = 'mutation' | 'morph' | 'rowRatchet' | 'fxSend';
export type FxKnobTargetName =
  | 'tape.position'
  | 'tape.length'
  | 'tape.mix'
  | 'tape.grainRate'
  | 'tape.grainMix'
  | 'glitch.chance'
  | 'glitch.mix'
  | 'reverb.size'
  | 'reverb.mix'
  | 'saturation.preDrive'
  | 'saturation.postDrive';

export type MidiTarget =
  | `macro:${'density' | 'chaos' | 'motion' | 'drift' | 'tension'}`
  | `bank:queue:${number}`
  | `track:${number}:${TrackKnobTargetName}`
  | `fx:${FxKnobTargetName}`
  | 'transport:play'
  | 'transport:freeze'
  | 'transport:tap-tempo';

export interface MidiBinding {
  ch: number;
  msg: 'cc' | 'note';
  num: number;
  target: MidiTarget;
}

export const FX_KNOB_TARGETS: FxKnobTargetName[] = [
  'tape.position',
  'tape.length',
  'tape.mix',
  'tape.grainRate',
  'tape.grainMix',
  'glitch.chance',
  'glitch.mix',
  'reverb.size',
  'reverb.mix',
  'saturation.preDrive',
  'saturation.postDrive',
];

export const TRACK_KNOB_TARGETS: TrackKnobTargetName[] = [
  'mutation',
  'morph',
  'rowRatchet',
  'fxSend',
];

// learnHook is set by the mapping store at boot. Bridges the
// dispatcher to learn-mode state without forming a circular import.
let learnHook: ((msg: MidiMessage) => boolean) | null = null;

export function setLearnHook(hook: (msg: MidiMessage) => boolean): void {
  learnHook = hook;
}

let activeBindings: MidiBinding[] = [];

export function setActiveBindings(bindings: MidiBinding[]): void {
  activeBindings = bindings;
}

export function getActiveBindings(): MidiBinding[] {
  return activeBindings;
}

function dispatchTarget(target: string, value01: number): void {
  const s = useSequencerStore.getState();

  if (target.startsWith('macro:')) {
    const name = target.slice('macro:'.length);
    switch (name) {
      case 'density':
        s.setDensity(value01);
        return;
      case 'chaos':
        s.setChaos(value01);
        return;
      case 'motion':
        s.setMotion(value01);
        return;
      case 'drift':
        s.setDrift(value01);
        return;
      case 'tension':
        s.setTension(value01);
        return;
      default:
        return;
    }
  }

  if (target.startsWith('bank:queue:')) {
    const i = Number(target.slice('bank:queue:'.length));
    if (!Number.isFinite(i)) return;
    s.queueBank(i);
    return;
  }

  if (target.startsWith('track:')) {
    const rest = target.slice('track:'.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return;
    const idx = Number(rest.slice(0, sep));
    const knob = rest.slice(sep + 1);
    if (!Number.isFinite(idx)) return;
    const track = s.tracks[idx];
    if (!track) return;
    switch (knob) {
      case 'mutation':
        s.setTrackMutation(track.id, value01);
        return;
      case 'morph':
        s.setTrackMorph(track.id, value01);
        return;
      case 'rowRatchet':
        s.setTrackRowRatchet(track.id, value01);
        return;
      case 'fxSend':
        s.setTrackFxSend(track.id, value01);
        return;
      default:
        return;
    }
  }

  if (target.startsWith('fx:')) {
    const name = target.slice('fx:'.length);
    switch (name) {
      case 'tape.position':
        s.setTape({ position: value01 });
        return;
      case 'tape.length':
        s.setTape({ length: value01 });
        return;
      case 'tape.mix':
        s.setTape({ mix: value01 });
        return;
      case 'tape.grainRate':
        s.setTape({ grainRate: value01 });
        return;
      case 'tape.grainMix':
        s.setTape({ grainMix: value01 });
        return;
      case 'glitch.chance':
        s.setGlitch({ chance: value01 });
        return;
      case 'glitch.mix':
        s.setGlitch({ mix: value01 });
        return;
      case 'reverb.size':
        s.setReverb({ size: value01 });
        return;
      case 'reverb.mix':
        s.setReverb({ mix: value01 });
        return;
      case 'saturation.preDrive':
        s.setSaturation({ preDrive: value01 });
        return;
      case 'saturation.postDrive':
        s.setSaturation({ postDrive: value01 });
        return;
      default:
        return;
    }
  }

  if (target === 'transport:play') {
    void togglePlayback();
    return;
  }
  if (target === 'transport:freeze') {
    s.toggleFreeze();
    return;
  }
  if (target === 'transport:tap-tempo') {
    tapTempo();
    return;
  }
}

// True iff a string is a recognised target shape (used for validation
// and the round-trip-unknown-targets policy).
export function isValidTarget(t: string): boolean {
  if (
    t === 'transport:play' ||
    t === 'transport:freeze' ||
    t === 'transport:tap-tempo'
  ) {
    return true;
  }
  if (t.startsWith('macro:')) {
    return ['density', 'chaos', 'motion', 'drift', 'tension'].includes(
      t.slice('macro:'.length)
    );
  }
  if (t.startsWith('bank:queue:')) {
    const i = Number(t.slice('bank:queue:'.length));
    return Number.isFinite(i) && i >= 0 && i < 16;
  }
  if (t.startsWith('track:')) {
    const rest = t.slice('track:'.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return false;
    const idx = Number(rest.slice(0, sep));
    const knob = rest.slice(sep + 1);
    return (
      Number.isFinite(idx) &&
      idx >= 0 &&
      (TRACK_KNOB_TARGETS as string[]).includes(knob)
    );
  }
  if (t.startsWith('fx:')) {
    return (FX_KNOB_TARGETS as string[]).includes(t.slice('fx:'.length));
  }
  return false;
}

export function dispatchMidi(msg: MidiMessage): void {
  // Learn mode: if the hook consumed the message (target was pinned),
  // skip normal dispatch so the twist binds without also moving the
  // bound parameter.
  if (learnHook && learnHook(msg)) return;
  const b = activeBindings.find(
    (x) => x.ch === msg.ch && x.msg === msg.msg && x.num === msg.num
  );
  if (!b) return;
  const value01 = msg.msg === 'cc' ? msg.value / 127 : 1;
  dispatchTarget(b.target, value01);
}
