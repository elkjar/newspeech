// MIDI mapping target enum + dispatcher. Routes incoming MIDI messages
// to store actions via a prefix-based dispatch.

import { useSequencerStore, type Track } from '../state/store';
import { togglePlayback, tapTempo } from '../audio/transport';
import type { MidiMessage } from './midiIn';
import { tryRecordNote, tryRecordNoteOff } from './recordInput';

type StoreState = ReturnType<typeof useSequencerStore.getState>;

// Resolve a `track:N:knob` or `track:view:N:knob` target to its track + knob.
// View-relative targets pick the Nth track of the currently-viewed section
// (drum vs melodic), resolved live so the control follows the on-screen page.
function resolveTrackTarget(
  s: StoreState,
  target: string
): { track: Track; knob: string } | null {
  if (!target.startsWith('track:')) return null;
  const rest = target.slice('track:'.length);
  if (rest.startsWith('view:')) {
    const r2 = rest.slice('view:'.length);
    const sep = r2.indexOf(':');
    if (sep < 0) return null;
    const pos = Number(r2.slice(0, sep));
    if (!Number.isFinite(pos)) return null;
    const knob = r2.slice(sep + 1);
    const track = s.tracks.filter((t) => t.section === s.viewSection)[pos];
    return track ? { track, knob } : null;
  }
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  const idx = Number(rest.slice(0, sep));
  if (!Number.isFinite(idx)) return null;
  const knob = rest.slice(sep + 1);
  const track = s.tracks[idx];
  return track ? { track, knob } : null;
}

// Continuous per-track knobs (everything except the mute/solo button toggles).
const TRACK_CONTINUOUS = new Set([
  'mutation',
  'rowRatchet',
  'fxSend',
  'pan',
  'gain',
  'filterCutoff',
  'filterResonance',
]);

// Current value of a continuous track knob, normalized to 0..1 to match an
// incoming CC value. gain stores 0..2 (unity at dial center) so halve it.
function trackParam01(track: Track, knob: string): number {
  switch (knob) {
    case 'gain':
      return Math.min(1, track.gain / 2);
    case 'mutation':
      return track.mutation;
    case 'rowRatchet':
      return track.rowRatchet;
    case 'fxSend':
      return track.fxSend;
    case 'pan':
      return track.pan;
    case 'filterCutoff':
      return track.filterCutoff;
    case 'filterResonance':
      return track.filterResonance;
    default:
      return 0;
  }
}

// Soft-takeover (pickup) for view-relative continuous controls. The XL3
// encoders/faders are absolute (Components exposes no relative mode), and a
// view-relative target re-points to a different track when the rhythm/melody
// page flips — so the control's physical position won't match the newly
// addressed track's value. We hold the binding disengaged until the control
// passes THROUGH the current value, then latch on and track from there, so a
// page flip never yanks the parameter. Keyed by physical control; re-arms when
// the resolved track changes. Scoped to `track:view:` so existing absolute
// learn-mappings keep their direct-set behavior.
const EPS = 0.5 / 127;
const pickup = new Map<string, { trackId: string; engaged: boolean; lastIn: number }>();

function pickupAllows(key: string, trackId: string, current01: number, incoming01: number): boolean {
  let st = pickup.get(key);
  if (!st || st.trackId !== trackId) {
    // First sight / page flip → re-arm. Engage immediately if already at the
    // value, else wait for a crossing move.
    const engaged = Math.abs(incoming01 - current01) <= EPS;
    pickup.set(key, { trackId, engaged, lastIn: incoming01 });
    return engaged;
  }
  if (st.engaged) {
    st.lastIn = incoming01;
    return true;
  }
  const crossed =
    Math.abs(incoming01 - current01) <= EPS ||
    (st.lastIn < current01 && incoming01 >= current01) ||
    (st.lastIn > current01 && incoming01 <= current01);
  st.lastIn = incoming01;
  if (crossed) st.engaged = true;
  return crossed;
}

