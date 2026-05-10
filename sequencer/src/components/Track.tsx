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
import { VOICES } from '../audio/voices';
import {
  INSTRUMENTS,
  sourceIsMelodic,
  type TrackSource,
} from '../instruments/library';
import { getOverlay } from '../audio/mutationOverlay';
import { morphStep, stepSeed } from '../audio/morph';
import { effectiveTieToNext } from '../audio/mutationTie';
import { findRouted, GLOBAL_TRACK_ID } from '../audio/lfo';
import { computeThinMul, computeFillProb } from '../audio/macros';
import { useLFOValue } from '../hooks/useLFOValue';

const STEP_GAP = 6;
const STEP_SIZE = 36;

function originatorIndex(track: TrackData, i: number): number {
  const len = track.length;
  if (len <= 0) return i;
  let cur = i;
  let originatorIdx = i;
  while (cur > 0) {
    const prev = cur - 1;
    if (!effectiveTieToNext(track, prev)) break;
    cur = prev;
    if (track.steps[prev]?.on) originatorIdx = prev;
  }
  return originatorIdx;
}

function displayStep(
  track: TrackData,
  i: number,
  applyOverlay: boolean,
  morphValue: number
): Step | undefined {
  const idx = originatorIndex(track, i);
  const authored = track.steps[idx];
  if (!authored) return authored;
  let base = authored;
  if (track.slotA && track.slotB) {
    const a = track.slotA[idx];
    const b = track.slotB[idx];
    if (a && b) {
      base = morphStep(a, b, morphValue, stepSeed(track.id, idx));
    }
  }
  if (applyOverlay) {
    const ov = getOverlay(track.id, idx);
    if (ov) return { ...base, on: ov.on, velocity: ov.velocity, pitch: ov.pitch, gate: ov.gate };
  }
  return base;
}

