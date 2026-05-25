import { useEffect, useState } from 'react';
import { PlayButton, RecordButton, CountInButton, RawRecordButton, SplitsButton, TransportControls, InitButton } from './components/Transport';
import { PerformanceButton } from './components/PerformanceDialog';
import { initAudioOutputs } from './audio/audioOutput';
import { SettingsDialog } from './components/SettingsDialog';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { LFOPanel } from './components/LFOPanel';
import { MacroStrip } from './components/MacroStrip';
import { GhostDebug } from './components/GhostDebug';
import { Toasts } from './components/Toasts';
import { BankPad } from './components/BankPad';
import { ScenePad } from './components/ScenePad';
import { GhostPanel } from './components/GhostPanel';
import { FXPanel } from './components/FXPanel';
import { Scope } from './components/Scope';
import {
  useSequencerStore,
  type EditMode,
  type TrackSection,
  type TrackOutput,
} from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { voiceEnvelope } from './audio/voices';

// TrackSection string → native section code (matches SECTION_* in
// `src-tauri/src/audio.rs`). 0 = none (no splits write), 1 = drum,
// 2 = melodic, 3 = click (written to both splits — used by the
// transport-level count-in trigger, not by track events).
function sectionCode(section: 'drum' | 'melodic' | undefined): number {
  if (section === 'drum') return 1;
  if (section === 'melodic') return 2;
  return 0;
}
import {
  isNativeAudioAvailable,
  triggerSample,
  setTrackFiltersBulk,
  setReverbParams,
  setSaturationParams,
  setTapeParams,
  setGlitchParams,
  fireGlitch,
  setMasterFilters,
  setMasterComp,
  setMasterDist,
  setMasterGate,
  setMasterBypass,
  setMixRouting,
  setLfos,
  initNativeAudio,
  type TrackFilterUpdate,
  type NativeLfo,
  type LfoDestKind,
} from './audio/nativeEngine';
import { getAudioContext } from './audio/audioContext';
import {
  initMIDIOut,
  sendMIDINote,
  resolveDeviceId,
  getMIDIOutputs,
  onMIDIOutputsChanged,
} from './audio/midiOut';
import { initMIDIIn, getConnectedInputNames, onMIDIInputsChanged } from './midi/midiIn';
import { dispatchMidi } from './midi/midiMap';
import { loadMidiMapLibrary } from './midi/midiMapLoader';
import {
  connectLaunchpad,
  disconnectLaunchpad,
  findLaunchpadPorts,
  getConnectedPort,
  isLaunchpadConnected,
} from './midi/launchpad';
import { attachLaunchpadBindings, detachLaunchpadBindings } from './midi/launchpadBindings';
import { octaveDegrees } from './audio/scale';
import { sourceIsMelodic } from './instruments/library';
import { registerKit, type SampleKitEntry, type ExtendedSampleManifest } from './instruments/manifestRegistry';
import { scanAndLoadUserSamples } from './instruments/userSamplesDir';
import { tickPadDrift } from './audio/padState';
import type { ChordDegree } from './audio/chords';
import { getChordContext, setChordContext } from './audio/chordContext';
import { getOverlay, setOverlay, attachChordToOverlay } from './audio/mutationOverlay';
import { runTick } from './engine/tick';
import { modulated, GLOBAL_TRACK_ID } from './audio/lfo';
import { makeHarmonicMotionState, tickHarmonicMotion } from './audio/harmonicMotion';
import { togglePlayback } from './audio/transport';
import {
  initGhost,
  tickBar as ghostTickBar,
  beforeBarCommit as ghostBeforeBarCommit,
} from './ghost/ghost';
import { autoSeedBanks } from './ghost/generator';
import { isTauri } from '@tauri-apps/api/core';

const NATIVE = isTauri();

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

const MODE_KEYS: Record<string, EditMode> = {
  '1': 'live',
  '2': 'velocity',
  '3': 'chance',
  '4': 'ratchet',
  '5': 'timing',
  '6': 'gate',
};

const MODES: EditMode[] = ['live', 'velocity', 'chance', 'ratchet', 'timing', 'gate'];

const SECTIONS: { id: TrackSection; label: string }[] = [
  { id: 'drum', label: 'rhythm' },
  { id: 'melodic', label: 'melody' },
];