// Relative-emulation state. The XL3 encoders send absolute 0..127 only (no
// true relative — confirmed; it's a known hardware limitation). We convert to
// deltas in software: remember each control's last absolute value and apply
// (now - last) to the target's current value. Result: turning nudges from
// wherever the parameter currently is, so a page flip never jumps. Caveat —
// absolute endless encoders clamp at 0/127, so one parked at an extreme can't
// nudge further that way until turned back; REL_SENS is high enough that from
// a mid position a fraction of a turn covers the full range, keeping clamps
// out of the way in normal use.
const REL_SENS = 1 / 40;
const relLast = new Map<string, number>();

// Current 0..1 value of any relative-able target (macros, master fx knobs,
// per-track continuous knobs). Returns null for targets we can't read.
function currentValue01(s: StoreState, target: string): number | null {
  if (target.startsWith('macro:')) {
    switch (target.slice('macro:'.length)) {
      case 'density':
        return s.density;
      case 'chaos':
        return s.chaos;
      case 'motion':
        return s.motion;
      case 'drift':
        return s.drift;
      case 'tension':
        return s.tension;
      default:
        return null;
    }
  }
  if (target === 'fx:master.input') return s.master.input;
  if (target === 'fx:master.drive') return s.master.drive;
  if (target === 'fx:master.mix') return s.master.mix;
  const tt = resolveTrackTarget(s, target);
  if (tt && TRACK_CONTINUOUS.has(tt.knob)) return trackParam01(tt.track, tt.knob);
  return null;
}

// Track knob targets carry a positional index (0..15) into `tracks[]`,
// not a track id, so bindings survive across `.seq` files as long as
// the slot at that position has a similar role.
export type TrackKnobTargetName =
  | 'mutation'
  | 'rowRatchet'
  | 'fxSend'
  | 'pan'
  | 'gain'
  | 'filterCutoff'
  | 'filterResonance'
  // mute/solo are booleans driven by a latching toggle button: the control
  // sends 127 (latched) / 0 (unlatched) and we direct-set the flag from the
  // value, so the controller's own latch state is the source of truth. (If a
  // button is ever configured momentary instead, this would need to become a
  // toggle-on-press — see dispatch.)
  | 'mute'
  | 'solo';
export type FxKnobTargetName =
  | 'tape.position'
  | 'tape.length'
  | 'tape.mix'
  | 'tape.grainRate'
  | 'tape.grainMix'
  | 'tape.hold'
  | 'glitch.chance'
  | 'glitch.mix'
  | 'reverb.size'
  | 'reverb.mix'
  | 'reverb.diffusion'
  | 'reverb.damping'
  | 'saturation.preDrive'
  | 'master.input'
  | 'master.loCut'
  | 'master.comp'
  | 'master.compAttack'
  | 'master.compRelease'
  | 'master.mode'
  | 'master.drive'
  | 'master.bias'
  | 'master.mix'
  | 'master.hiCut'
  | 'master.trim'
  | 'master.gateEnabled'
  | 'master.gateThreshold'
  | 'master.bypass';

export type MidiTarget =
  | `macro:${'density' | 'chaos' | 'motion' | 'drift' | 'tension' | 'voicing'}`
  | `bank:queue:${number}`
  | `track:${number}:${TrackKnobTargetName}`
  // View-relative: addresses the Nth track (0-based) of the CURRENTLY VIEWED
  // section (drum vs melodic), resolved live at dispatch. So a control row
  // follows the on-screen rhythm/melody toggle instead of pinning to a fixed
  // index — used by the Launch Control XL3 mixer preset.
  | `track:view:${number}:${TrackKnobTargetName}`
  | `fx:${FxKnobTargetName}`
  | 'transport:play'
  | 'transport:freeze'
  | 'transport:tap-tempo'
  | 'transport:ghost';

export interface MidiBinding {
  ch: number;
  msg: 'cc' | 'note';
  num: number;
  target: MidiTarget;
  // Relative-emulation: some controllers (e.g. Launch Control XL3 encoders)
  // can only send ABSOLUTE 0..127, never true relative. When `relative` is
  // set, the dispatcher treats consecutive absolute values as deltas and
  // applies them to the target's CURRENT value — so the control never jumps
  // when its target changes (e.g. a view-relative row following the rhythm/
  // melody page). See the relative block in dispatchMidi.
  relative?: boolean;
}

