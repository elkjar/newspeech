// Extracted verbatim from App.tsx (Phase 0 of the broadcast runner,
// docs/broadcast-set.md). No behavior change: each install* function is the
// body of the former useEffect and returns the same cleanup.
import { useSequencerStore, type SequencerState } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { setClockBpm, clockEngineStart, clockEngineStop } from '../audio/midiClock';
import { resetTracker } from '../audio/clockFollow';
import { stopPlaybackLocal, prepareForPlay } from '../audio/transport';
import { samplePlayer } from '../audio/samplePlayer';
import {
  triggerSample,
  repitchNote,
  releaseNote,
  setMixRouting,
  fireGlitch,
  initNativeAudio,
  installDeviceRateWatch,
} from '../audio/nativeEngine';
import { initEngineClock, frameAtTime } from '../audio/engineClock';
import {
  allocRevoiceNoteId,
  clearAllChords,
  soundingChords,
  targetMidisFor,
  diffChord,
} from '../audio/voicingRevoice';
import { initMIDIOut, getMIDIOutputs, onMIDIOutputsChanged } from '../audio/midiOut';
import { initMIDIIn, getConnectedInputNames, onMIDIInputsChanged } from '../midi/midiIn';
import { dispatchMidi } from '../midi/midiMap';
import { loadMidiMapLibrary } from '../midi/midiMapLoader';
import {
  disconnectAll as disconnectLaunchpads,
  findAllLaunchpadPorts,
  getConnectedCount,
  getConnectedInputPorts,
  syncLaunchpads,
} from '../midi/launchpad';
import { attachLaunchpadBindings, detachLaunchpadBindings } from '../midi/launchpadBindings';
import {
  connectXL3,
  disconnectXL3,
  findXL3Ports,
  getXL3Port,
  isXL3Connected,
} from '../midi/launchControlXL3';
import { attachXL3Bindings, detachXL3Bindings } from '../midi/launchControlXL3Bindings';
import { scanAndLoadUserSamples } from '../instruments/userSamplesDir';
import { modulated, GLOBAL_TRACK_ID } from '../audio/lfo';
import { initGhost } from '../ghost/ghost';
import type { TrackOutput } from '../state/store';

export interface BootOptions {
  /** Reset to the blank init project at boot (Sequence: yes; a runner that
   *  loads a set instead: no). */
  initProject: boolean;
  /** Connect Launchpad X / Launch Control XL3 and watch for hot-plug. */
  controllers: boolean;
}

// Guard for the sample-load effect. React StrictMode in dev double-invokes
// effects, which would otherwise kick off two parallel sample loads —
// counter would climb to 2× the kit count (36/18) and the splash would
// flicker as both passes raced. Production won't hit this (no StrictMode
// in prod), but the guard is cheap and correct either way.
//
// Stored on `window` so it survives App.tsx HMR cycles — a plain
// module-scope `let` would reset on every reload, re-triggering the boot
// and re-decoding every kit's WAVs. Each fresh decode allocates AudioBuffers
// (the Map overwrite eventually drops the old refs) but the spike during
// a fast HMR session is significant.
const SAMPLES_BOOT_FLAG = '__newspeechSamplesBootStarted';
type SamplesBootWindow = Window & { [SAMPLES_BOOT_FLAG]?: boolean };
function samplesBootStarted(): boolean {
  return (window as SamplesBootWindow)[SAMPLES_BOOT_FLAG] === true;
}
function markSamplesBootStarted(): void {
  (window as SamplesBootWindow)[SAMPLES_BOOT_FLAG] = true;
}