function SamplesSplash({ loaded, total }: { loaded: number; total: number }) {
  // Cover the whole window. z-[100] sits above modals/portals; the splash
  // owns the screen until bootDone. Terminal-style minimal text matching
  // the rest of the app's aesthetic — no spinner, just a count.
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#050505]">
      <div className="flex flex-col items-center gap-3 text-white">
        <div className="text-[11px] uppercase tracking-[0.3em] opacity-70">
          newspeech sequence
        </div>
        <div className="text-[10px] uppercase tracking-widest opacity-40">
          loading samples
        </div>
        <div className="text-[10px] uppercase tracking-widest opacity-70 tabular-nums">
          {total > 0 ? `${loaded} / ${total}` : '…'}
        </div>
        <div className="w-[160px] h-px bg-white/15 relative overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-white/60"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function SectionToggle() {
  const viewSection = useSequencerStore((s) => s.viewSection);
  const setViewSection = useSequencerStore((s) => s.setViewSection);
  return (
    <div className="flex gap-2 text-[11px] uppercase tracking-widest">
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          onClick={() => setViewSection(s.id)}
          className={[
            'px-3 py-1.5 border transition-colors',
            viewSection === s.id
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function ModeSwitcher() {
  const editMode = useSequencerStore((s) => s.editMode);
  const setEditMode = useSequencerStore((s) => s.setEditMode);
  return (
    <div className="flex gap-2 text-[11px] uppercase tracking-widest">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => setEditMode(m)}
          className={[
            'px-3 py-1.5 border transition-colors',
            editMode === m
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const bpm = useSequencerStore((s) => s.bpm);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Sample-load splash. ~140MB of bundled WAVs decode on boot; without a
  // splash the user sees a sluggish-feeling app for the duration (RAF-driven
  // UI like LFO indicators chugs at 2-3 FPS while the audio thread + main
  // thread chew through decodes). Splash hides that window — once loaded,
  // every interaction is snappy from the first click.
  const [samplesLoaded, setSamplesLoaded] = useState(0);
  const [samplesTotal, setSamplesTotal] = useState(0);
  const [bootDone, setBootDone] = useState(false);

  useEffect(() => {
    if (NATIVE) document.body.classList.add('tauri-native');
    initMIDIOut();
    initGhost();
    void initAudioOutputs();
    if (NATIVE) {
      // Tauri app launches in init state — blank tracks, no banks, no
      // scenes, no composition (2026-05-24 user direction). The default
      // preset's authored patterns / voice IDs only make sense on the
      // web build where bundled samples are loaded; on Tauri the user's
      // library is the source of truth and they start from scratch.
      // Tempo / scale / master FX stay (good starting tone).
      useSequencerStore.getState().initProject();
    } else {
      // Web: auto-seed banks on every load — wipes scene banks and fills
      // slots 0-9 with one of each recipe in song-arc order. User's
      // track voices (band identity) persist via persist.ts and seed
      // banks inherit those via activeVoice() in compose moves. Default
      // preset's authored tracks remain so the demo is immediately
      // playable.
      autoSeedBanks();
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
    if (!NATIVE) return;
    const tryConnectLaunchpad = async () => {
      const inputs = getConnectedInputNames();
      const outputs = getMIDIOutputs().map((o) => o.name);
      // If we're connected to a port that's no longer enumerated, the device
      // was unplugged. Tear down so the next call can re-detect and reconnect
      // — without this, `isLaunchpadConnected()` stays true forever and
      // replugging the same device silently does nothing.
      const connectedPort = getConnectedPort();
      if (connectedPort && !inputs.includes(connectedPort)) {
        detachLaunchpadBindings();
        await disconnectLaunchpad();
      }
      if (isLaunchpadConnected()) return;
      const found = findLaunchpadPorts(inputs, outputs);
      if (!found) return;
      const ok = await connectLaunchpad(found.inputPort, found.outputPort);
      if (ok) attachLaunchpadBindings();
    };
    // Initial poke + watch for hot-plug on either side.
    void tryConnectLaunchpad();
    const offInputs = onMIDIInputsChanged(() => void tryConnectLaunchpad());
    const offOutputs = onMIDIOutputsChanged(() => void tryConnectLaunchpad());
    const onUnload = () => {
      // Best-effort: return the device to Live Mode so it doesn't sit dark.
      detachLaunchpadBindings();
      void disconnectLaunchpad();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      offInputs();
      offOutputs();
      window.removeEventListener('beforeunload', onUnload);
      onUnload();
    };
  }, []);

  useEffect(() => {
    // Sample kit boot. Two sources of kits:
    //   - Web: bundled samples under public/samples/, discovered via
    //     samples/index.json (emitted by the vite samplesIndex plugin
    //     at build time; served live in dev). The web tier is the
    //     "free baseline" per [[project-app-web-tiering]] and has no
    //     user-samples-dir mechanism, so bundled is the only source.
    //   - Tauri app: user samples directory only. The app defaults to
    //     "your library is the source of truth" (user direction
    //     2026-05-24) — bundled kits in the repo are for the web build
    //     only and skipped here. First-launch trade: default preset's
    //     voice IDs won't resolve until the user loads their kits, and
    //     those tracks fall through to the synth fallback. Acceptable
    //     per "leave broken (manual re-pick)" save-compat policy.
    if (samplesBootStarted()) return;
    markSamplesBootStarted();
    const indexUrl = `${import.meta.env.BASE_URL}samples/index.json`;
    void (async () => {
      if (!NATIVE) {
        try {
          const res = await fetch(indexUrl);
          const index = (await res.json()) as SampleKitEntry[];
          setSamplesTotal(index.length);
          // Splash screen is up — load kits in parallel for fastest wall-clock
          // time. Counter increments as each kit's manifest finishes registering
          // + decoding so the user sees progress instead of a frozen number.
          await Promise.all(
            index.map(async (entry) => {
              const baseUrl = `${import.meta.env.BASE_URL}samples/${entry.kitPath}`;
              try {
                const manifestRes = await fetch(`${baseUrl}/manifest.json`);
                const manifest = (await manifestRes.json()) as ExtendedSampleManifest;
                registerKit(entry.kitPath, baseUrl, manifest);
                await samplePlayer.loadManifest(baseUrl, manifest, undefined, {
                  pathsOnly: isNativeAudioAvailable(),
                });
              } catch (err) {
                console.warn(`sample manifest ${entry.kitPath} load failed:`, err);
              }
              setSamplesLoaded((n) => n + 1);
            }),
          );
        } catch (err) {
          console.warn('samples index load failed:', err);
        }
      }
      // User-sample kits. No-op on web (isTauri false → resolveUserSamplesDir
      // returns null → scanner skips). In Tauri this is cheap because
      // samplePlayer.loadManifest runs in pathsOnly mode there — no
      // Web Audio decodeAudioData pass, no JSON-encoded bytes round
      // trip through invoke, just path-string interning. Native
      // preload reads files directly via the cpal-side bytes path
      // when each voice is first triggered.
      const userResult = await scanAndLoadUserSamples();
      if (userResult.loaded > 0) {
        console.info(`[user samples] loaded ${userResult.loaded} kit(s)`);
      }
      if (userResult.errors.length > 0) {
        for (const e of userResult.errors) console.warn('[user samples]', e);
      }
      setBootDone(true);
    })();
  }, []);

  useEffect(() => {
    const harmonic = makeHarmonicMotionState();
    return scheduler.onStep((globalStep, when, stepDuration) => {
      // Bar boundary at 4/4 32nd resolution = every 32 global steps. A queued
      // pattern recall commits here, before we read `tracks` for this tick,
      // so the swap is atomic from the dispatch's point of view. Ghost
      // ordering: beforeBarCommit snapshots current macros as lerp source
      // BEFORE commit overwrites them; tickBar runs AFTER commit so it sees
      // the just-swapped activeBank as the lerp target.
      if (globalStep % 32 === 0) {
        ghostBeforeBarCommit();
        // Pass the scheduler's globalStep so applyBankSlot's sceneStartStep
        // matches the SCHEDULED step (not the lagging audible step in the
        // store). Without this, sceneStep = scheduled - audible-stale ≠ 0,
        // and chord master / bass step 0 land at non-zero localStep — the
        // "dropping beat 1" symptom.
        // Order: song → scene → bank. An outgoing song's queued scene/bank
        // would be stale by the time it commits, so song commit fires first
        // (after its tail-out gap). Song's tail-out gap counts down here:
        // while remaining > 0 we leave activeSong unchanged and don't emit
        // triggers (see emit gate below); when it hits 0 we commit.
        const performance = useSequencerStore.getState().performance;
        if (performance.pendingSong !== null) {
          if (performance.tailOutBarsRemaining > 0) {
            useSequencerStore.getState().tickPerformanceTailOut();
          } else {
            useSequencerStore.getState().commitPendingSong(globalStep);
          }
        }
        useSequencerStore.getState().commitPendingScene(globalStep);
        useSequencerStore.getState().commitPendingBank(globalStep);
        ghostTickBar(globalStep);
      }
      const state = useSequencerStore.getState();
      // Harmonic motion is a cross-tick state machine — owned by the
      // dispatcher, not the engine. Engine consumes the resolved offset.
      // Freeze pins the offset at its current value so a captured cycle
      // keeps the same key-shift it had at freeze moment.
      const modMotion = modulated(state.motion, state.lfos, GLOBAL_TRACK_ID, 'motion', undefined, 1);
      const modDrift = modulated(state.drift, state.lfos, GLOBAL_TRACK_ID, 'drift', undefined, 1);
      const harmonicOffset = state.freeze
        ? harmonic.offset
        : tickHarmonicMotion(
            harmonic,
            globalStep,
            modMotion,
            modDrift,
            octaveDegrees(state.scale),
          );
      // Performance tail-out gate. When a song swap is queued and the
      // tail-out clock hasn't elapsed, skip emitting fresh triggers so
      // the outgoing piece's voices ring out cleanly before the new
      // song snaps in. Sample tails / reverb / delay all keep ringing
      // because the audio graph is untouched — we just stop the source
      // of new step events.
      const inTailOut =
        state.performance.pendingSong !== null &&
        state.performance.tailOutBarsRemaining > 0;
      const events = inTailOut
        ? []
        : runTick(
            {
              tracks: state.tracks,
              rootNote: state.rootNote,
              scale: state.scale,
              lfos: state.lfos,
              density: state.density,
              chaos: state.chaos,
              tension: state.tension,
              freeze: state.freeze,
              sceneStartStep: state.sceneStartStep,
              globalStep,
              when,
              stepDuration,
              harmonicOffset,
              chordContext: getChordContext(),
            },
            {
              readOverlay: getOverlay,
              consumePadDrift: tickPadDrift,
            },
          );
      for (const ev of events) {
        switch (ev.kind) {
          case 'overlay':
            setOverlay(ev.trackId, ev.localStep, ev.value);
            break;
          case 'chordContext':
            setChordContext(ev.chord);
            break;
          case 'overlayChord':
            attachChordToOverlay(ev.trackId, ev.localStep, ev.chord);
            break;
          case 'midi': {
            const deviceId = resolveDeviceId(ev.portName, state.midiOutDeviceId);
            if (deviceId) {
              sendMIDINote(deviceId, ev.channel, ev.note, ev.velocity, ev.when, ev.durationS);
            }
            break;
          }
          case 'sample': {
            // Arpeggiator transformation — when on AND the trigger carries
            // multiple chord intervals, split into N sequential single-tone
            // triggers spread evenly across the step. Single-note triggers
            // are passed through unchanged. v1: "up" pattern only (intervals
            // played in their natural order); pattern/rate/range selection
            // deferred per [[project_arp_mode]].
            const evTrack = state.tracks.find((t) => t.id === ev.trackId);
            const arpOn = evTrack?.arpConfig?.on === true;
            if (arpOn && ev.voiceIntervals.length > 1) {
              const n = ev.voiceIntervals.length;
              // Spread arp tones across the FULL tied window — when the
              // step is tied to followers, the arp extends through the
              // whole chain instead of cramming all tones into the first
              // step. Tied chains of N steps × M chord tones still play
              // exactly M tones, each occupying (N/M) step-durations.
              const totalDuration = ev.stepDuration * ev.tieLength;
              const sub = totalDuration / n;
              if (isNativeAudioAvailable()) {
                // Native arp — Phase 5 sample-accurate dispatch. Fire
                // all tones IMMEDIATELY through the IPC; each carries
                // its own delaySecs so the Rust audio callback queues
                // them and emits at the exact sub-step sample. No more
                // setTimeout jitter. pickNativeSample is still called
                // at scheduling time so the round-robin counter
                // advances in arp order regardless of dispatch latency.
                const out = evTrack?.output;
                const pan = ((ev.pan ?? 0.5) - 0.5) * 2;
                const trackGain = evTrack?.gain ?? 1;
                const nowAudio = getAudioContext().currentTime;
                for (let i = 0; i < n; i++) {
                  const fireAt = ev.when + i * sub;
                  const delaySecs = Math.max(0, fireAt - nowAudio);
                  const interval = ev.voiceIntervals[i];
                  const targetMidi =
                    ev.midi !== undefined ? ev.midi + interval : undefined;
                  const pick = samplePlayer.pickNativeSample(ev.voice, targetMidi);
                  if (!pick) continue;
                  const arpEnv = voiceEnvelope(ev.voice);
                  void triggerSample(pick.path, {
                    gain: ev.velocity * pick.voiceGain * trackGain,
                    pan,
                    pitch: pick.pitch,
                    outFirst: out?.firstChannel ?? 0,
                    outStereo: out?.stereo ?? true,
                    trackId: ev.trackId,
                    delaySecs,
                    // Force monophonic per arp tone — same reasoning as
                    // the web branch below: new tones choke the prior
                    // tail so the line reads as an arp, not a strum.
                    monophonic: true,
                    section: sectionCode(ev.section),
                    // Per-arp-tone hold = sub-step duration × gate.
                    // Envelope follows the voice's configured shape.
                    envelopeAttack: arpEnv?.attack,
                    envelopeDecay: arpEnv?.decay,
                    envelopeSustain: arpEnv?.sustain,
                    envelopeRelease: arpEnv?.release,
                    envelopeHold: arpEnv ? ev.gate * sub : undefined,
                  });
                }
              } else {
                for (let i = 0; i < n; i++) {
                  samplePlayer.trigger(
                    ev.voice,
                    ev.when + i * sub,
                    ev.velocity,
                    ev.midi,
                    ev.gate,
                    sub,
                    [ev.voiceIntervals[i]],
                    ev.pan,
                    ev.trackId,
                    // Force monophonic per arp tone so each new note chokes
                    // the previous one's natural decay. Without this,
                    // sample releases overlap and it feels like a strum,
                    // not an arp.
                    true,
                    ev.section,
                  );
                }
              }
            } else if (isNativeAudioAvailable()) {
              // Native-only audio path (Tauri build). Multi-tone triggers
              // fire one native voice per interval — all simultaneous
              // (a chord). delaySecs = ev.when - audioContext.currentTime
              // lets the Rust callback dispatch sample-accurately, so
              // the trigger no longer fires the moment the IPC arrives
              // (which was ~25-100 ms early from the JS lookahead).
              const intervals =
                ev.voiceIntervals && ev.voiceIntervals.length > 0
                  ? ev.voiceIntervals
                  : [0];
              const out = evTrack?.output;
              const pan = ((ev.pan ?? 0.5) - 0.5) * 2;
              const trackGain = evTrack?.gain ?? 1;
              const delaySecs = Math.max(0, ev.when - getAudioContext().currentTime);
              const env = voiceEnvelope(ev.voice);
              const holdSecs = env ? ev.gate * ev.stepDuration : undefined;
              for (const interval of intervals) {
                const targetMidi =
                  ev.midi !== undefined ? ev.midi + interval : undefined;
                const pick = samplePlayer.pickNativeSample(ev.voice, targetMidi);
                if (!pick) continue;
                void triggerSample(pick.path, {
                  gain: ev.velocity * pick.voiceGain * trackGain,
                  pan,
                  pitch: pick.pitch,
                  outFirst: out?.firstChannel ?? 0,
                  outStereo: out?.stereo ?? true,
                  trackId: ev.trackId,
                  delaySecs,
                  // Web path uses `ev.monophonic` (carried through from
                  // the engine event) — mirror that for native so bass /
                  // lead tracks marked monophonic actually choke.
                  monophonic: ev.monophonic === true,
                  section: sectionCode(ev.section),
                  // Voice ADSR + hold = gate × stepDuration (matches the
                  // web `samplePlayer.trigger` envelope). Voices without
                  // an envelope config (drums, leads) pass nothing here
                  // and run at flat gain in native.
                  envelopeAttack: env?.attack,
                  envelopeDecay: env?.decay,
                  envelopeSustain: env?.sustain,
                  envelopeRelease: env?.release,
                  envelopeHold: holdSecs,
                });
              }
            } else {
              // Web build — original Web Audio path.
              samplePlayer.trigger(
                ev.voice,
                ev.when,
                ev.velocity,
                ev.midi,
                ev.gate,
                ev.stepDuration,
                ev.voiceIntervals,
                ev.pan,
                ev.trackId,
                ev.monophonic,
                ev.section,
              );
            }
            break;
          }
        }
      }
    });
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
  }, [bpm]);

  // Auto-open the native cpal device on app launch using persisted
  // settings (device + channels + SR + buffer from localStorage). On
  // first launch or after a device is unplugged, falls back to the
  // system default. Non-fatal on failure — user can still pick a
  // device in Settings → native audio.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
    void initNativeAudio();
    // Bridge the store's armed+playing edge to the native recorder's
    // start/stop IPCs. Web build keeps its own subscriber (inside
    // webChain) so this stays Tauri-only.
    void import('./audio/nativeRecorder').then((m) => m.subscribeNativeRecorder());
  }, []);

  // Push mix-routing changes (multi_out, fxOutput, fxBypass) on every
  // store edit. Discrete state — no modulation — so a store.subscribe
  // beats folding it into the RAF loop. Initial pass fires the current
  // state to the engine right after device open.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
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
  }, []);

  // Phase 6: push raw BASE values to the native engine every animation
  // frame. The LFO compute lives Rust-side now (see audio.rs LfoEngine
  // section) — the audio thread reads its own snapshot and overwrites
  // each routed destination's `_eff` atomic per block. This loop is
  // just the user-knob → Rust bridge for hand-edits / non-LFO moves.
  //
  // Thresholds prevent floating-point noise from generating no-op
  // pushes when nothing's actually moving. Gated on bootDone so the
  // loop doesn't start before tracks settle.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
    if (!bootDone) return;
    const lastTrack = new Map<
      string,
      { cutoffNorm: number; resonance: number; fxSend: number }
    >();
    let lastReverb: {
      size: number;
      wetGain: number;
      diffusion: number;
      damping: number;
    } | null = null;
    let lastSaturation: { preDrive: number } | null = null;
    let lastTape: {
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
    } | null = null;
    let lastGlitchMix: number | null = null;
    let lastMaster: {
      input: number;
      loCut: number;
      hiCut: number;
      trim: number;
    } | null = null;
    let lastMasterComp: {
      amount: number;
      attackIdx: number;
      releaseIdx: number;
    } | null = null;
    let lastMasterDist: {
      mode: number;
      drive: number;
      bias: number;
      mix: number;
    } | null = null;
    let lastMasterGate: {
      enabled: boolean;
      threshold: number;
    } | null = null;
    let lastMasterBypass: boolean | null = null;
    let raf = 0;
    const tick = () => {
      const state = useSequencerStore.getState();

      // Per-track DSP bases (filter + fx send). Phase 6: cutoff travels
      // as normalized 0..1 so the Rust LFO compute matches the web
      // modulator's space. Resonance + fxSend already are.
      const updates: TrackFilterUpdate[] = [];
      for (const t of state.tracks) {
        const cutoffNorm = t.filterCutoff;
        const resonance = t.filterResonance;
        const fxSend = t.fxSend;
        const last = lastTrack.get(t.id);
        const changed =
          !last ||
          Math.abs(last.cutoffNorm - cutoffNorm) > 0.0005 ||
          Math.abs(last.resonance - resonance) > 0.001 ||
          Math.abs(last.fxSend - fxSend) > 0.001;
        if (changed) {
          updates.push({ trackId: t.id, cutoffNorm, resonance, fxSend });
          lastTrack.set(t.id, { cutoffNorm, resonance, fxSend });
        }
      }
      if (updates.length > 0) void setTrackFiltersBulk(updates);

      // Global reverb base. Store's `mix` is reinterpreted as the
      // post-reverb wet bus gain on the native side (DSP's internal
      // crossfade pinned to fully-wet; per-voice fxSend carries the
      // dry/wet split per track).
      const rv = state.reverb;
      const size = rv.size;
      const wetGain = rv.mix;
      const diffusion = rv.diffusion;
      const damping = rv.damping;
      const reverbChanged =
        !lastReverb ||
        Math.abs(lastReverb.size - size) > 0.001 ||
        Math.abs(lastReverb.wetGain - wetGain) > 0.001 ||
        Math.abs(lastReverb.diffusion - diffusion) > 0.001 ||
        Math.abs(lastReverb.damping - damping) > 0.001;
      if (reverbChanged) {
        lastReverb = { size, wetGain, diffusion, damping };
        void setReverbParams({ size, wetGain, diffusion, damping });
      }

      // Pre-saturation drive (base). Drive at 0 is a true no-op in
      // the FX bus, so a separate bypass toggle would only duplicate
      // the knob's already-pinned-down zero.
      const preDrive = state.saturation.preDrive;
      const satChanged =
        !lastSaturation ||
        Math.abs(lastSaturation.preDrive - preDrive) > 0.001;
      if (satChanged) {
        lastSaturation = { preDrive };
        void setSaturationParams({ preDrive });
      }

      // Glitch mix base. `chance` drives the beat-fire dice roll in
      // the scheduler subscriber below; the engine just receives
      // one-shot fire commands.
      const glitchMix = state.glitch.mix;
      if (lastGlitchMix === null || Math.abs(lastGlitchMix - glitchMix) > 0.001) {
        lastGlitchMix = glitchMix;
        void setGlitchParams({ mix: glitchMix });
      }

      // Master stage filters (phase 7e-1) — bases. loCut is an integer
      // index, the others are 0..1 norms.
      const masterInput = state.master.input;
      const masterHiCut = state.master.hiCut;
      const masterTrim = state.master.trim;
      const masterLoCut = state.master.loCut;
      const masterChanged =
        !lastMaster ||
        Math.abs(lastMaster.input - masterInput) > 0.001 ||
        Math.abs(lastMaster.hiCut - masterHiCut) > 0.001 ||
        Math.abs(lastMaster.trim - masterTrim) > 0.001 ||
        lastMaster.loCut !== masterLoCut;
      if (masterChanged) {
        lastMaster = {
          input: masterInput,
          loCut: masterLoCut,
          hiCut: masterHiCut,
          trim: masterTrim,
        };
        void setMasterFilters({
          input: masterInput,
          loCut: masterLoCut,
          hiCut: masterHiCut,
          trim: masterTrim,
        });
      }

      // Master compressor (phase 7e-2). `amount` is the LFO-routable
      // base; attack/release are discrete selector positions.
      const masterCompAmount = state.master.comp;
      const masterCompAttack = state.master.compAttack;
      const masterCompRelease = state.master.compRelease;
      const masterCompChanged =
        !lastMasterComp ||
        Math.abs(lastMasterComp.amount - masterCompAmount) > 0.001 ||
        lastMasterComp.attackIdx !== masterCompAttack ||
        lastMasterComp.releaseIdx !== masterCompRelease;
      if (masterCompChanged) {
        lastMasterComp = {
          amount: masterCompAmount,
          attackIdx: masterCompAttack,
          releaseIdx: masterCompRelease,
        };
        void setMasterComp({
          amount: masterCompAmount,
          attackIdx: masterCompAttack,
          releaseIdx: masterCompRelease,
        });
      }

      // Master distortion (phase 7e-3) — bases. Bias travels in its
      // natural 0..0.2 range; Rust LFO compute normalizes per the
      // `bias/0.2 → modulate → ×0.2` pattern.
      const masterDistMode = state.master.mode;
      const masterDistDrive = state.master.drive;
      const masterDistBias = state.master.bias;
      const masterDistMix = state.master.mix;
      const masterDistChanged =
        !lastMasterDist ||
        lastMasterDist.mode !== masterDistMode ||
        Math.abs(lastMasterDist.drive - masterDistDrive) > 0.001 ||
        Math.abs(lastMasterDist.bias - masterDistBias) > 0.0005 ||
        Math.abs(lastMasterDist.mix - masterDistMix) > 0.001;
      if (masterDistChanged) {
        lastMasterDist = {
          mode: masterDistMode,
          drive: masterDistDrive,
          bias: masterDistBias,
          mix: masterDistMix,
        };
        void setMasterDist({
          mode: masterDistMode,
          drive: masterDistDrive,
          bias: masterDistBias,
          mix: masterDistMix,
        });
      }

      // Master gate (phase 7e-4) — bases.
      const masterGateEnabled = state.master.gateEnabled;
      const masterGateThreshold = state.master.gateThreshold;
      const masterGateChanged =
        !lastMasterGate ||
        lastMasterGate.enabled !== masterGateEnabled ||
        Math.abs(lastMasterGate.threshold - masterGateThreshold) > 0.001;
      if (masterGateChanged) {
        lastMasterGate = {
          enabled: masterGateEnabled,
          threshold: masterGateThreshold,
        };
        void setMasterGate({
          enabled: masterGateEnabled,
          threshold: masterGateThreshold,
        });
      }

      // Master full-unit bypass (phase 7e-5). Discrete toggle, no
      // modulation — Rust handles the smooth crossfade internally.
      const masterBypass = state.master.bypass;
      if (lastMasterBypass !== masterBypass) {
        lastMasterBypass = masterBypass;
        void setMasterBypass(masterBypass);
      }

      // Tape (full bed + grains) — bases. Stretch knobs are 0..1 in
      // store; map to 0.25..4 playback rate the same way web tape.ts
      // does. Stretch/gain/reverse/hold aren't LFO-modulated, so no
      // base/effective split Rust-side.
      const tape = state.tape;
      const tapePosition = tape.position;
      const tapeLength = tape.length;
      const tapeMix = tape.mix;
      const tapeStretch1 = Math.pow(2, (tape.stretch1 - 0.5) * 4);
      const tapeStretch2 = Math.pow(2, (tape.stretch2 - 0.5) * 4);
      const tapeGain1 = tape.gain1;
      const tapeGain2 = tape.gain2;
      const tapeReverse = tape.reverse;
      const tapeHold = tape.hold;
      const tapeGrainRate = tape.grainRate;
      const tapeGrainMix = tape.grainMix;
      const tapeChanged =
        !lastTape ||
        Math.abs(lastTape.position - tapePosition) > 0.001 ||
        Math.abs(lastTape.length - tapeLength) > 0.001 ||
        Math.abs(lastTape.stretch1 - tapeStretch1) > 0.001 ||
        Math.abs(lastTape.gain1 - tapeGain1) > 0.001 ||
        Math.abs(lastTape.stretch2 - tapeStretch2) > 0.001 ||
        Math.abs(lastTape.gain2 - tapeGain2) > 0.001 ||
        Math.abs(lastTape.mix - tapeMix) > 0.001 ||
        lastTape.reverse !== tapeReverse ||
        lastTape.hold !== tapeHold ||
        Math.abs(lastTape.grainRate - tapeGrainRate) > 0.001 ||
        Math.abs(lastTape.grainMix - tapeGrainMix) > 0.001;
      if (tapeChanged) {
        lastTape = {
          position: tapePosition,
          length: tapeLength,
          stretch1: tapeStretch1,
          gain1: tapeGain1,
          stretch2: tapeStretch2,
          gain2: tapeGain2,
          mix: tapeMix,
          reverse: tapeReverse,
          hold: tapeHold,
          grainRate: tapeGrainRate,
          grainMix: tapeGrainMix,
        };
        void setTapeParams({
          position: tapePosition,
          length: tapeLength,
          stretch1: tapeStretch1,
          gain1: tapeGain1,
          stretch2: tapeStretch2,
          gain2: tapeGain2,
          mix: tapeMix,
          reverse: tapeReverse,
          hold: tapeHold,
          grainRate: tapeGrainRate,
          grainMix: tapeGrainMix,
        });
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bootDone]);

  // Phase 6 — push LFO panel state to the Rust audio thread on change.
  // The audio-thread compute reads its own snapshot of (rate / depth /
  // destinations) per block; only the IPC fires here, at user-event
  // rate, not RAF rate. JS still owns LFO compute for the destinations
  // that aren't audio params (mutation / motion / drift / chaos /
  // tension / rowRatchet / glitchChance / etc. — handled inline above
  // via the JS `modulated()` helper).
  //
  // We translate the web LFO type to the native shape: per-track
  // destinations carry `trackId`, globals omit it. Knobs that don't
  // map to a Rust destination (JS-only sequencer logic) get filtered.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
    if (!bootDone) return;
    const KNOB_MAP: Partial<Record<string, LfoDestKind>> = {
      filterCutoff: 'trackFilterCutoff',
      filterResonance: 'trackFilterResonance',
      fxSend: 'trackFxSend',
      reverbSize: 'reverbSize',
      reverbMix: 'reverbMix',
      reverbDiffusion: 'reverbDiffusion',
      reverbDamping: 'reverbDamping',
      preSaturationDrive: 'preSaturationDrive',
      glitchMix: 'glitchMix',
      tapePosition: 'tapePosition',
      tapeLength: 'tapeLength',
      tapeMix: 'tapeMix',
      tapeGrainRate: 'tapeGrainRate',
      tapeGrainMix: 'tapeGrainMix',
      masterInput: 'masterInput',
      masterHiCut: 'masterHiCut',
      masterTrim: 'masterTrim',
      masterComp: 'masterComp',
      masterDrive: 'masterDrive',
      masterBias: 'masterBias',
      masterMix: 'masterMix',
      masterGateThreshold: 'masterGateThreshold',
    };
    const push = () => {
      const lfos = useSequencerStore.getState().lfos;
      const payload: NativeLfo[] = lfos.map((lfo) => {
        const destinations: { knob: LfoDestKind; trackId?: string }[] = [];
        for (const d of lfo.destinations) {
          const native = KNOB_MAP[d.knob];
          if (!native) continue;
          // Per-track destinations carry trackId; globals don't.
          // GLOBAL_TRACK_ID is the sentinel for global routings.
          if (
            native === 'trackFilterCutoff' ||
            native === 'trackFilterResonance' ||
            native === 'trackFxSend'
          ) {
            if (d.trackId === GLOBAL_TRACK_ID) continue;
            destinations.push({ knob: native, trackId: d.trackId });
          } else {
            destinations.push({ knob: native });
          }
        }
        return {
          id: lfo.id,
          rate: lfo.rate,
          depth: lfo.depth,
          destinations,
        };
      });
      void setLfos(payload);
    };
    // Initial push so the audio thread has the current state at boot.
    push();
    // Subscribe to ALL store changes; only re-push when `lfos` ref
    // changes (reducer updates with structural copy → new ref). This
    // catches rate / depth / destination edits without per-frame churn.
    let prevLfos = useSequencerStore.getState().lfos;
    const unsub = useSequencerStore.subscribe((state) => {
      if (state.lfos !== prevLfos) {
        prevLfos = state.lfos;
        push();
      }
    });
    return () => unsub();
  }, [bootDone]);

  // Glitch beat-fire dice roll. The scheduler ticks at 32nds
  // (stepsPerBeat=8), so beat boundaries are `stepIndex % 8 === 0`.
  // On each beat we roll `state.glitch.chance` (LFO-modulated via
  // `glitchChance`) and fire via IPC on a hit. The Rust glitch stage
  // is otherwise pass-through. Mirrors `audio/glitch.ts`'s web setup
  // but skips the `setTimeout` align — beat-level alignment with one
  // block of latency is imperceptible against the stutter character.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
    const unsub = scheduler.onStep((stepIndex) => {
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
      void fireGlitch();
    });
    return unsub;
  }, []);

  // Preload sample paths into the native cpal registry for every voice
  // track in state. Idempotent (Rust caches by path). Without preload,
  // the first trigger on a freshly-assigned voice incurs invoke + WAV-
  // decode latency on the audio path and lands as an audible click
  // delay. Tauri-only — the web build skips this entirely.
  //
  // Gated on `bootDone` because samplePlayer.voices is empty until kit
  // manifests resolve. Once bootDone flips, the initial pass fires with
  // voices populated; the subscription stays live for source swaps.
  //
  // The pass is staged carefully to avoid hanging the UI:
  //   1. De-dupe by voice id (multiple tracks share voices — we don't
  //      want to fire the same preload twice).
  //   2. Defer the initial pass via setTimeout(0) so React gets to
  //      paint the post-splash UI BEFORE we start the IPC pile-up.
  //   3. Serialize voices through a small queue (one voice at a time);
  //      each voice's preloadNativeForVoice still parallelizes its own
  //      paths internally via Promise.allSettled. This caps the wave
  //      of concurrent fetch+IPC calls hitting the audio thread.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
    if (!bootDone) return;

    const queue: string[] = [];
    let draining = false;
    let cancelled = false;

    const drain = async () => {
      if (draining || cancelled) return;
      draining = true;
      while (queue.length > 0 && !cancelled) {
        const voiceId = queue.shift()!;
        try {
          await samplePlayer.preloadNativeForVoice(voiceId);
        } catch (err) {
          console.warn('[nativeAudio] preload failed for', voiceId, err);
        }
      }
      draining = false;
    };

    const enqueue = (voiceId: string) => {
      if (queue.includes(voiceId)) return;
      queue.push(voiceId);
      void drain();
    };

    // 100 ms gap (not just setTimeout(0)) so React's first paint of the
    // post-splash UI lands and the browser does its initial layout
    // before we start the preload pile-up. Without this gap the
    // synchronous bytes-encoding work for the first few files races
    // the first paint and the user sees the splash sit at 18/18.
    const initialHandle = setTimeout(() => {
      const unique = new Set<string>();
      for (const t of useSequencerStore.getState().tracks) {
        if (t.source.kind === 'voice') unique.add(t.source.id);
      }
      console.info(
        `[nativeAudio] preload start: ${unique.size} unique voice(s)`,
      );
      const startedAt = performance.now();
      const onComplete = () => {
        const ms = (performance.now() - startedAt).toFixed(0);
        console.info(`[nativeAudio] preload finished in ${ms} ms`);
      };
      // Wrap the queue's drain to report completion. drain() is the
      // shared loop; we patch the cancelled flag check so when the
      // queue empties we log once.
      for (const v of unique) enqueue(v);
      // Poll for completion (cheap — once per 250 ms while draining).
      const waitDone = setInterval(() => {
        if (cancelled) {
          clearInterval(waitDone);
          return;
        }
        if (queue.length === 0 && !draining) {
          clearInterval(waitDone);
          onComplete();
        }
      }, 250);
    }, 100);

    const unsubscribe = useSequencerStore.subscribe((state, prev) => {
      const prevById = new Map(prev.tracks.map((t) => [t.id, t] as const));
      for (const cur of state.tracks) {
        if (cur.source.kind !== 'voice') continue;
        const prv = prevById.get(cur.id);
        const sourceChanged =
          !prv ||
          prv.source.kind !== 'voice' ||
          prv.source.id !== cur.source.id;
        if (sourceChanged) enqueue(cur.source.id);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(initialHandle);
      unsubscribe();
    };
  }, [bootDone]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
        return;
      }

      const lower = e.key.toLowerCase();
      const mode = MODE_KEYS[lower];
      if (mode) {
        e.preventDefault();
        useSequencerStore.getState().setEditMode(mode);
        return;
      }

      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const store = useSequencerStore.getState();
      const sel = store.selectedStep;
      if (!sel) return;
      const track = store.tracks.find((t) => t.id === sel.trackId);
      const step = track?.steps[sel.index];
      if (!track || !step?.on) return;
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const editMode = store.editMode;
      if (editMode === 'velocity') {
        store.setStepVelocity(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(1, step.velocity + 0.05 * dir))
        );
      } else if (editMode === 'chance') {
        store.setStepProbability(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(100, step.probability + 5 * dir))
        );
      } else if (editMode === 'ratchet') {
        store.setStepRatchet(
          sel.trackId,
          sel.index,
          Math.max(1, Math.min(8, step.ratchet + dir))
        );
      } else if (editMode === 'timing') {
        store.setStepMicroTiming(
          sel.trackId,
          sel.index,
          Math.max(-0.5, Math.min(0.5, step.microTiming + 0.05 * dir))
        );
      } else if (editMode === 'gate') {
        store.setStepGate(
          sel.trackId,
          sel.index,
          Math.max(0.1, Math.min(2, step.gate + 0.05 * dir))
        );
      } else if (editMode === 'live' && sourceIsMelodic(track.source)) {
        // Walk the chord degree when this step is actually playing a chord
        // at dispatch: chord master (always reads voicing) OR a 'semitones'
        // follower whose effective voicing has degree > 0 (an authored chord
        // override). Other follower modes (chord-tone / root-follow /
        // scale-tone) ignore stepVoicing at dispatch, so walking degree
        // there would be silent — fall through to pitch instead.
        // Extension/inversion/spread stay mouse-only in the inspector.
        const isChordMaster =
          store.tracks.find((t) => t.section === 'melodic')?.id === track.id;
        const voicing = step.chordVoicing ?? track.defaultChordVoicing;
        const walkDegree =
          isChordMaster ||
          (track.pitchInterp === 'semitones' && voicing.degree > 0);
        if (walkDegree) {
          const nextDegree = Math.max(0, Math.min(7, voicing.degree + dir)) as ChordDegree;
          if (nextDegree !== voicing.degree) {
            store.setStepChordVoicing(sel.trackId, sel.index, {
              ...voicing,
              degree: nextDegree,
            });
          }
        } else {
          store.setStepPitch(
            sel.trackId,
            sel.index,
            Math.max(-14, Math.min(14, step.pitch + dir))
          );
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="relative w-full">
      {!bootDone && (
        <SamplesSplash loaded={samplesLoaded} total={samplesTotal} />
      )}
      <main
        className={
          NATIVE
            ? 'min-h-screen flex items-center justify-center px-4 py-4'
            : 'min-h-screen flex items-center justify-center px-10 py-12'
        }
      >
        <div
          className={
            NATIVE
              ? 'flex flex-col gap-6'
              : 'flex flex-col gap-8 border border-white/15 rounded-[20px] p-10'
          }
        >
          <div className="flex justify-between items-center gap-8">
            <div className="flex items-center gap-2">
              <span className="text-[12px] uppercase tracking-[0.12em] opacity-55">
                {NATIVE ? (
                  <>newspeech <span className="opacity-50">|</span> sequence</>
                ) : (
                  <>
                    <a href="/" className="hover:opacity-100 transition-opacity">newspeech</a>
                    <span className="opacity-50"> | </span>
                    <span>sequence</span>
                    <span className="opacity-50"> | </span>
                    <a href="/sequencer-readme.html" className="hover:opacity-100 transition-opacity">readme.txt</a>
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                title="settings"
                aria-label="settings"
                style={{ width: 20, height: 20 }}
                className="bg-transparent border border-white/15 hover:border-white/50 transition-colors inline-flex items-center justify-center"
              >
                <svg viewBox="0 0 14 14" width="12" height="12">
                  <circle cx="3" cy="7" r="1" fill="white" fillOpacity="0.6" />
                  <circle cx="7" cy="7" r="1" fill="white" fillOpacity="0.6" />
                  <circle cx="11" cy="7" r="1" fill="white" fillOpacity="0.6" />
                </svg>
              </button>
            </div>
            <GhostDebug />
            <MacroStrip />
          </div>
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <div className="flex justify-between items-start gap-8">
            <div className="flex flex-row items-start gap-3">
              <Scope />
              <StepInspector />
            </div>
            <LFOPanel />
          </div>
          <div className="flex justify-between items-center gap-8 -my-4">
            <div className="flex items-center gap-2">
              <InitButton />
              <PerformanceButton />
            </div>
            <div className="flex items-center gap-8">
              <ScenePad />
              <BankPad />
            </div>
          </div>
          <TrackGrid />
          <div className="transport flex flex-col items-stretch gap-3">
            <div className="flex items-center justify-between gap-8">
              <div className="flex items-center gap-3">
                <PlayButton />
                <RecordButton />
                <CountInButton />
                <RawRecordButton />
                <SplitsButton />
              </div>
              <div className="flex items-center gap-4">
                <SectionToggle />
                <span className="w-px h-6 bg-white/15" />
                <ModeSwitcher />
              </div>
            </div>
            <div className="flex items-center gap-8 flex-wrap">
              <TransportControls />
              <GhostPanel />
            </div>
          </div>
          <FXPanel />
        </div>
      </main>
      <Toasts />
    </div>
  );
}
