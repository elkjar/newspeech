import { useRef, useState } from 'react';
import {
  useSequencerStore,
  RATE_STRIDE,
  type Track as TrackData,
  type Step,
  PAGE_SIZE,
  NUM_PAGES,
} from '../state/store';
import { StepButton } from './StepButton';
import { TrackKnob } from './TrackKnob';
import { RowPanel } from './RowPanel';
import {
  sourceIsMelodic,
  sourceLabel,
  type InstrumentRole,
  type TrackSource,
} from '../instruments/library';
import { NewInstrumentDialog } from './NewInstrumentDialog';
import { VoicePickerDialog } from './VoicePickerDialog';
import { InstrumentEditorDialog } from './InstrumentEditorDialog';
import { GLOBAL_TRACK_ID } from '../audio/lfo';
import { computeThinMul, computeFillProb } from '../audio/macros';
import { useLFOValue } from '../hooks/useLFOValue';
import { useRoutedLFOs } from '../hooks/useRoutedLFOs';

const STEP_GAP = 6;
const STEP_SIZE = 36;

function originatorIndex(track: TrackData, i: number): number {
  const len = track.length;
  if (len <= 0) return i;
  let cur = i;
  let originatorIdx = i;
  while (cur > 0) {
    const prev = cur - 1;
    // Authored ties only — mutation's runtime tie-flips drive the audio but
    // must not reshape the displayed chain (the grid shows authored intent).
    if (!(track.steps[prev]?.tieToNext ?? false)) break;
    cur = prev;
    if (track.steps[prev]?.on) originatorIdx = prev;
  }
  return originatorIdx;
}

// The grid always renders the AUTHORED pattern — what the user programmed or
// recorded — never the live mutation/ghost overlay. Mutation still drives the
// AUDIO (the overlay is computed per-tick in the engine and read by the
// scheduler), but painting the grid with that computed variation hid
// freshly-recorded notes until the next pass and obscured the real pattern.
// Showing authored intent is more useful than showing the latest variation.
function displayStep(track: TrackData, i: number): Step | undefined {
  return track.steps[originatorIndex(track, i)];
}