export function bootEngine(opts: BootOptions): () => void {
  initMIDIOut();
  initGhost();
  if (opts.initProject) {
    // Tauri app launches in init state — blank tracks, no banks, no
    // scenes, no composition (2026-05-24 user direction). The user's
    // sample library is the source of truth and they start from scratch.
    // Tempo / scale / master FX stay (good starting tone).
    useSequencerStore.getState().initProject();
  }
  // Load any saved user mappings FIRST so the active mapping is in
  // place before MIDI input starts firing.
  void (async () => {
    await loadMidiMapLibrary();
    await initMIDIIn(dispatchMidi);
  })();

  // Launchpad X — native-only. Web Audio can't use SysEx without an extra
  // permission request the rest of the web build doesn't need, and the
  // device is a performance-tier feature per the app/web tiering decision.
  if (!opts.controllers) return () => {};
  const tryConnectLaunchpad = async () => {
    const inputs = getConnectedInputNames();
    const outputs = getMIDIOutputs().map((o) => o.name);
    // Reconcile the connected surfaces to exactly what's enumerated now.
    // syncLaunchpads connects new pads, tears down unplugged ones, and keeps
    // survivors in place — so this one call handles initial connect, the
    // second pad arriving, and either being unplugged. No-op when the set is
    // already correct.
    const pairs = findAllLaunchpadPorts(inputs, outputs);
    const before = getConnectedCount();
    const connectedPorts = getConnectedInputPorts();
    const sameSet =
      connectedPorts.length === pairs.length &&
      pairs.every((p, i) => connectedPorts[i] === p.inputPort);
    if (sameSet) return;
    const count = await syncLaunchpads(pairs);
    // Bindings attach once any pad is present, detach when none remain.
    // (The binding layer repaints on its own connection-change subscription
    // when a pad is added/removed while already attached.)
    if (count > 0 && before === 0) attachLaunchpadBindings();
    else if (count === 0 && before > 0) detachLaunchpadBindings();
  };
  // Launch Control XL3 — native-only, same tiering as the Launchpad. Driven
  // in DAW mode (the host can write encoder positions there → value-sync).
  const tryConnectXL3 = async () => {
    const inputs = getConnectedInputNames();
    const outputs = getMIDIOutputs().map((o) => o.name);
    const connectedPort = getXL3Port();
    if (connectedPort && !inputs.includes(connectedPort)) {
      detachXL3Bindings();
      await disconnectXL3();
    }
    if (isXL3Connected()) return;
    const found = findXL3Ports(inputs, outputs);
    if (!found) return;
    const ok = await connectXL3(found.inputPort, found.outputPort);
    if (ok) attachXL3Bindings();
  };

  // Initial poke + watch for hot-plug on either side.
  void tryConnectLaunchpad();
  void tryConnectXL3();
  const offInputs = onMIDIInputsChanged(() => {
    void tryConnectLaunchpad();
    void tryConnectXL3();
  });
  const offOutputs = onMIDIOutputsChanged(() => {
    void tryConnectLaunchpad();
    void tryConnectXL3();
  });
  const onUnload = () => {
    // Best-effort: return every device to its prior mode so it doesn't sit dark.
    detachLaunchpadBindings();
    void disconnectLaunchpads();
    detachXL3Bindings();
    void disconnectXL3();
  };
  window.addEventListener('beforeunload', onUnload);
  return () => {
    offInputs();
    offOutputs();
    window.removeEventListener('beforeunload', onUnload);
    onUnload();
  };
}

export function startSamplesBoot(): void {
  // Sample kit boot. The samples directory (~/Documents/Sequence/samples) is
  // the single source of truth — every kit is loaded from there, categorized
  // by its parent folder (drums/instruments/pads/bass/textures). There is no
  // "bundled" tier: Sequence is native-only, and a first launch with an empty
  // samples dir simply starts with no kits (tracks fall through to the synth
  // fallback until the user adds samples).
  if (samplesBootStarted()) return;
  markSamplesBootStarted();
  void (async () => {
    // loadManifest runs in pathsOnly mode on native — no Web Audio
    // decodeAudioData pass, no JSON-encoded bytes round trip through invoke,
    // just path-string interning. The cpal engine reads each file directly
    // when the voice is first triggered.
    const result = await scanAndLoadUserSamples();
    if (result.loaded > 0) {
      console.info(`[samples] loaded ${result.loaded} kit(s)`);
    }
    for (const e of result.errors) console.warn('[samples]', e);
    useSequencerStore.getState().setBootDone(true);
  })();
}

