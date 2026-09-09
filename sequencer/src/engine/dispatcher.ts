// Extracted verbatim from App.tsx (Phase 0 of the broadcast runner,
// docs/broadcast-set.md). No behavior change: each install* function is the
// body of the former useEffect and returns the same cleanup.
import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import {
  performBitDepth,
  performChopGate,
  performRepeatForTick,
  performSaturation,
  performScrubDepth,
  performReverse,
  performTuneRatio,
  isTrackMasked,
  setPerformEdgeHandler,
} from '../audio/perform';
import { samplePlayer } from '../audio/samplePlayer';
import { voiceRole } from '../audio/voices';
import {
  resolveVoiceEnvelope,
  voiceTrim,
  voiceGranular,
  voiceWavetable,
} from '../instruments/voiceEditsStore';
import {
  triggerSample,
  triggerBatch,
  flushPendingTriggers,
  type TriggerOpts,
  freezeVoiceParams,
} from '../audio/nativeEngine';
import { frameAtTime, engineNow, engineSampleRate } from '../audio/engineClock';
import { noteBarBoundary } from '../audio/loops';
import { emitSliceHit } from '../audio/sliceHits';
import {
  allocRevoiceNoteId,
  registerChord,
  type ChordToneVoice,
} from '../audio/voicingRevoice';
import { sendMIDINote, resolveDeviceId } from '../audio/midiOut';
import { octaveDegrees } from '../audio/scale';
import { emitStreamEvents, type StreamEvent } from '../stream/streamEvents';
import { tickPadDrift } from '../audio/padState';
import { consumeBranchLeaf } from '../audio/treeState';
import { consumeStepAccRung, consumeAutoMutationRung } from '../audio/accumulator';
import { getChordContext, setChordContext } from '../audio/chordContext';
import { getOverlay, setOverlay, attachChordToOverlay } from '../audio/mutationOverlay';
import { runTick } from './tick';
import { modulated, GLOBAL_TRACK_ID } from '../audio/lfo';
import { makeHarmonicMotionState, tickHarmonicMotion } from '../audio/harmonicMotion';
import {
  tickBar as ghostTickBar,
  beforeBarCommit as ghostBeforeBarCommit,
  getGhostLeadMutation,
} from '../ghost/ghost';

// TrackSection string → native section code (matches SECTION_* in
// `src-tauri/src/audio.rs`). 0 = none (no splits write), 1 = drum,
// 2 = melodic, 3 = click (written to both splits — used by the
// transport-level count-in trigger, not by track events).
function sectionCode(section: 'drum' | 'melodic' | undefined): number {
  if (section === 'drum') return 1;
  if (section === 'melodic') return 2;
  return 0;
}