export function Track({ trackId, trackIndex }: { trackId: string; trackIndex: number }) {
  // Subscribe to this track's own row only. Per-row identity is preserved by
  // the store's setters (`tracks.map(t => t.id === id ? {...t} : t)`), so
  // mutations to OTHER tracks return the same object reference here →
  // Object.is short-circuits, this Track skips reconcile.
  const track = useSequencerStore((s) => s.tracks.find((t) => t.id === trackId));
  const globalStep = useSequencerStore((s) => s.globalStep);
  const sceneStartStep = useSequencerStore((s) => s.sceneStartStep);
  const playing = useSequencerStore((s) => s.playing);
  // Focused channel = the one the ROLL screen + StepInspector are locked to.
  // Brighten this row's name button so it's obvious which channel they reflect.
  const isFocused = useSequencerStore((s) => s.focusedTrackId === trackId);
  const density = useSequencerStore((s) => s.density);
  const anySolo = useSequencerStore((s) => s.tracks.some((t) => t.solo));
  // Live density value for chance-mode opacity. Mirrors the gate the dispatch
  // loop uses, so twisting macros fades the grid at the same rate the audio
  // thins out. Metric-weighted density is computed per step in the render loop
  // below (downbeat preserved, offbeats fade first).
  const densityLFOs = useRoutedLFOs(GLOBAL_TRACK_ID, 'density');
  const liveDensity = useLFOValue(density, densityLFOs, 1);
  // Melodic slot for this track (how many melodic tracks precede it in
  // the array). Returns -1 for drum tracks. Used below to mirror the
  // engine's harmonicAnchor detection — bass row UI shouldn't fade
  // under low density when playback ignores density for that row.
  const melodicSlot = useSequencerStore((s) => {
    if (s.tracks[trackIndex]?.section !== 'melodic') return -1;
    let slot = -1;
    for (let i = 0; i <= trackIndex; i++) {
      if (s.tracks[i]?.section === 'melodic') slot++;
    }
    return slot;
  });
  const setTrackSource = useSequencerStore((s) => s.setTrackSource);
  const setTrackMute = useSequencerStore((s) => s.setTrackMute);
  const setTrackSolo = useSequencerStore((s) => s.setTrackSolo);
  const setTrackPage = useSequencerStore((s) => s.setTrackPage);
  const clearTrack = useSequencerStore((s) => s.clearTrack);
  const setTrackLockTiming = useSequencerStore((s) => s.setTrackLockTiming);
  const setTrackInputArmed = useSequencerStore((s) => s.setTrackInputArmed);
  const midiRecInputPort = useSequencerStore((s) => s.midiRecInputPort);

  const [panelOpen, setPanelOpen] = useState(false);
  const [newInstrumentDefaultRole, setNewInstrumentDefaultRole] =
    useState<InstrumentRole | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Defensive guard: trackId comes from TrackGrid's shallow-compared key list,
  // which can briefly outlive the underlying tracks array during initProject /
  // applyPreset replacements.
  if (!track) return null;

  // Empty rows shouldn't get density fill-in — keep them silent regardless.
  const hasAuthoredOn = track.steps
    .slice(0, track.length)
    .some((s) => s.on);

  const silenced = track.mute || (anySolo && !track.solo);
  const melodic = sourceIsMelodic(track.source);
  // Mirror engine's harmonicAnchor (tick.ts:578) so the step grid stops
  // visually fading on rows whose playback ignores density. Without
  // this the bass row dims at low density while it actually plays at
  // full strength — a UI lie.
  const harmonicAnchor =
    track.section === 'melodic' &&
    (melodicSlot === 0 ||
      melodicSlot === 1 ||
      track.pitchInterp === 'root-follow');

  const handlePickerSelect = (next: TrackSource) => {
    setTrackSource(track.id, next);
    setPickerOpen(false);
  };

  const handlePickerNewInstrument = (role: InstrumentRole) => {
    setPickerOpen(false);
    setNewInstrumentDefaultRole(role);
  };

  const stride = RATE_STRIDE[track.rate];
  // Scene-relative step position so the visible playhead matches the audible
  // step (dispatch in App.tsx uses the same offset). Without this, polyrhythmic
  // tracks show playheads at offset positions after a bank swap because the
  // raw globalStep modulo math doesn't reset on scene change.
  const localCurrent = Math.floor((globalStep - sceneStartStep) / stride) % track.length;
  const playingPage = Math.floor(localCurrent / PAGE_SIZE);
  const stepInPage = localCurrent % PAGE_SIZE;
  const viewPage = track.viewPage;
  // Tie is enabled only on rows whose source actually honors gate length:
  // external MIDI instruments (any section), and melodic sample voices
  // (used as a phrasing affordance even though playback envelope is fixed).
  // Suppressed on unbound rows (no source) and drum sample voices.
  const tieEnabled =
    track.source.kind !== 'empty' &&
    !(track.section === 'drum' && track.source.kind === 'voice');

  return (
    // justify-between pins the control cluster left and the step grid right, so
    // the grid stays nested against the right edge (aligned with the BankPad row
    // above) no matter what controls are added/removed on the left — it
    // self-corrects rather than needing a hand-tuned spacer.
    <div className="flex items-center justify-between" style={{ gap: `${STEP_GAP}px` }}>
      <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          style={{ height: STEP_SIZE }}
          className={[
            'w-[114px] border text-[11px] uppercase tracking-widest text-white px-3 text-left truncate hover:border-white focus:outline-none focus:border-white transition-colors',
            isFocused ? 'border-white/70 bg-white/10' : 'border-white/15 bg-transparent',
          ].join(' ')}
          title={
            track.source.kind === 'empty'
              ? 'pick a source — voice or midi instrument'
              : `source: ${sourceLabel(track.source)} (click to change)`
          }
        >
          {track.source.kind === 'empty' ? '—' : sourceLabel(track.source)}
        </button>
        <VoicePickerDialog
          open={pickerOpen}
          section={track.section}
          source={track.source}
          onPick={handlePickerSelect}
          onNewInstrument={handlePickerNewInstrument}
          onCancel={() => setPickerOpen(false)}
        />
        <NewInstrumentDialog
          open={newInstrumentDefaultRole !== null}
          defaultRole={newInstrumentDefaultRole ?? 'lead'}
          onCancel={() => setNewInstrumentDefaultRole(null)}
          onCreated={(inst) => {
            setTrackSource(track.id, { kind: 'instrument', id: inst.id });
            setNewInstrumentDefaultRole(null);
          }}
        />
        <div className="relative">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            style={{ width: STEP_SIZE, height: STEP_SIZE }}
            className={[
              'bg-transparent border transition-colors flex items-center justify-center',
              panelOpen ? 'border-white/50' : 'border-white/15 hover:border-white/30',
            ].join(' ')}
            title={`length & euclidean (len ${track.length} · hits ${track.euclidean.hits} · rot ${track.euclidean.rotation})`}
            aria-label="row settings"
            aria-expanded={panelOpen}
          >
            <svg viewBox="0 0 14 14" width="14" height="14">
              <circle cx="3" cy="7" r="1" fill="white" fillOpacity="0.85" />
              <circle cx="7" cy="7" r="1" fill="white" fillOpacity="0.85" />
              <circle cx="11" cy="7" r="1" fill="white" fillOpacity="0.85" />
            </svg>
          </button>
          {panelOpen && (
            <RowPanel
              track={track}
              onClose={() => setPanelOpen(false)}
              triggerRef={triggerRef}
              onOpenEditor={() => {
                setPanelOpen(false);
                setEditorOpen(true);
              }}
            />
          )}
        </div>
        <InstrumentEditorDialog
          open={editorOpen}
          track={track}
          onClose={() => setEditorOpen(false)}
        />
        {/* Record arm. Monitoring is covered by the Launchpad keyboard page
            (tracks the selected step) and by arming while stopped, so the old
            monitor-only toggle that used to sit beside this was removed. */}
        <button
          type="button"
          onClick={() => setTrackInputArmed(track.id, !track.inputArmed)}
          style={{ width: STEP_SIZE, height: STEP_SIZE }}
          className="flex items-center justify-center bg-transparent transition-colors group"
          title={
            !midiRecInputPort
              ? 'pick a midi input port in the MIDI bar to record'
              : track.inputArmed
                ? 'armed for midi recording — click to disarm'
                : 'click to arm for midi recording (overdub on the current step)'
          }
          aria-pressed={!!track.inputArmed}
          aria-label="record arm"
        >
          <span
            className={
              track.inputArmed
                ? 'w-3 h-3 rounded-full bg-white'
                : 'w-3 h-3 rounded-full border border-white/30 group-hover:border-white/70 transition-colors'
            }
          />
        </button>
        {(['gain', 'pan', 'filterCutoff', 'filterResonance', 'fxSend', 'mutation'] as const).map((knob) => (
          <TrackKnob
            key={knob}
            track={track}
            knob={knob}
            trackIndex={trackIndex}
            size={STEP_SIZE}
          />
        ))}
      </div>

      <div className="flex" style={{ gap: `${STEP_GAP}px` }}>
        <button
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) {
              clearTrack(track.id);
              return;
            }
            setTrackMute(track.id, !track.mute);
          }}
          style={{ width: STEP_SIZE, height: STEP_SIZE }}
          className={
            track.mute
              ? 'bg-white'
              : 'bg-white/5 hover:bg-white/15 transition-colors'
          }
          title="mute (cmd/ctrl-click to clear row)"
        />
        <button
          onClick={() => setTrackSolo(track.id, !track.solo)}
          style={{ width: STEP_SIZE, height: STEP_SIZE }}
          className={
            track.solo
              ? 'bg-white'
              : 'bg-white/5 hover:bg-white/15 transition-colors'
          }
          title="solo"
        />
      </div>
      </div>

      <div
        className={`flex items-center transition-opacity ${silenced ? 'opacity-30' : ''}`}
      >
      <div className="flex" style={{ gap: `${STEP_GAP}px` }}>
        {Array.from({ length: NUM_PAGES }, (_, p) => {
          const reachable = p * PAGE_SIZE < track.length;
          const brightPage = playing ? playingPage : viewPage;
          const isBright = p === brightPage;
          const isViewMarker = playing && p === viewPage && viewPage !== playingPage;
          return (
            <button
              key={p}
              onClick={() => reachable && setTrackPage(track.id, p)}
              disabled={!reachable}
              style={{ width: STEP_SIZE, height: STEP_SIZE }}
              className={
                isBright
                  ? 'bg-white'
                  : isViewMarker
                    ? 'bg-white/50 hover:bg-white/70 transition-colors'
                    : reachable
                      ? 'bg-white/25 hover:bg-white/50 transition-colors'
                      : 'bg-white/[0.05] cursor-not-allowed'
              }
              title={`page ${p + 1}`}
            />
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setTrackLockTiming(track.id, !track.lockTiming)}
        style={{ width: STEP_SIZE, height: STEP_SIZE }}
        className="flex items-center justify-center bg-transparent transition-colors group"
        title={
          track.lockTiming
            ? 'timing locked — mutation only changes notes (click to unlock)'
            : 'click to lock timing — keeps pattern fixed while mutation evolves notes'
        }
        aria-pressed={track.lockTiming}
      >
        <span
          className={
            track.lockTiming
              ? 'w-3 h-3 rounded-full bg-white'
              : 'w-3 h-3 rounded-full border border-white/30 group-hover:border-white/70 transition-colors'
          }
        />
      </button>

      <div
        className="flex"
        style={{
          gap: STEP_GAP,
          // Reserve the full-page width (16 steps + 15 gaps) regardless of
          // how many step buttons actually render. Without this fixed
          // width, shorter rows produce a narrower step section and the
          // outer justify-between shifts step column 1 across rows. The
          // BankPad row's right edge stays aligned with the step section's
          // right edge as a result.
          width: PAGE_SIZE * STEP_SIZE + (PAGE_SIZE - 1) * STEP_GAP,
        }}
      >
        {Array.from(
          { length: Math.max(0, Math.min(PAGE_SIZE, track.length - viewPage * PAGE_SIZE)) },
          (_, i) => {
            const stepIndex = viewPage * PAGE_SIZE + i;
            const idx = originatorIndex(track, stepIndex);
            const isTiedChain = idx !== stepIndex;
            const display = displayStep(track, stepIndex);
            const isCurrent = playing && playingPage === viewPage && stepInPage === i;
            return (
              <StepButton
                key={i}
                trackId={track.id}
                index={stepIndex}
                on={display?.on ?? false}
                velocity={display?.velocity ?? 1}
                probability={
                  display?.on
                    ? harmonicAnchor
                      ? display.probability ?? 100
                      : Math.min(
                          100,
                          (display.probability ?? 100) *
                            computeThinMul(liveDensity, stepIndex, track.length)
                        )
                    : hasAuthoredOn && !harmonicAnchor
                      ? 100 * computeFillProb(liveDensity, stepIndex, track.length, track.section)
                      : 0
                }
                ratchet={display?.ratchet ?? 1}
                microTiming={display?.microTiming ?? 0}
                gate={display?.gate ?? 1}
                isMelodic={melodic}
                isCurrent={isCurrent}
                isTiedChain={isTiedChain}
                tieEnabled={tieEnabled}
                size={STEP_SIZE}
              />
            );
          }
        )}
      </div>
      </div>
    </div>
  );
}