// Auto-open the native cpal device on app launch using persisted
// settings (device + channels + SR + buffer from localStorage). On
// first launch or after a device is unplugged, falls back to the
// system default. Non-fatal on failure — user can still pick a
// device in Settings → native audio.
export function installNativeAudio(opts: { recorder: boolean }): () => void {
  // Engine clock first: initNativeAudio opens the cpal stream, and the
  // clock's boot poll + audio:time subscription want to catch the very
  // first frames of it. The rate watch then auto-reopens if the device's
  // rate/channels change mid-session (Zoom HFP grab) — see nativeEngine.
  void initEngineClock()
    .then(() => initNativeAudio())
    .then(() => installDeviceRateWatch());
  // Bridge the store's armed+playing edge to the native recorder's
  // start/stop IPCs.
  if (opts.recorder) {
    void import('../audio/nativeRecorder').then((m) => m.subscribeNativeRecorder());
  }
  return () => {};
}

// Push mix-routing changes (multi_out, fxOutput, fxBypass) on every
// store edit. Discrete state — no modulation — so a store.subscribe
// beats folding it into the RAF loop. Initial pass fires the current
// state to the engine right after device open.
export function installMixRoutingPush(): () => void {
  const push = (mix: { multiOut: boolean; fxOutput: TrackOutput; fxBypass: boolean }) => {
    void setMixRouting({
      multiOut: mix.multiOut,
      fxOutFirst: mix.fxOutput.firstChannel,
      fxOutStereo: mix.fxOutput.stereo,
      fxBypass: mix.fxBypass,
    });
  };
  push(useSequencerStore.getState().nativeMix);
  return useSequencerStore.subscribe((state, prev) => {
    if (state.nativeMix !== prev.nativeMix) push(state.nativeMix);
  });
}

// Keep the scheduler + native clock-master thread in step with the store bpm.
// (Was a [bpm] effect: fires once now, then on every bpm change.)
export function installBpmSync(): () => void {
  const apply = (bpm: number) => {
    scheduler.setBpm(bpm);
    // Keep the native clock-master thread's tempo in sync with the transport.
    setClockBpm(bpm);
  };
  apply(useSequencerStore.getState().bpm);
  return useSequencerStore.subscribe((state, prev) => {
    if (state.bpm !== prev.bpm) apply(state.bpm);
  });
}

// Clock-follow mode switch: clear the tempo tracker on any transition so a
// re-entry to external re-derives tempo cleanly. Switching INTO follow mode
// while playing stops the internal transport cleanly (no MIDI stop emitted —
// we're handing transport to the master) and waits for its next Start.
//
// (Was a [syncSource] effect.)
// Free-running MIDI clock master: in internal mode, run the continuous
// 24-PPQN pulse thread whenever a clock-out port is configured — so the rig
// gets clock the moment it's targeted, not only while playing, and the
// stream survives transport stops (play/stop only ride Start/Stop over the
// top; see togglePlayback). External (follow) mode owns the relay engine
// through clockFollow, so leave the thread alone here. clockEngineStart is
// idempotent, so the unchanged-ports re-run is a no-op on the live stream.
//
// (Was a [syncSource, midiClockOutPorts] effect.) Both ran on mount in this
// order, and both re-run on a syncSource change; only the master block re-runs
// when the port list changes — the subscription below preserves that.
export function installClockSync(): () => void {
  const follow = (syncSource: SequencerState['syncSource']) => {
    resetTracker();
    if (syncSource === 'external') {
      // Hand clock + transport to the master: tear down our own free-running
      // clock-out thread (sending a final Stop to the rig) and stop any
      // in-progress playback. The internal-master engine effect below won't
      // re-arm while syncSource !== 'internal'.
      clockEngineStop(true);
      if (useSequencerStore.getState().playing) stopPlaybackLocal();
      // Pre-warm the audio path (resume device + program changes) now, so the
      // master's first Start launches instantly instead of paying the cold-start
      // stall on the first downbeat. startFollowPlayback's await is then a no-op.
      void prepareForPlay();
    }
  };
  const master = (syncSource: SequencerState['syncSource'], midiClockOutPorts: string[]) => {
    if (syncSource !== 'internal') return;
    if (midiClockOutPorts.length) {
      clockEngineStart();
    } else {
      clockEngineStop(true);
    }
  };
  const s0 = useSequencerStore.getState();
  follow(s0.syncSource);
  master(s0.syncSource, s0.midiClockOutPorts);
  return useSequencerStore.subscribe((state, prev) => {
    const syncChanged = state.syncSource !== prev.syncSource;
    if (syncChanged) follow(state.syncSource);
    if (syncChanged || state.midiClockOutPorts !== prev.midiClockOutPorts) {
      master(state.syncSource, state.midiClockOutPorts);
    }
  });
}