export const FX_KNOB_TARGETS: FxKnobTargetName[] = [
  'tape.position',
  'tape.length',
  'tape.mix',
  'tape.grainRate',
  'tape.grainMix',
  'tape.hold',
  'glitch.chance',
  'glitch.mix',
  'reverb.size',
  'reverb.mix',
  'reverb.diffusion',
  'reverb.damping',
  'saturation.preDrive',
  'master.input',
  'master.loCut',
  'master.comp',
  'master.compAttack',
  'master.compRelease',
  'master.mode',
  'master.drive',
  'master.bias',
  'master.mix',
  'master.hiCut',
  'master.trim',
  'master.gateEnabled',
  'master.gateThreshold',
  'master.bypass',
];

export const TRACK_KNOB_TARGETS: TrackKnobTargetName[] = [
  'mutation',
  'rowRatchet',
  'fxSend',
  'pan',
  'gain',
  'filterCutoff',
  'filterResonance',
  'mute',
  'solo',
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
    const resolved = resolveTrackTarget(s, target);
    if (!resolved) return;
    const { track, knob } = resolved;
    switch (knob) {
      case 'mutation':
        s.setTrackMutation(track.id, value01);
        return;
      case 'rowRatchet':
        s.setTrackRowRatchet(track.id, value01);
        return;
      case 'fxSend':
        s.setTrackFxSend(track.id, value01);
        return;
      case 'pan':
        s.setTrackPan(track.id, value01);
        return;
      case 'gain':
        // CC value is 0..1; gain stores 0..2 with unity at the dial center.
        s.setTrackGain(track.id, value01 * 2);
        return;
      case 'filterCutoff':
        s.setTrackFilterCutoff(track.id, value01);
        return;
      case 'filterResonance':
        s.setTrackFilterResonance(track.id, value01);
        return;
      case 'mute':
        // Direct-set from the latching toggle button's value (127/0).
        s.setTrackMute(track.id, value01 >= 0.5);
        return;
      case 'solo':
        s.setTrackSolo(track.id, value01 >= 0.5);
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
      case 'tape.hold':
        s.setTape({ hold: !s.tape.hold });
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
      case 'reverb.diffusion':
        s.setReverb({ diffusion: value01 });
        return;
      case 'reverb.damping':
        s.setReverb({ damping: value01 });
        return;
      case 'saturation.preDrive':
        s.setSaturation({ preDrive: value01 });
        return;
      case 'master.input':
        s.setMaster({ input: value01 });
        return;
      case 'master.loCut':
        // Rising-edge momentary (see MOMENTARY_EXACT below) — cycle on press.
        s.setMaster({ loCut: (s.master.loCut + 1) % 4 });
        return;
      case 'master.comp':
        s.setMaster({ comp: value01 });
        return;
      case 'master.compAttack':
        s.setMaster({ compAttack: (s.master.compAttack + 1) % 6 });
        return;
      case 'master.compRelease':
        s.setMaster({ compRelease: (s.master.compRelease + 1) % 6 });
        return;
      case 'master.mode':
        // Same cycle-on-press pattern as lo-cut. 4 modes.
        s.setMaster({ mode: (s.master.mode + 1) % 4 });
        return;
      case 'master.drive':
        s.setMaster({ drive: value01 });
        return;
      case 'master.bias':
        // Map 0..1 CC value to the 0..0.2 bias range.
        s.setMaster({ bias: value01 * 0.2 });
        return;
      case 'master.mix':
        s.setMaster({ mix: value01 });
        return;
      case 'master.hiCut':
        s.setMaster({ hiCut: value01 });
        return;
      case 'master.trim':
        s.setMaster({ trim: value01 });
        return;
      case 'master.gateEnabled':
        s.setMaster({ gateEnabled: !s.master.gateEnabled });
        return;
      case 'master.gateThreshold':
        s.setMaster({ gateThreshold: value01 });
        return;
      case 'master.bypass':
        s.setMaster({ bypass: !s.master.bypass });
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
  if (target === 'transport:ghost') {
    s.setSceneGraphEnabled(!s.sceneGraph.enabled);
    return;
  }
}

// True iff a string is a recognised target shape (used for validation
// and the round-trip-unknown-targets policy).
export function isValidTarget(t: string): boolean {
  if (
    t === 'transport:play' ||
    t === 'transport:freeze' ||
    t === 'transport:tap-tempo' ||
    t === 'transport:ghost'
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
    if (rest.startsWith('view:')) {
      const r2 = rest.slice('view:'.length);
      const sep = r2.indexOf(':');
      if (sep < 0) return false;
      const pos = Number(r2.slice(0, sep));
      const knob = r2.slice(sep + 1);
      return (
        Number.isFinite(pos) && pos >= 0 && (TRACK_KNOB_TARGETS as string[]).includes(knob)
      );
    }
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

// Momentary targets fire on a single button press; firing on release
// too would land the toggle back where it started. Continuous targets
// (macros, FX knobs, per-track knobs) consume every CC value.
const MOMENTARY_PREFIXES = ['bank:queue:', 'transport:'];
const MOMENTARY_EXACT = new Set<string>([
  'fx:tape.hold',
  'fx:master.loCut',
  'fx:master.compAttack',
  'fx:master.compRelease',
  'fx:master.mode',
  'fx:master.gateEnabled',
  'fx:master.bypass',
]);

function isMomentary(target: string): boolean {
  if (MOMENTARY_EXACT.has(target)) return true;
  return MOMENTARY_PREFIXES.some((p) => target.startsWith(p));
}

const lastValueByTarget = new Map<string, number>();

export function dispatchMidi(msg: MidiMessage): void {
  // Learn mode: if the hook consumed the message (target was pinned),
  // skip normal dispatch so the twist binds without also moving the
  // bound parameter.
  if (learnHook && learnHook(msg)) return;
  // Recording: note-on from the configured record port goes to the
  // armed track's current step. Short-circuit so the same device's
  // CC mappings still fire on knob twists, but a recorded note
  // doesn't also trigger a binding on the same num.
  if (tryRecordNote(msg)) return;
  // Note-off closes a held note → ties across the steps it spanned.
  if (tryRecordNoteOff(msg)) return;
  const b = activeBindings.find(
    (x) => x.ch === msg.ch && x.msg === msg.msg && x.num === msg.num
  );
  if (!b) return;
  const value01 = msg.msg === 'cc' ? msg.value / 127 : 1;

  // Relative-emulation: apply the absolute control's change as a delta to the
  // target's current value (see relLast / currentValue01). Must run before the
  // pickup/momentary paths and before the absolute dispatch.
  if (msg.msg === 'cc' && b.relative) {
    const key = `${b.ch}:cc:${b.num}`;
    const last = relLast.get(key);
    relLast.set(key, msg.value);
    if (last === undefined) return; // need a baseline before the first delta
    const delta = msg.value - last;
    if (delta === 0) return;
    const s = useSequencerStore.getState();
    const cur = currentValue01(s, b.target);
    if (cur === null) return;
    const next = Math.max(0, Math.min(1, cur + delta * REL_SENS));
    dispatchTarget(b.target, next);
    return;
  }

  // Soft-takeover for view-relative continuous controls (see pickupAllows):
  // hold disengaged until the control crosses the addressed track's current
  // value, so flipping rhythm/melody pages never jumps the parameter.
  if (msg.msg === 'cc' && b.target.startsWith('track:view:')) {
    const s = useSequencerStore.getState();
    const tt = resolveTrackTarget(s, b.target);
    if (tt && TRACK_CONTINUOUS.has(tt.knob)) {
      const key = `${b.ch}:cc:${b.num}`;
      if (!pickupAllows(key, tt.track.id, trackParam01(tt.track, tt.knob), value01)) return;
    }
  }

  // Rising-edge gate for momentary targets bound to CC buttons. Notes
  // skip this because Note Off / velocity-0 is filtered upstream in
  // midiIn — every Note On we see IS already a fresh press.
  if (isMomentary(b.target) && msg.msg === 'cc') {
    const last = lastValueByTarget.get(b.target) ?? 0;
    lastValueByTarget.set(b.target, value01);
    if (!(last < 0.5 && value01 >= 0.5)) return;
  }

  dispatchTarget(b.target, value01);
}
