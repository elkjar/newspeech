import { useEffect, useState } from 'react';
import { PlayButton, RecordButton, CountInButton, RawRecordButton, StemsButton, AudioOutSelector, TransportControls, InitButton } from './components/Transport';
import { initAudioOutputs } from './audio/audioOutput';
import { SettingsDialog } from './components/SettingsDialog';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { LFOPanel } from './components/LFOPanel';
import { MacroStrip } from './components/MacroStrip';
import { BankPad } from './components/BankPad';
import { ConductorPanel } from './components/ConductorPanel';
import { FXPanel } from './components/FXPanel';
import { Scope } from './components/Scope';
import {
  useSequencerStore,
  type EditMode,
  type TrackSection,
} from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { initMIDIOut, sendMIDINote, resolveDeviceId } from './audio/midiOut';
import { initMIDIIn } from './midi/midiIn';
import { dispatchMidi } from './midi/midiMap';
import { loadMidiMapLibrary } from './midi/midiMapLoader';
import { octaveDegrees } from './audio/scale';
import { sourceIsMelodic } from './instruments/library';
import { tickPadDrift } from './audio/padState';
import type { ChordDegree } from './audio/chords';
import { getChordContext, setChordContext } from './audio/chordContext';
import { getOverlay, setOverlay, attachChordToOverlay } from './audio/mutationOverlay';
import { runTick } from './engine/tick';
import { modulated, GLOBAL_TRACK_ID } from './audio/lfo';
import { makeHarmonicMotionState, tickHarmonicMotion } from './audio/harmonicMotion';
import { togglePlayback } from './audio/transport';
import {
  initConductor,
  tickBar as conductorTickBar,
  beforeBarCommit as conductorBeforeBarCommit,
} from './conductor/conductor';
import { autoSeedBanks } from './conductor/generator';
import { isTauri } from '@tauri-apps/api/core';

const NATIVE = isTauri();

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

  useEffect(() => {
    if (NATIVE) document.body.classList.add('tauri-native');
    initMIDIOut();
    initConductor();
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
  }, []);

  useEffect(() => {
    const kits = [
      'drums/blck_noir',
      // ns-kit-1 namespaces its voices with `ns1-` prefix so it coexists
      // with blck_noir in the sample-player map (no overwrite). Both kits
      // appear in the drum source-picker; conductor auto-picks blck_noir
      // for compose moves until a kit-aware palette is introduced.
      'drums/ns-kit-1',
      'pads/encounter',
      'pads/pulsed',
      'pads/sinewaves-at-the-scope',
      'instruments/hydrasynth_plaits',
      'instruments/mini-moog',
      'instruments/rhodes_mk1',
      'instruments/root_grain',
      'instruments/soft_piano',
      'instruments/tape_piano',
      'instruments/under_piano',
    ];
    for (const kitPath of kits) {
      const baseUrl = `${import.meta.env.BASE_URL}samples/${kitPath}`;
      fetch(`${baseUrl}/manifest.json`)
        .then((r) => r.json())
        .then((manifest) => samplePlayer.loadManifest(baseUrl, manifest))
        .catch((err) => console.warn(`sample manifest ${kitPath} load failed:`, err));
    }
  }, []);

  useEffect(() => {
    const harmonic = makeHarmonicMotionState();
    return scheduler.onStep((globalStep, when, stepDuration) => {
      // Bar boundary at 4/4 32nd resolution = every 32 global steps. A queued
      // pattern recall commits here, before we read `tracks` for this tick,
      // so the swap is atomic from the dispatch's point of view. Conductor
      // ordering: beforeBarCommit snapshots current macros as lerp source
      // BEFORE commit overwrites them; tickBar runs AFTER commit so it sees
      // the just-swapped activeBank as the lerp target.
      if (globalStep % 32 === 0) {
        conductorBeforeBarCommit();
        // Pass the scheduler's globalStep so applyBankSlot's sceneStartStep
        // matches the SCHEDULED step (not the lagging audible step in the
        // store). Without this, sceneStep = scheduled - audible-stale ≠ 0,
        // and chord master / bass step 0 land at non-zero localStep — the
        // "dropping beat 1" symptom.
        useSequencerStore.getState().commitPendingBank(globalStep);
        conductorTickBar(globalStep);
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
          case 'sample':
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
            break;
        }
      }
    });
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
  }, [bpm]);

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
              <ConductorPanel />
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
                <StemsButton />
                <AudioOutSelector />
              </div>
              <div className="flex items-center gap-4">
                <SectionToggle />
                <span className="w-px h-6 bg-white/15" />
                <ModeSwitcher />
              </div>
            </div>
            <TransportControls />
          </div>
          <FXPanel />
        </div>
      </main>
    </div>
  );
}