// Live chord re-voicing for the voicing macro (Increment 2). Native only —
// `repitchNote` has no Web Audio analogue. ~30ms cadence: the macro quantizes
// into discrete voicing stages, so even under a fast LFO this fires a handful
// of voice-leading diffs across a sweep, not a stream of micro-edits. Each
// diff re-pitches the tones that moved (inversion/spread), blooms in added
// extensions as fresh voices, and fades out removed ones. When nothing has
// moved the diff is empty and no IPC is issued. See voicingRevoice.ts.
export function installChordRevoice(): () => void {
  const id = window.setInterval(() => {
    const s = useSequencerStore.getState();
    if (!s.playing) {
      clearAllChords();
      return;
    }
    const chords = soundingChords();
    if (chords.length === 0) return;
    const modVoicing = modulated(
      s.voicing,
      s.lfos,
      GLOBAL_TRACK_ID,
      'voicing',
      undefined,
      1,
    );
    for (const chord of chords) {
      const target = targetMidisFor(chord, modVoicing);
      const plan = diffChord(chord.tones, target);
      if (
        plan.repitch.length === 0 &&
        plan.removeNoteIds.length === 0 &&
        plan.addMidis.length === 0
      ) {
        continue;
      }
      for (const rp of plan.repitch) void repitchNote(rp.noteId, rp.ratio);
      for (const noteId of plan.removeNoteIds) void releaseNote(noteId, 0.12);
      const nextTones = [...plan.keptTones];
      for (const midi of plan.addMidis) {
        const pick = samplePlayer.pickNativeSample(chord.voice, midi, chord.trackId);
        if (!pick) continue;
        const noteId = allocRevoiceNoteId();
        void triggerSample(pick.path, {
          gain: chord.velocity * pick.voiceGain * chord.trackGain,
          pan: chord.pan,
          pitch: pick.pitch,
          outFirst: chord.outFirst,
          outStereo: chord.outStereo,
          trackId: chord.trackId,
          monophonic: false,
          section: chord.section,
          isTexture: chord.isTexture,
          envelopeAttack: chord.env?.attack,
          envelopeDecay: chord.env?.decay,
          envelopeSustain: chord.env?.sustain,
          envelopeRelease: chord.env?.release,
          envelopeHold: chord.env?.hold,
          noteId,
          start: pick.start,
          end: pick.end,
          loopMode: pick.loop,
          filterType: pick.filterType,
          cutoff: pick.cutoff,
          resonance: pick.resonance,
          satDrive: pick.satDrive,
          bitDepth: pick.bitDepth,
          lfoShape: pick.lfoShape,
          lfoRateHz: pick.lfoRateHz,
          lfoDepth: pick.lfoDepth,
          mods: pick.mods,
          granular: pick.granular,
          wavetable: pick.wavetable,
        });
        nextTones.push({ noteId, midi });
      }
      chord.tones = nextTones;
    }
  }, 30);
  return () => window.clearInterval(id);
}

// Glitch beat-fire dice roll. The scheduler ticks at 32nds
// (stepsPerBeat=8), so beat boundaries are `stepIndex % 8 === 0`.
// On each beat we roll `state.glitch.chance` (LFO-modulated via
// `glitchChance`) and fire via IPC on a hit, targeting the beat's
// absolute engine-clock frame — the stutter starts ON the audible
// beat instead of a lookahead (~SCHEDULE_AHEAD) early. The Rust
// glitch stage is otherwise pass-through.
export function installGlitchDice(): () => void {
  const unsub = scheduler.onStep('app:native-glitch', (stepIndex, when) => {
    if (stepIndex % 8 !== 0) return;
    const state = useSequencerStore.getState();
    const chance = modulated(
      state.glitch.chance,
      state.lfos,
      GLOBAL_TRACK_ID,
      'glitchChance',
    );
    if (chance <= 0) return;
    if (Math.random() >= chance) return;
    void fireGlitch(frameAtTime(when));
  });
  return unsub;
}
