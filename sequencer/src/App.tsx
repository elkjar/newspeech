import { useEffect, useState } from 'react';
import { PlayButton, RecordButton, CountInButton, RawRecordButton, SplitsButton, MultitrackButton, AudioOutSelector, TransportControls, InitButton } from './components/Transport';
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
} from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { isNativeAudioAvailable, triggerSample } from './audio/nativeEngine';
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
    // Auto-seed banks on every load — wipes scene banks and fills slots
    // 0-9 with one of each recipe in song-arc order. User's track voices
    // (band identity) persist via persist.ts and seed banks inherit those
    // via activeVoice() in compose moves.
    autoSeedBanks();
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
    // Sample kits are discovered via samples/index.json (emitted by the
    // vite samplesIndex plugin at build time; served live in dev). Each
    // manifest is loaded into samplePlayer for the audio path AND into
    // manifestRegistry for the VoiceDef-derivation path. Replaces the
    // previously hardcoded `kits = [...]` array + the per-voice entries
    // duplicated across voices.ts and hydrate.ts.
    if (samplesBootStarted()) return;
    markSamplesBootStarted();
    const indexUrl = `${import.meta.env.BASE_URL}samples/index.json`;
    void (async () => {
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
              await samplePlayer.loadManifest(baseUrl, manifest);
            } catch (err) {
              console.warn(`sample manifest ${entry.kitPath} load failed:`, err);
            }
            setSamplesLoaded((n) => n + 1);
          }),
        );
      } catch (err) {
        console.warn('samples index load failed:', err);
      }
      // After bundled samples register, fold in any kits from the user
      // samples dir. Tauri-only — no-op on web. Awaited so they appear in
      // the source pickers without a second refresh.
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
        // Scene commit fires BEFORE bank commit — a queued scene swap
        // replaces the entire bank palette, so a pending bank within the
        // outgoing scene would be stale by the time it commits.
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
      const events = runTick(
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
                  // the previous one's natural decay. Without this, sample
                  // releases overlap and it feels like a strum, not an arp.
                  true,
                  ev.section,
                );
              }
            } else {
              // Phase 1b: per-track native engine bypass. When the track is
              // flipped to 'native' AND the trigger is a single-tone (chord
              // triggers stay on the web path for now — no native polyphony
              // helper yet), route to the cpal mixer. Native plays dry on
              // device channels 1-2; no per-track filter / FX / envelope /
              // detune jitter. Sequencer integration in Phase 4 wires
              // per-track output routing; Phase 7-8 brings FX parity.
              const tonesCount = ev.voiceIntervals?.length ?? 0;
              const nativeRoute =
                isNativeAudioAvailable() &&
                evTrack?.engine === 'native' &&
                tonesCount <= 1;
              if (nativeRoute) {
                const interval = ev.voiceIntervals?.[0] ?? 0;
                const targetMidi =
                  ev.midi !== undefined ? ev.midi + interval : undefined;
                const pick = samplePlayer.pickNativeSample(ev.voice, targetMidi);
                if (pick) {
                  const gain = ev.velocity * pick.voiceGain * (evTrack?.gain ?? 1);
                  const pan = ((ev.pan ?? 0.5) - 0.5) * 2;
                  void triggerSample(pick.path, { gain, pan, pitch: pick.pitch });
                }
              } else {
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

  // Phase 1b: preload sample paths into the native cpal registry whenever
  // a track flips to engine='native' or its voice changes while native.
  // Without preload, the first trigger after the flip incurs ~50 ms of
  // invoke + WAV decode latency on the audio path and lands as an audible
  // click delay.
  useEffect(() => {
    if (!isNativeAudioAvailable()) return;
    const preload = (voiceId: string) => {
      void samplePlayer.preloadNativeForVoice(voiceId);
    };
    // Initial pass: any native tracks already in state (reopened project).
    for (const t of useSequencerStore.getState().tracks) {
      if (t.engine === 'native' && t.source.kind === 'voice') {
        preload(t.source.id);
      }
    }
    // Watch for changes — fire only on engine flips and on voice swaps
    // while native. Comparing by track id survives length / order changes
    // from initProject / applyPreset.
    return useSequencerStore.subscribe((state, prev) => {
      const prevById = new Map(prev.tracks.map((t) => [t.id, t] as const));
      for (const cur of state.tracks) {
        if (cur.engine !== 'native' || cur.source.kind !== 'voice') continue;
        const prv = prevById.get(cur.id);
        const isNewlyNative =
          !prv ||
          prv.engine !== 'native' ||
          prv.source.kind !== 'voice' ||
          prv.source.id !== cur.source.id;
        if (isNewlyNative) preload(cur.source.id);
      }
    });
  }, []);

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
            <InitButton />
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
                <MultitrackButton />
                <AudioOutSelector />
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
