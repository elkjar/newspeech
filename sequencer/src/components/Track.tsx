import {
  useSequencerStore,
  type Track as TrackData,
  type Step,
  PAGE_SIZE,
  NUM_PAGES,
} from '../state/store';
import { StepButton } from './StepButton';
import { Knob } from './Knob';
import { VOICES, isMelodicVoice } from '../audio/voices';
import { getOverlay } from '../audio/mutationOverlay';
import { morphStep, stepSeed } from '../audio/morph';

const STEP_GAP = 6;
const STEP_SIZE = 36;

function originatorIndex(track: TrackData, i: number): number {
  const len = track.length;
  if (len <= 0) return i;
  let cur = i;
  let originatorIdx = i;
  while (cur > 0) {
    const prev = cur - 1;
    const prevStep = track.steps[prev];
    if (!prevStep?.tieToNext) break;
    cur = prev;
    if (prevStep.on) originatorIdx = prev;
  }
  return originatorIdx;
}

function displayStep(track: TrackData, i: number, applyOverlay: boolean): Step | undefined {
  const idx = originatorIndex(track, i);
  const authored = track.steps[idx];
  if (!authored) return authored;
  let base = authored;
  if (track.slotA && track.slotB && track.morph > 0) {
    const a = track.slotA[idx];
    const b = track.slotB[idx];
    if (a && b) {
      base = morphStep(a, b, track.morph, stepSeed(track.id, idx));
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
  const anySolo = useSequencerStore((s) => s.tracks.some((t) => t.solo));
  const setTrackVoice = useSequencerStore((s) => s.setTrackVoice);
  const setTrackMute = useSequencerStore((s) => s.setTrackMute);
  const setTrackSolo = useSequencerStore((s) => s.setTrackSolo);
  const setTrackLength = useSequencerStore((s) => s.setTrackLength);
  const setTrackPage = useSequencerStore((s) => s.setTrackPage);
  const setTrackEuclidean = useSequencerStore((s) => s.setTrackEuclidean);
  const clearTrack = useSequencerStore((s) => s.clearTrack);
  const snapTrackSlot = useSequencerStore((s) => s.snapTrackSlot);
  const recallTrackSlot = useSequencerStore((s) => s.recallTrackSlot);

  const silenced = track.mute || (anySolo && !track.solo);
  const melodic = isMelodicVoice(track.voice);

  const drumVoices = VOICES.filter((v) => v.category === 'drum');
  const melodicVoices = VOICES.filter((v) => v.category === 'melodic');

  const localCurrent = globalStep % track.length;
  const playingPage = Math.floor(localCurrent / PAGE_SIZE);
  const stepInPage = localCurrent % PAGE_SIZE;
  const viewPage = track.viewPage;

  return (
    <div className="flex items-center" style={{ gap: STEP_SIZE }}>
      <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <select
          value={track.voice}
          onChange={(e) => setTrackVoice(track.id, e.target.value)}
          style={{ height: STEP_SIZE }}
          className="select-chevron w-[100px] bg-transparent border border-white/15 text-[11px] uppercase tracking-widest text-white pl-3 focus:outline-none focus:border-white"
          title="voice"
        >
          <optgroup label="drum" className="bg-[#050505]">
            {drumVoices.map((v) => (
              <option key={v.id} value={v.id} className="bg-[#050505]">
                {v.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="melodic" className="bg-[#050505]">
            {melodicVoices.map((v) => (
              <option key={v.id} value={v.id} className="bg-[#050505]">
                {v.label}
              </option>
            ))}
          </optgroup>
        </select>
        <input
          type="number"
          min={1}
          max={64}
          value={track.length}
          onChange={(e) => setTrackLength(track.id, Number(e.target.value))}
          style={{ width: STEP_SIZE, height: STEP_SIZE }}
          className="bg-transparent border border-white/15 text-center text-[14px] tabular-nums focus:outline-none focus:border-white"
          title="track length"
        />
        <input
          type="number"
          min={0}
          max={track.length}
          value={track.euclidean.hits}
          onChange={(e) => setTrackEuclidean(track.id, { hits: Number(e.target.value) })}
          style={{ width: STEP_SIZE, height: STEP_SIZE }}
          className="bg-transparent border border-white/15 text-center text-[14px] tabular-nums focus:outline-none focus:border-white"
          title="euclidean hits"
        />
        <input
          type="number"
          min={0}
          max={Math.max(0, track.length - 1)}
          value={track.euclidean.rotation}
          onChange={(e) => setTrackEuclidean(track.id, { rotation: Number(e.target.value) })}
          style={{ width: STEP_SIZE, height: STEP_SIZE }}
          className="bg-transparent border border-white/15 text-center text-[14px] tabular-nums focus:outline-none focus:border-white"
          title="euclidean rotation"
        />
        <Knob
          value={track.mutation}
          onChange={(v) => useSequencerStore.getState().setTrackMutation(track.id, v)}
          title={`mutation ${Math.round(track.mutation * 100)}%`}
          size={STEP_SIZE}
        />
        <Knob
          value={track.rowChance}
          onChange={(v) => useSequencerStore.getState().setTrackRowChance(track.id, v)}
          title={`row chance ${Math.round(track.rowChance * 100)}%`}
          size={STEP_SIZE}
        />
        <Knob
          value={track.rowRatchet}
          onChange={(v) => useSequencerStore.getState().setTrackRowRatchet(track.id, v)}
          title={`row ratchet ${Math.round(track.rowRatchet * 100)}%`}
          size={STEP_SIZE}
        />
        <Knob
          value={track.morph}
          onChange={(v) => useSequencerStore.getState().setTrackMorph(track.id, v)}
          title={`morph ${Math.round(track.morph * 100)}%`}
          size={STEP_SIZE}
        />
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
        style={{ gap: STEP_SIZE }}
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

      <div className="flex" style={{ gap: STEP_GAP }}>
        {Array.from(
          { length: Math.max(0, Math.min(PAGE_SIZE, track.length - viewPage * PAGE_SIZE)) },
          (_, i) => {
            const stepIndex = viewPage * PAGE_SIZE + i;
            const idx = originatorIndex(track, stepIndex);
            const isTiedChain = idx !== stepIndex;
            const display = displayStep(track, stepIndex, playing && track.mutation > 0);
            const isCurrent = playing && playingPage === viewPage && stepInPage === i;
            return (
              <StepButton
                key={i}
                trackId={track.id}
                index={stepIndex}
                on={display?.on ?? false}
                velocity={display?.velocity ?? 1}
                probability={(display?.probability ?? 100) * (1 - track.rowChance)}
                ratchet={display?.ratchet ?? 1}
                microTiming={display?.microTiming ?? 0}
                gate={display?.gate ?? 1}
                isMelodic={melodic}
                isCurrent={isCurrent}
                isTiedChain={isTiedChain}
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