export function Track({ track }: { track: TrackData }) {
  const globalStep = useSequencerStore((s) => s.globalStep);
  const playing = useSequencerStore((s) => s.playing);
  const lfos = useSequencerStore((s) => s.lfos);
  const density = useSequencerStore((s) => s.density);
  const anySolo = useSequencerStore((s) => s.tracks.some((t) => t.solo));
  const morphLFOs = findRouted(lfos, track.id, 'morph');
  const liveMorph = useLFOValue(track.morph, morphLFOs, 1);
  // Live density value for chance-mode opacity. Mirrors the gate the dispatch
  // loop uses, so twisting macros fades the grid at the same rate the audio
  // thins out. Metric-weighted density is computed per step in the render loop
  // below (downbeat preserved, offbeats fade first).
  const densityLFOs = findRouted(lfos, GLOBAL_TRACK_ID, 'density');
  const liveDensity = useLFOValue(density, densityLFOs, 1);
  // Empty rows shouldn't get density fill-in — keep them silent regardless.
  const hasAuthoredOn = track.steps
    .slice(0, track.length)
    .some((s) => s.on);
  const setTrackSource = useSequencerStore((s) => s.setTrackSource);
  const setTrackMute = useSequencerStore((s) => s.setTrackMute);
  const setTrackSolo = useSequencerStore((s) => s.setTrackSolo);
  const setTrackPage = useSequencerStore((s) => s.setTrackPage);
  const clearTrack = useSequencerStore((s) => s.clearTrack);
  const snapTrackSlot = useSequencerStore((s) => s.snapTrackSlot);
  const recallTrackSlot = useSequencerStore((s) => s.recallTrackSlot);
  const setTrackLockTiming = useSequencerStore((s) => s.setTrackLockTiming);

  const [panelOpen, setPanelOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const silenced = track.mute || (anySolo && !track.solo);
  const melodic = sourceIsMelodic(track.source);

  // dropdown filters internal voices and instruments to the row's section
  const isDrumSection = track.section === 'drum';
  const sampleVoices = VOICES.filter((v) =>
    isDrumSection ? v.category === 'drum' : v.category === 'melodic'
  );
  const drumInstruments = INSTRUMENTS.filter((i) => i.role === 'drum');
  const padInstruments = INSTRUMENTS.filter((i) => i.role === 'pad');
  const leadInstruments = INSTRUMENTS.filter((i) => i.role === 'lead');
  const bassInstruments = INSTRUMENTS.filter((i) => i.role === 'bass');

  const sourceValue =
    track.source.kind === 'empty' ? 'empty' : `${track.source.kind}:${track.source.id}`;

  const handleSourceChange = (raw: string) => {
    if (raw === 'empty') {
      setTrackSource(track.id, { kind: 'empty' });
      return;
    }
    const [kind, id] = raw.split(':', 2);
    if (kind === 'voice' && id) {
      setTrackSource(track.id, { kind: 'voice', id });
    } else if (kind === 'instrument' && id) {
      setTrackSource(track.id, { kind: 'instrument', id } satisfies TrackSource);
    }
  };

  const stride = RATE_STRIDE[track.rate];
  const localCurrent = Math.floor(globalStep / stride) % track.length;
  const playingPage = Math.floor(localCurrent / PAGE_SIZE);
  const stepInPage = localCurrent % PAGE_SIZE;
  const viewPage = track.viewPage;

  return (
    <div className="flex items-center" style={{ gap: STEP_SIZE }}>
      <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <select
          value={sourceValue}
          onChange={(e) => handleSourceChange(e.target.value)}
          style={{ height: STEP_SIZE }}
          className="select-chevron w-[100px] bg-transparent border border-white/15 text-[11px] uppercase tracking-widest text-white pl-3 focus:outline-none focus:border-white"
          title="source"
        >
          <option value="empty" className="bg-[#050505]">—</option>
          <optgroup label="samples" className="bg-[#050505]">
            {sampleVoices.map((v) => (
              <option key={v.id} value={`voice:${v.id}`} className="bg-[#050505]">
                {v.label}
              </option>
            ))}
          </optgroup>
          {isDrumSection && drumInstruments.length > 0 && (
            <optgroup label="drum" className="bg-[#050505]">
              {drumInstruments.map((i) => (
                <option key={i.id} value={`instrument:${i.id}`} className="bg-[#050505]">
                  {i.label}
                </option>
              ))}
            </optgroup>
          )}
          {!isDrumSection && padInstruments.length > 0 && (
            <optgroup label="pad" className="bg-[#050505]">
              {padInstruments.map((i) => (
                <option key={i.id} value={`instrument:${i.id}`} className="bg-[#050505]">
                  {i.label}
                </option>
              ))}
            </optgroup>
          )}
          {!isDrumSection && leadInstruments.length > 0 && (
            <optgroup label="lead" className="bg-[#050505]">
              {leadInstruments.map((i) => (
                <option key={i.id} value={`instrument:${i.id}`} className="bg-[#050505]">
                  {i.label}
                </option>
              ))}
            </optgroup>
          )}
          {!isDrumSection && bassInstruments.length > 0 && (
            <optgroup label="bass" className="bg-[#050505]">
              {bassInstruments.map((i) => (
                <option key={i.id} value={`instrument:${i.id}`} className="bg-[#050505]">
                  {i.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
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
            />
          )}
        </div>
        {(['mutation', 'fxSend', 'rowRatchet', 'morph'] as const).map((knob) => (
          <TrackKnob key={knob} track={track} knob={knob} size={STEP_SIZE} />
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
        {(['A', 'B'] as const).map((slot) => {
          const filled = slot === 'A' ? !!track.slotA : !!track.slotB;
          return (
            <button
              key={slot}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  snapTrackSlot(track.id, slot, true);
                  return;
                }
                if (e.shiftKey) {
                  snapTrackSlot(track.id, slot);
                  return;
                }
                if (filled) recallTrackSlot(track.id, slot);
                else snapTrackSlot(track.id, slot);
              }}
              style={{ width: STEP_SIZE, height: STEP_SIZE }}
              className={[
                'flex items-center justify-center text-[10px] uppercase tracking-widest font-bold transition-colors',
                filled
                  ? 'bg-white/20 text-white hover:bg-white/30'
                  : 'bg-white/5 text-white/40 hover:bg-white/15',
              ].join(' ')}
              title={
                filled
                  ? `slot ${slot}: click to recall · shift-click to overwrite · cmd-click to clear`
                  : `save current to slot ${slot}`
              }
            >
              {slot}
            </button>
          );
        })}
      </div>
      </div>

      <div
        className={`flex items-center transition-opacity ${silenced ? 'opacity-30' : ''}`}
      >
      <div className="flex" style={{ gap: `${STEP_GAP}px` }}>
        {Array.from({ length: NUM_PAGES }, (_, p) => {
          const reachable = p * PAGE_SIZE < track.length;
          const isActive = p === viewPage;
          return (
            <button
              key={p}
              onClick={() => reachable && setTrackPage(track.id, p)}
              disabled={!reachable}
              style={{ width: STEP_SIZE, height: STEP_SIZE }}
              className={
                isActive
                  ? 'bg-white'
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

      <div className="flex" style={{ gap: STEP_GAP }}>
        {Array.from(
          { length: Math.max(0, Math.min(PAGE_SIZE, track.length - viewPage * PAGE_SIZE)) },
          (_, i) => {
            const stepIndex = viewPage * PAGE_SIZE + i;
            const idx = originatorIndex(track, stepIndex);
            const isTiedChain = idx !== stepIndex;
            const display = displayStep(track, stepIndex, playing && track.mutation > 0, liveMorph);
            const isCurrent = playing && playingPage === viewPage && stepInPage === i;
            // "Currently firing this cycle" — drives the binary visual in note
            // mode for both directions of the density knob: authored ON cells
            // disappear when thinned out, authored OFF cells light up when
            // filled in. Gated on `passed` so cells ahead of the playhead keep
            // showing authored intent; the live outcome only "comes in" as the
            // playhead reaches each step. Each cycle wrap resets the trail.
            const passed = !playing || stepIndex <= localCurrent;
            const ovForCycle = playing && passed ? getOverlay(track.id, idx) : undefined;
            const cycleFired =
              playing && passed
                ? !!ovForCycle?.gated
                : !!track.steps[idx]?.on;
            return (
              <StepButton
                key={i}
                trackId={track.id}
                index={stepIndex}
                on={display?.on ?? false}
                velocity={display?.velocity ?? 1}
                probability={
                  display?.on
                    ? Math.min(
                        100,
                        (display.probability ?? 100) *
                          computeThinMul(liveDensity, stepIndex, track.length)
                      )
                    : hasAuthoredOn
                      ? 100 * computeFillProb(liveDensity, stepIndex, track.length)
                      : 0
                }
                ratchet={display?.ratchet ?? 1}
                microTiming={display?.microTiming ?? 0}
                gate={display?.gate ?? 1}
                isMelodic={melodic}
                isCurrent={isCurrent}
                isTiedChain={isTiedChain}
                size={STEP_SIZE}
                cycleFired={cycleFired}
              />
            );
          }
        )}
      </div>
      </div>
    </div>
  );
}