export function installDispatcher(): () => void {
  const harmonic = makeHarmonicMotionState();
  // The per-tick dispatch body. `redispatch` = re-emitting an already-
  // scheduled tick after a perform punch edge flushed its queued native
  // triggers: cross-tick state (bar commits, ghost, harmonic motion) has
  // already advanced for these ticks, so only the trigger emission re-runs.
  // MIDI-out and stream events aren't flushed/replayed either — hardware
  // keeps the horizon latency.
  const dispatchTick = (
    globalStep: number,
    when: number,
    stepDuration: number,
    redispatch = false,
  ) => {
    // Bar boundary at 4/4 32nd resolution = every 32 global steps. A queued
    // pattern recall commits here, before we read `tracks` for this tick,
    // so the swap is atomic from the dispatch's point of view. Ghost
    // ordering: beforeBarCommit snapshots current macros as lerp source
    // BEFORE commit overwrites them; tickBar runs AFTER commit so it sees
    // the just-swapped activeBank as the lerp target.
    if (!redispatch && globalStep % 32 === 0) {
      // Feed the loop/resample unit's bar anchor — capture spans are
      // computed from the most recent bar boundary (audio/loops.ts).
      noteBarBoundary(
        frameAtTime(when),
        Math.round(32 * stepDuration * engineSampleRate()),
      );
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
      // Land the song-mode row even when it doesn't swap bank/scene — a
      // mute-only row variation (same B3, different mute group) leaves
      // commitPendingBank/Scene as no-ops, so without this the displayCursor
      // and mute overlay would never advance off row 0. Runs AFTER the swap
      // commits (idempotent when they already synced displayCursor) and
      // BEFORE ghostTickBar so its arrangementAdvance sees the landed row.
      useSequencerStore.getState().commitArrangementRow();
      ghostTickBar(globalStep);
      // If a bank/scene/song swap landed this bar, freeze the outgoing
      // scene's in-flight voice tails at their current DSP settings so
      // the new scene's params (pushed by the RAF a frame later) can't
      // retune them — a resonance jump on a ringing tail self-oscillates
      // into a crash. Fires before the new triggers below (which start
      // unfrozen on the new scene's settings).
      {
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
      const out = state.nativeMix.metronomeOutput;
      void triggerSample('__click_beat', {
        gain: 1.0,
        targetFrame: frameAtTime(when),
        section: 0,
        // Mono cue channel when multi-out is ON; the engine folds to 1-2
        // when it's OFF (same as every other voice).
        outFirst: out.firstChannel,
        outStereo: false,
      });
    }
    // Harmonic motion is a cross-tick state machine — owned by the
    // dispatcher, not the engine. Engine consumes the resolved offset.
    // Freeze pins the offset at its current value so a captured cycle
    // keeps the same key-shift it had at freeze moment.
    const modMotion = modulated(state.motion, state.lfos, GLOBAL_TRACK_ID, 'motion', undefined, 1);
    const modDrift = modulated(state.drift, state.lfos, GLOBAL_TRACK_ID, 'drift', undefined, 1);
    // Redispatch reuses the current offset — the motion state machine
    // already ticked for these steps on their first dispatch.
    const harmonicOffset = state.freeze || redispatch
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
    // Song mode hit its end this bar — the deferred stop is about to fire;
    // suppress this boundary bar's triggers so the last row doesn't restate.
    // Gate on `active` too: a stale pendingEnd must never silence audio once
    // song mode is disengaged.
    const songEnded = state.arrangement.active && state.arrangement.pendingEnd;
    // Perform punch-in layer — anchor/read the beat-repeat window for this
    // tick (cross-tick state owned by audio/perform.ts, same shape as
    // harmonic motion). Masked tracks loop the captured window in runTick.
    const performRepeat = performRepeatForTick(
      globalStep - state.sceneStartStep,
      state.sceneStartStep,
    );
    const events = inTailOut || songEnded
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
            perform: performRepeat
              ? { repeat: performRepeat, isMasked: isTrackMasked }
              : null,
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
          // MIDI-out scheduling isn't flushable — re-emitting on a punch
          // edge would double the hardware notes.
          if (redispatch) break;
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
          // Perform punch FX (P2) — trigger-time transforms on masked
          // tracks: reverse flips new triggers to reverse one-shot
          // (loopMode 4, in the engine since 0.8.12); tune multiplies the
          // playback rate for new notes. Ringing notes are untouched —
          // matches the hardware's offset semantics.
          const perfReverse = performReverse(ev.trackId);
          const perfTune = performTuneRatio(ev.trackId);
          // Bits punch takes min(voice, slot) — only ever deepens the crush.
          const perfBits = performBitDepth(ev.trackId);
          // Scrub/chop punches (diced/applied per trigger): scrub
          // randomizes the sample start within the trim window, chop
          // forces a snappy synthetic gate. Sat drives the tanh stage —
          // max(voice, slot), only ever adds dirt.
          const perfScrub = performScrubDepth(ev.trackId);
          const perfChop = performChopGate(ev.trackId);
          const perfSat = performSaturation(ev.trackId);
          // Scrubbed start fraction for a pick (undefined = untouched).
          const scrubStart = (
            pick: { start?: number; end?: number },
            roll: number,
          ) => {
            if (perfScrub === null) return pick.start;
            const s = pick.start ?? 0;
            const e = pick.end ?? 1;
            return Math.min(s + roll * perfScrub * (e - s), e - 0.001);
          };
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
            {
              // Arp — sample-accurate dispatch. All tones go out in
              // ONE batched IPC; each carries its own absolute
              // engine-clock target frame so the Rust audio callback
              // queues them and emits at the exact sub-step sample.
              // pickNativeSample is still called at scheduling time
              // so the round-robin counter advances in arp order
              // regardless of dispatch latency.
              const out = evTrack?.output;
              const pan = ((ev.pan ?? 0.5) - 0.5) * 2;
              const trackGain = evTrack?.gain ?? 1;
              const batch: Array<{ path: string; opts: TriggerOpts }> = [];
              for (let i = 0; i < n; i++) {
                const fireAt = ev.when + i * sub;
                const interval = ev.voiceIntervals[i];
                const targetMidi =
                  ev.midi !== undefined ? ev.midi + interval : undefined;
                const pick = samplePlayer.pickNativeSample(ev.voice, targetMidi, ev.trackId);
                if (!pick) continue;
                if (pick.sliceIndex !== null) emitSliceHit(ev.voice, pick.sliceIndex);
                // Endless voices need a synthetic gate so they don't ring
                // forever (see the standard-path note below): continuous loop
                // modes, and the granular / wavetable playmodes, which never end
                // by position either. Monophonic choke ends earlier tones; the
                // gate bounds the final one. A chop punch replaces the envelope
                // wholesale — snappy synthetic gate regardless of the voice's
                // authored shape.
                const arpLooping =
                  pick.loop === 1 ||
                  pick.loop === 2 ||
                  pick.loop === 3 ||
                  pick.granular.on ||
                  pick.wavetable.on;
                const arpEnv =
                  perfChop !== null
                    ? { attack: 0.0015, release: 0.02 }
                    : resolveVoiceEnvelope(ev.voice) ??
                      (arpLooping ? { attack: 0.003, release: 0.05 } : undefined);
                batch.push({ path: pick.path, opts: {
                  gain: ev.velocity * pick.voiceGain * trackGain,
                  pan,
                  pitch: pick.pitch * perfTune,
                  outFirst: out?.firstChannel ?? 0,
                  outStereo: out?.stereo ?? true,
                  trackId: ev.trackId,
                  targetFrame: frameAtTime(fireAt),
                  // Force monophonic per arp tone — new tones choke the
                  // prior tail so the line reads as an arp, not a strum.
                  monophonic: true,
                  chokeGroup: pick.chokeGroup ?? undefined,
                  section: sectionCode(ev.section),
                  isTexture,
                  // Per-arp-tone hold = sub-step duration × gate (chop
                  // punch overrides the gate fraction outright).
                  envelopeAttack: arpEnv?.attack,
                  envelopeDecay: arpEnv?.decay,
                  envelopeSustain: arpEnv?.sustain,
                  envelopeRelease: arpEnv?.release,
                  envelopeHold: arpEnv
                    ? (perfChop ?? ev.gate) * sub
                    : undefined,
                  start: scrubStart(pick, Math.random()),
                  end: pick.end,
                  loopMode: perfReverse ? 4 : pick.loop,
                  filterType: pick.filterType,
                  cutoff: pick.cutoff,
                  resonance: pick.resonance,
                  satDrive:
                    perfSat !== null
                      ? Math.max(pick.satDrive ?? 0, perfSat)
                      : pick.satDrive,
                  bitDepth:
                    perfBits !== null
                      ? Math.min(pick.bitDepth ?? 16, perfBits)
                      : pick.bitDepth,
                  lfoShape: pick.lfoShape,
                  lfoRateHz: pick.lfoRateHz,
                  lfoDepth: pick.lfoDepth,
                  mods: pick.mods,
                  granular: pick.granular,
                  wavetable: pick.wavetable,
                } });
              }
              void triggerBatch(batch);
            }
          } else {
            // Multi-tone triggers fire one native voice per interval —
            // all simultaneous (a chord). Each carries the step's
            // absolute engine-clock target frame so the Rust callback
            // dispatches sample-accurately, instead of firing the
            // moment the IPC arrives (which was ~25-100 ms early from
            // the JS lookahead).
            const intervals =
              ev.voiceIntervals && ev.voiceIntervals.length > 0
                ? ev.voiceIntervals
                : [0];
            const out = evTrack?.output;
            const pan = ((ev.pan ?? 0.5) - 0.5) * 2;
            const trackGain = evTrack?.gain ?? 1;
            const stepTargetFrame = frameAtTime(ev.when);
            // Melodic voices honor note length even without a hand-authored
            // ADSR: mirror the live monitor (which releases the voice on
            // key-up) by synthesizing a gate-driven hold + short release.
            // This is what makes a recorded note's length actually sound —
            // a flat sample otherwise plays full regardless of gate. Drums
            // stay one-shots (full sample); voices with an explicit envelope
            // keep it.
            //
            // Continuous loop modes (fwd/bwd/ping) ALSO need this synthetic
            // gate even on a flat drum voice: a looping voice has no natural
            // end, so without an envelope it wraps forever (the "infinite
            // reverse snare" hang). Binding the loop to gate × stepDuration
            // makes it loop while the step is held, then release — same as a
            // hardware sampler. `rev` (reverse one-shot, code 4) and `off`
            // self-terminate, so they don't need it.
            //
            // The granular and wavetable playmodes (editor Phase C) are endless
            // the same way — a grain repeats / a cycle scans until something
            // stops the voice — and were missed when they landed: a 909 kick
            // switched to granular with the drive up spawned an infinite driven
            // grain loop on every hit, stacking two voices a bar until the
            // whole mix was a wall that only a stream reopen cleared
            // (black-eyes.seq, 2026-09-08). Same rule, same gate.
            const loopCode = voiceTrim(ev.voice).loop;
            const isContinuousLoop =
              loopCode === 1 ||
              loopCode === 2 ||
              loopCode === 3 ||
              voiceGranular(ev.voice).on ||
              voiceWavetable(ev.voice).on;
            // A chop punch replaces the envelope wholesale — snappy
            // synthetic gate on EVERY masked voice (drums included),
            // holding for the slot's fraction of the step.
            const playEnv =
              perfChop !== null
                ? { attack: 0.0015, release: 0.02 }
                : resolveVoiceEnvelope(ev.voice) ??
                  (ev.section === 'melodic' || isContinuousLoop
                    ? { attack: 0.003, release: 0.05 }
                    : undefined);
            const holdSecs = playEnv
              ? (perfChop ?? ev.gate) * ev.stepDuration
              : undefined;
            // Sustaining chord-master triggers carry a `revoice` context — tag
            // each chord tone with a note_id and register the sounding chord so
            // the voicing-macro loop (below) can re-voice it while it rings.
            const reVoiceable = ev.revoice !== undefined;
            // Scrub — one roll per event; multisample picks may trim
            // differently per tone, so the roll maps into each pick's own
            // window but the chord scrubs coherently.
            const scrubRoll = Math.random();
            const tones: ChordToneVoice[] = [];
            // Choke group fires on the FIRST tone only — all tones of a
            // chord land in the same audio block, and a per-tone choke
            // would have tone 2 ramp out tone 1 of its own chord. The web
            // path chokes once per trigger event; this mirrors that.
            let chokeApplied = false;
            const batch: Array<{ path: string; opts: TriggerOpts }> = [];
            for (const interval of intervals) {
              const targetMidi =
                ev.midi !== undefined ? ev.midi + interval : undefined;
              const pick = samplePlayer.pickNativeSample(ev.voice, targetMidi, ev.trackId);
              if (!pick) continue;
              // Slice-mode telemetry: flash the fired slice in the editor
              // waveform (no-op when nobody's watching the params tab).
              if (pick.sliceIndex !== null) emitSliceHit(ev.voice, pick.sliceIndex);
              const noteId =
                reVoiceable && targetMidi !== undefined
                  ? allocRevoiceNoteId()
                  : undefined;
              batch.push({ path: pick.path, opts: {
                gain: ev.velocity * pick.voiceGain * trackGain,
                pan,
                pitch: pick.pitch * perfTune,
                outFirst: out?.firstChannel ?? 0,
                outStereo: out?.stereo ?? true,
                trackId: ev.trackId,
                targetFrame: stepTargetFrame,
                // `ev.monophonic` carries through from the engine event
                // so bass / lead tracks marked monophonic actually choke.
                monophonic: ev.monophonic === true,
                // Manifest choke group (hats) — chokes across tracks.
                chokeGroup:
                  !chokeApplied && pick.chokeGroup ? pick.chokeGroup : undefined,
                section: sectionCode(ev.section),
                isTexture,
                // Voice ADSR + hold = gate × stepDuration. Voices without
                // an envelope config (drums, leads) pass nothing here
                // and run at flat gain.
                envelopeAttack: playEnv?.attack,
                envelopeDecay: playEnv?.decay,
                envelopeSustain: playEnv?.sustain,
                envelopeRelease: playEnv?.release,
                envelopeHold: holdSecs,
                noteId,
                start: scrubStart(pick, scrubRoll),
                end: pick.end,
                loopMode: perfReverse ? 4 : pick.loop,
                filterType: pick.filterType,
                cutoff: pick.cutoff,
                resonance: pick.resonance,
                satDrive:
                  perfSat !== null
                    ? Math.max(pick.satDrive ?? 0, perfSat)
                    : pick.satDrive,
                bitDepth:
                  perfBits !== null
                    ? Math.min(pick.bitDepth ?? 16, perfBits)
                    : pick.bitDepth,
                lfoShape: pick.lfoShape,
                lfoRateHz: pick.lfoRateHz,
                lfoDepth: pick.lfoDepth,
                mods: pick.mods,
                granular: pick.granular,
                wavetable: pick.wavetable,
              } });
              if (pick.chokeGroup) chokeApplied = true;
              if (noteId !== undefined && targetMidi !== undefined) {
                tones.push({ noteId, midi: targetMidi });
              }
            }
            // One IPC for the whole chord — Rust queues each tone on
            // the same absolute target frame.
            void triggerBatch(batch);
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
          }
          break;
        }
      }
    }
    if (!redispatch && streamBatch.length > 0) emitStreamEvents(streamBatch);
  };
  const unsubStep = scheduler.onStep('app:dispatcher', (g, w, d) =>
    dispatchTick(g, w, d),
  );
  // Perform punch edges (arm / length-switch / release): the ~250ms of
  // already-queued native triggers are what made engage and release feel
  // laggy and "continuing". Flush everything from ~now onward and re-run
  // the dispatch for exactly those scheduled ticks under the NEW perform
  // state — both edges land within ~30ms. The flush is awaited so the
  // re-emitted triggers can't race ahead of the drop in the command queue.
  setPerformEdgeHandler(() => {
    void (async () => {
      const boundary = engineNow() + 0.03;
      try {
        await flushPendingTriggers(frameAtTime(boundary));
      } catch {
        // Device not open (transport idle) — nothing queued to flush.
        return;
      }
      for (const s of scheduler.pendingSteps(boundary)) {
        dispatchTick(s.index, s.when, s.stepDuration, true);
      }
    })();
  });
  return () => {
    setPerformEdgeHandler(null);
    unsubStep();
  };
}
