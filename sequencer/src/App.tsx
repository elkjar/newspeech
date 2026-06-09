import { useEffect, useState } from 'react';
import { PlayButton, RecordButton, CountInButton, MetronomeButton, RawRecordButton, SplitsButton, TransportControls, InitButton, SaveSongButton } from './components/Transport';
import { PerformanceButton } from './components/PerformanceDialog';
import { initAudioOutputs } from './audio/audioOutput';
import { SettingsDialog } from './components/SettingsDialog';
import { TrackGrid } from './components/TrackGrid';
import { ChannelScreen, ScreenModeTabs } from './components/ChannelScreen';
import { MacroStrip } from './components/MacroStrip';
import { Toasts } from './components/Toasts';
import { BankPad } from './components/BankPad';
import { ScenePad } from './components/ScenePad';
import { GhostPanel } from './components/GhostPanel';
import {
  useSequencerStore,
  type EditMode,
  type TrackSection,
  type TrackOutput,
} from './state/store';
import { scheduler } from './audio/scheduler';
import { emitClockForStep, setClockBpm } from './audio/midiClock';
import { samplePlayer } from './audio/samplePlayer';
import { voiceEnvelope, voiceRole } from './audio/voices';

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
  releaseNote,
  repitchNote,
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
  freezeVoiceParams,
  type TrackFilterUpdate,
  type NativeLfo,
  type LfoDestKind,
} from './audio/nativeEngine';
import { getAudioContext } from './audio/audioContext';
import {
  allocRevoiceNoteId,
  registerChord,
  clearAllChords,
  soundingChords,
  targetMidisFor,
  diffChord,
  type ChordToneVoice,
} from './audio/voicingRevoice';
import {
  initMIDIOut,
  sendMIDINote,
  sendMIDIControlChange,
  resolveDeviceId,
  getMIDIOutputs,
  onMIDIOutputsChanged,
} from './audio/midiOut';
import { initMIDIIn, getConnectedInputNames, onMIDIInputsChanged } from './midi/midiIn';
import { dispatchMidi } from './midi/midiMap';
import { loadMidiMapLibrary } from './midi/midiMapLoader';
import {
  disconnectAll as disconnectLaunchpads,
  findAllLaunchpadPorts,
  getConnectedCount,
  getConnectedInputPorts,
  syncLaunchpads,
} from './midi/launchpad';
import { attachLaunchpadBindings, detachLaunchpadBindings } from './midi/launchpadBindings';
import {
  connectXL3,
  disconnectXL3,
  findXL3Ports,
  getXL3Port,
  isXL3Connected,
} from './midi/launchControlXL3';
import { attachXL3Bindings, detachXL3Bindings } from './midi/launchControlXL3Bindings';
import { octaveDegrees } from './audio/scale';
import { sourceIsMelodic } from './instruments/library';
import {
  emitStreamEvents,
  initStreamPresenceMain,
  isStreamListenerActive,
  type StreamEvent,
} from './stream/streamEvents';
import { registerKit, type SampleKitEntry, type ExtendedSampleManifest } from './instruments/manifestRegistry';
import { scanAndLoadUserSamples } from './instruments/userSamplesDir';
import { tickPadDrift } from './audio/padState';
import { consumeBranchLeaf } from './audio/treeState';
import { consumeStepAccRung, consumeAutoMutationRung } from './audio/accumulator';
import type { ChordDegree } from './audio/chords';
import { getChordContext, setChordContext } from './audio/chordContext';
import { getOverlay, setOverlay, attachChordToOverlay } from './audio/mutationOverlay';
import { runTick } from './engine/tick';
import { modulated, GLOBAL_TRACK_ID } from './audio/lfo';
import { makeHarmonicMotionState, tickHarmonicMotion } from './audio/harmonicMotion';
import { togglePlayback } from './audio/transport';
import { scheduleWebClick } from './audio/clickIn';
import {
  initGhost,
  tickBar as ghostTickBar,
  beforeBarCommit as ghostBeforeBarCommit,
  getGhostLeadMutation,
} from './ghost/ghost';
import { autoSeedBanks } from './ghost/generator';
import { computeBankEntropy } from './ghost/entropy';
import { phaseAt, targetEntropy as computeTargetEntropy } from './ghost/shape';
import { isTauri, invoke } from '@tauri-apps/api/core';

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
// Display labels — the 'live' literal is kept for persistence compatibility,
// but the mode now shows the static authored pattern, so it reads as "notes".
const MODE_LABELS: Record<EditMode, string> = {
  live: 'notes',
  velocity: 'velocity',
  chance: 'chance',
  ratchet: 'ratchet',
  timing: 'timing',
  gate: 'gate',
};

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
          {MODE_LABELS[m]}
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

  // Track whether the stream window is mounted. Gates emitStreamEvents
  // and the 10Hz snapshot so the audio dispatcher isn't paying Tauri
  // IPC serialization cost when nobody's listening.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void initStreamPresenceMain().then((fn) => {
      cleanup = fn;
    });
    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const harmonic = makeHarmonicMotionState();
    return scheduler.onStep('app:dispatcher', (globalStep, when, stepDuration) => {
      // Bar boundary at 4/4 32nd resolution = every 32 global steps. A queued
      // pattern recall commits here, before we read `tracks` for this tick,
      // so the swap is atomic from the dispatch's point of view. Ghost
      // ordering: beforeBarCommit snapshots current macros as lerp source
      // BEFORE commit overwrites them; tickBar runs AFTER commit so it sees
      // the just-swapped activeBank as the lerp target.
      if (globalStep % 32 === 0) {
        // Snapshot the active bank/scene/song BEFORE any commit so we can
        // tell afterward whether a swap landed this bar. A swap means the
        // about-to-be-pushed new track params would otherwise retune the
        // outgoing scene's still-ringing tails — so we freeze them first.
        const preSwap = useSequencerStore.getState();
        const preBank = preSwap.activeBank;
        const preScene = preSwap.composition.activeScene;
        const preSong = preSwap.performance.activeSong;
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
        // If a bank/scene/song swap landed this bar, freeze the outgoing
        // scene's in-flight voice tails at their current DSP settings so
        // the new scene's params (pushed by the RAF a frame later) can't
        // retune them — a resonance jump on a ringing tail self-oscillates
        // into a crash. Fires before the new triggers below (which start
        // unfrozen on the new scene's settings).
        if (isNativeAudioAvailable()) {
          const postSwap = useSequencerStore.getState();
          if (
            postSwap.activeBank !== preBank ||
            postSwap.composition.activeScene !== preScene ||
            postSwap.performance.activeSong !== preSong
          ) {
            void freezeVoiceParams();
          }
        }
      }
      const state = useSequencerStore.getState();
      // Universal metronome — same click voice as the count-in, on every beat
      // for as long as transport runs (independent of pattern content, so it
      // ticks through tail-out and empty banks too). 32 steps/bar → 8 per beat.
      // Constant click, no downbeat accent (just a steady pulse to play to).
      // Native fires SECTION_NONE so the click plays out the cue/main output
      // but stays OUT of recording stems (the count-in, SECTION_CLICK, is
      // intentionally captured — the metronome is not).
      if (state.metronome && globalStep % 8 === 0) {
        if (isNativeAudioAvailable()) {
          const delaySecs = Math.max(0, when - getAudioContext().currentTime);
          const out = state.nativeMix.metronomeOutput;
          void triggerSample('__click_beat', {
            gain: 1.0,
            delaySecs,
            section: 0,
            // Mono cue channel when multi-out is ON; the engine folds to 1-2
            // when it's OFF (same as every other voice).
            outFirst: out.firstChannel,
            outStereo: false,
          });
        } else {
          scheduleWebClick(when, false);
        }
      }
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
              voicing: state.voicing,
              freeze: state.freeze,
              ghostLeadMutation: getGhostLeadMutation,
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
              consumeBranchLeaf,
              consumeStepAccRung,
              consumeAutoMutationRung,
            },
          );
      const streamBatch: StreamEvent[] = [];
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
              sendMIDINote(
                deviceId,
                ev.channel,
                ev.note,
                ev.velocity,
                ev.when,
                ev.durationS,
              );
            }
            break;
          }
          case 'sample': {
            streamBatch.push({
              kind: 'step',
              voice: ev.voice,
              velocity: ev.velocity,
            });
            // Arpeggiator transformation — when on AND the trigger carries
            // multiple chord intervals, split into N sequential single-tone
            // triggers spread evenly across the step. Single-note triggers
            // are passed through unchanged. v1: "up" pattern only (intervals
            // played in their natural order); pattern/rate/range selection
            // deferred per [[project_arp_mode]].
            const evTrack = state.tracks.find((t) => t.id === ev.trackId);
            // Texture voices fade on transport stop rather than cutting —
            // flag the native voice so the StopFade path can target them.
            const isTexture = voiceRole(ev.voice) === 'texture';
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
                    isTexture,
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
              // Melodic voices honor note length even without a hand-authored
              // ADSR: mirror the live monitor (which releases the voice on
              // key-up) by synthesizing a gate-driven hold + short release.
              // This is what makes a recorded note's length actually sound —
              // a flat sample otherwise plays full regardless of gate. Drums
              // stay one-shots (full sample); voices with an explicit envelope
              // keep it.
              const playEnv =
                voiceEnvelope(ev.voice) ??
                (ev.section === 'melodic' ? { attack: 0.003, release: 0.05 } : undefined);
              const holdSecs = playEnv ? ev.gate * ev.stepDuration : undefined;
              // Sustaining chord-master triggers carry a `revoice` context — tag
              // each chord tone with a note_id and register the sounding chord so
              // the voicing-macro loop (below) can re-voice it while it rings.
              const reVoiceable = ev.revoice !== undefined;
              const tones: ChordToneVoice[] = [];
              for (const interval of intervals) {
                const targetMidi =
                  ev.midi !== undefined ? ev.midi + interval : undefined;
                const pick = samplePlayer.pickNativeSample(ev.voice, targetMidi);
                if (!pick) continue;
                const noteId =
                  reVoiceable && targetMidi !== undefined
                    ? allocRevoiceNoteId()
                    : undefined;
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
                  isTexture,
                  // Voice ADSR + hold = gate × stepDuration (matches the
                  // web `samplePlayer.trigger` envelope). Voices without
                  // an envelope config (drums, leads) pass nothing here
                  // and run at flat gain in native.
                  envelopeAttack: playEnv?.attack,
                  envelopeDecay: playEnv?.decay,
                  envelopeSustain: playEnv?.sustain,
                  envelopeRelease: playEnv?.release,
                  envelopeHold: holdSecs,
                  noteId,
                });
                if (noteId !== undefined && targetMidi !== undefined) {
                  tones.push({ noteId, midi: targetMidi });
                }
              }
              if (reVoiceable && ev.revoice && tones.length > 0) {
                registerChord({
                  trackId: ev.trackId,
                  voice: ev.voice,
                  authoredVoicing: ev.revoice.authoredVoicing,
                  rootNote: ev.revoice.rootNote,
                  scale: ev.revoice.scale,
                  pitchOffset: ev.revoice.pitchOffset,
                  baseMidi: ev.midi as number,
                  tones,
                  velocity: ev.velocity,
                  trackGain,
                  pan,
                  outFirst: out?.firstChannel ?? 0,
                  outStereo: out?.stereo ?? true,
                  section: sectionCode(ev.section),
                  isTexture,
                  env: playEnv
                    ? {
                        attack: playEnv.attack,
                        decay: playEnv.decay,
                        sustain: playEnv.sustain,
                        release: playEnv.release,
                        hold: holdSecs,
                      }
                    : undefined,
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
      if (streamBatch.length > 0) emitStreamEvents(streamBatch);
    });
  }, []);

  // Live chord re-voicing for the voicing macro (Increment 2). Native only —
  // `repitchNote` has no Web Audio analogue. ~30ms cadence: the macro quantizes
  // into discrete voicing stages, so even under a fast LFO this fires a handful
  // of voice-leading diffs across a sweep, not a stream of micro-edits. Each
  // diff re-pitches the tones that moved (inversion/spread), blooms in added
  // extensions as fresh voices, and fades out removed ones. When nothing has
  // moved the diff is empty and no IPC is issued. See voicingRevoice.ts.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
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
          const pick = samplePlayer.pickNativeSample(chord.voice, midi);
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
          });
          nextTones.push({ noteId, midi });
        }
        chord.tones = nextTones;
      }
    }, 30);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
    // Keep the native clock-master thread's tempo in sync with the transport.
    setClockBpm(bpm);
  }, [bpm]);

  // MIDI clock master: emit the 24-PPQN pulse stream from the scheduler's
  // step callback, where we get each step's exact audio time + duration. A
  // dedicated named subscriber keeps it independent of the main dispatcher and
  // HMR-safe (re-registration evicts the prior one by key). The port + on/off
  // is read live from the store inside emitClockForStep, so changing the
  // clock-out target takes effect without a remount.
  useEffect(() => {
    return scheduler.onStep('app:midi-clock', (_step, when, stepDuration) => {
      emitClockForStep(when, stepDuration);
    });
  }, []);

  // Periodic state snapshot for the stream window. 10Hz matches
  // GhostDebug's DensityTrace sample rate so Datafeed reads identically
  // across the two surfaces. Carries macros + ghost state — Datafeed
  // renders the histogram + shape preview + phase/target from these
  // fields; Visualizer drives its procedural params from macros.
  // Skips entirely when no stream window is listening (computeBankEntropy
  // walks every populated bank slot, not free).
  useEffect(() => {
    const STEPS_PER_BAR = 32;
    const id = window.setInterval(() => {
      if (!isStreamListenerActive()) return;
      const s = useSequencerStore.getState();
      // Per-slot entropy (live recompute matches GhostDebug behaviour).
      const results = s.banks.map((slot) =>
        slot ? computeBankEntropy(slot) : null,
      );
      const populated = results.filter((r): r is NonNullable<typeof r> => r !== null);
      const minE = populated.length > 0 ? Math.min(...populated.map((r) => r.total)) : 0;
      const maxE = populated.length > 0 ? Math.max(...populated.map((r) => r.total)) : 0;
      const active = s.activeBank !== null ? results[s.activeBank] : null;
      const bankSummary = s.banks.map((slot, i) =>
        slot
          ? {
              kind: slot.kind === 'transition' ? ('transition' as const) : ('normal' as const),
              entropy: results[i]?.total ?? 0,
            }
          : null,
      );
      const phase = phaseAt(
        s.globalStep,
        s.ghostCompositionStartStep,
        s.sceneGraph.phaseLength,
        s.sceneGraph.shape,
      );
      const target = computeTargetEntropy(s.sceneGraph.shape, phase, minE, maxE);
      const elapsedBars = Math.max(
        0,
        Math.floor((s.globalStep - s.ghostCompositionStartStep) / STEPS_PER_BAR),
      );
      // Drummer count-in. A queued bank swap (pendingBank) commits on the next
      // bar downbeat — the conductor sets it at the start of the bank's last
      // dwell bar — so while it's pending we're in exactly the bar before the
      // transition. Map the beat within that bar (8 steps/beat → 4 beats) to a
      // 4·3·2·1 count that lands on the downbeat the swap fires.
      const beatInBar = Math.floor((s.globalStep % STEPS_PER_BAR) / 8);
      const transitionCountIn =
        s.pendingBank !== null ? Math.max(1, Math.min(4, 4 - beatInBar)) : null;
      emitStreamEvents([
        {
          kind: 'state',
          density: s.density,
          chaos: s.chaos,
          motion: s.motion,
          drift: s.drift,
          tension: s.tension,
          activeBank: s.activeBank,
          pendingBank: s.pendingBank,
          transitionCountIn,
          shape: s.sceneGraph.shape,
          phaseLength: s.sceneGraph.phaseLength,
          phase,
          targetEntropy: target,
          ghostEnabled: s.sceneGraph.enabled,
          bankOrderMode: s.sceneGraph.bankOrderMode,
          elapsedBars,
          minE,
          maxE,
          bankSummary,
          activeBreakdown: active
            ? {
                total: active.total,
                channels: active.channels,
                voiceType: active.voiceType,
                stepDensity: active.stepDensity,
                mutation: active.mutation,
                polyphony: active.polyphony,
              }
            : null,
        },
      ]);
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  // Performer-interaction emission. Throttled per-key at ~3Hz with a 0.04
  // value-delta floor so a knob sweep produces a handful of meaningful
  // landings rather than a smear of micro-steps. Catches MIDI-CC moves
  // and on-screen drag the same way — both go through the store setter.
  // Covers the highest-impact performance surfaces: macros (global feel),
  // per-track filter cutoff / Q (filter sweeps), per-track mutation rate,
  // and LFO depth. LFO destination assignments emit directly from the
  // store actions (discrete events, no throttle needed).
  useEffect(() => {
    const lastEmit: Record<string, number> = {};
    const lastVal: Record<string, number> = {};
    const MACRO_KEYS = ['density', 'chaos', 'motion', 'drift', 'tension'] as const;

    const check = (
      id: string,
      cur: number,
      prv: number,
      label: string,
      now: number,
      out: Array<{ kind: 'param'; label: string }>
    ) => {
      if (cur === prv) return;
      if (now - (lastEmit[id] ?? 0) < 300) return;
      if (Math.abs(cur - (lastVal[id] ?? -1)) < 0.04) return;
      out.push({ kind: 'param', label: `${label} ${cur.toFixed(2)}` });
      lastEmit[id] = now;
      lastVal[id] = cur;
    };

    return useSequencerStore.subscribe((state, prev) => {
      // Param-change events only feed the stream window — skip the full
      // diff walk when no listener is mounted.
      if (!isStreamListenerActive()) return;
      const now = performance.now();
      const out: Array<{ kind: 'param'; label: string }> = [];

      // Macros
      for (const k of MACRO_KEYS) {
        check(k, state[k], prev[k], k, now, out);
      }

      // Per-track: filter cutoff, filter resonance, mutation
      const tCount = Math.min(state.tracks.length, prev.tracks.length);
      for (let i = 0; i < tCount; i++) {
        const cur = state.tracks[i];
        const prv = prev.tracks[i];
        if (!cur || !prv || cur.id !== prv.id) continue;
        check(`${cur.id}:cutoff`, cur.filterCutoff, prv.filterCutoff, `${cur.id} · cutoff`, now, out);
        check(`${cur.id}:Q`, cur.filterResonance, prv.filterResonance, `${cur.id} · Q`, now, out);
        check(`${cur.id}:mutate`, cur.mutation, prv.mutation, `${cur.id} · mutate`, now, out);
      }

      // LFO depths
      const lCount = Math.min(state.lfos.length, prev.lfos.length);
      for (let i = 0; i < lCount; i++) {
        const cur = state.lfos[i];
        const prv = prev.lfos[i];
        if (!cur || !prv || cur.id !== prv.id) continue;
        check(`lfo:${cur.id}:depth`, cur.depth, prv.depth, `LFO${cur.id} · depth`, now, out);
      }

      if (out.length > 0) emitStreamEvents(out);
    });
  }, []);

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
    // Last CC values (0..127 ints) sent out per instrument track, so we only
    // emit on a real change — dedupes the rAF tick to ≤128 messages per full
    // sweep instead of one per frame. See the instrument-CC block in tick.
    const lastInstrumentCC = new Map<
      string,
      { cutoff: number; res: number; gain: number; pan: number }
    >();
    // Standard MIDI controllers most hardware maps out of the box: CC74/71 =
    // filter cutoff / resonance (Sound Controllers), CC7 = channel volume,
    // CC10 = pan. The per-track gain/pan/filter knobs mirror out as these so
    // they drive the external synth (the knobs are otherwise internal-only).
    const CC_FILTER_CUTOFF = 74;
    const CC_FILTER_RESONANCE = 71;
    const CC_VOLUME = 7;
    const CC_PAN = 10;
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

        // Instrument (external-MIDI) rows: mirror the filter / gain / pan knobs
        // out as CC so they drive the hardware synth (these knobs are otherwise
        // internal-voice-only). We send the LFO-MODULATED value (modulated() ===
        // base when no LFO is routed), so this single path covers manual knob
        // moves, MIDI-mapped (Launch Control XL3), macros, AND automated LFO
        // sweeps. modulated() also honours the hand-override ramp, so a manual
        // grab wins then eases back. Emit only when the 0..127 int changes —
        // caps a sweep at ≤128 messages, not one per frame.
        if (t.source.kind === 'instrument') {
          const deviceId = resolveDeviceId(t.midi.portName, state.midiOutDeviceId);
          if (deviceId) {
            const ch = t.midi.channel;
            const cutoff = Math.round(
              modulated(cutoffNorm, state.lfos, t.id, 'filterCutoff') * 127
            );
            const res = Math.round(
              modulated(resonance, state.lfos, t.id, 'filterResonance') * 127
            );
            const gain = Math.round(modulated(t.gain, state.lfos, t.id, 'gain') * 127);
            // Pan is 0..1 store space (0.5 center) → CC10 0..127 (64 center).
            const pan = Math.round(modulated(t.pan, state.lfos, t.id, 'pan') * 127);
            const lastCC = lastInstrumentCC.get(t.id);
            if (!lastCC || lastCC.cutoff !== cutoff) {
              sendMIDIControlChange(deviceId, ch, CC_FILTER_CUTOFF, cutoff);
            }
            if (!lastCC || lastCC.res !== res) {
              sendMIDIControlChange(deviceId, ch, CC_FILTER_RESONANCE, res);
            }
            if (!lastCC || lastCC.gain !== gain) {
              sendMIDIControlChange(deviceId, ch, CC_VOLUME, gain);
            }
            if (!lastCC || lastCC.pan !== pan) {
              sendMIDIControlChange(deviceId, ch, CC_PAN, pan);
            }
            lastInstrumentCC.set(t.id, { cutoff, res, gain, pan });
          }
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
    const unsub = scheduler.onStep('app:native-glitch', (stepIndex) => {
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
            <div className="flex flex-col gap-4 items-start">
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
              {NATIVE && (
                <button
                  type="button"
                  onClick={() => {
                    void invoke('toggle_stream_window').catch((e) =>
                      console.error('toggle_stream_window failed', e)
                    );
                  }}
                  title="toggle stream window"
                  aria-label="toggle stream window"
                  style={{ width: 20, height: 20 }}
                  className="bg-transparent border border-white/15 hover:border-white/50 transition-colors inline-flex items-center justify-center"
                >
                  <svg viewBox="0 0 14 14" width="12" height="12">
                    <rect
                      x="2"
                      y="3"
                      width="10"
                      height="7"
                      fill="none"
                      stroke="white"
                      strokeOpacity="0.6"
                      strokeWidth="1"
                    />
                    <line
                      x1="5"
                      y1="11.5"
                      x2="9"
                      y2="11.5"
                      stroke="white"
                      strokeOpacity="0.6"
                      strokeWidth="1"
                    />
                  </svg>
                </button>
              )}
            </div>
            <ScreenModeTabs />
            </div>
            <MacroStrip />
          </div>
          {/* Multi-mode screen. Mode tabs live in the title row above (beside
              the logo); this is the body. Scope + GhostDebug removed. */}
          <ChannelScreen />
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <div className="flex justify-between items-center gap-8 -my-4">
            <div className="flex items-center gap-2">
              <InitButton />
              <SaveSongButton />
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
                <MetronomeButton />
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
        </div>
      </main>
      <Toasts />
    </div>
  );
}
