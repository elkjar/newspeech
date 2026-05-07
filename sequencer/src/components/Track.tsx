import {
  useSequencerStore,
  type Track as TrackData,
  type Step,
  PAGE_SIZE,
  NUM_PAGES,
} from '../state/store';
import { StepButton } from './StepButton';
import { VOICES, isMelodicVoice } from '../audio/voices';

const STEP_GAP = 6;
const STEP_SIZE = 36;

function displayStep(track: TrackData, i: number): Step | undefined {
  const len = track.length;
  const self = track.steps[i];
  if (len <= 0) return self;
  let originator: Step | undefined = self;
  let cur = i;
  while (cur > 0) {
    const prev = cur - 1;
    const prevStep = track.steps[prev];
    if (!prevStep?.tieToNext) break;
    cur = prev;
    if (prevStep.on) originator = prevStep;
  }
  return originator;
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
      </div>

      <div className="flex" style={{ gap: `${STEP_GAP}px` }}>
        <button
          onClick={() => setTrackMute(track.id, !track.mute)}
          style={{ width: STEP_SIZE, height: STEP_SIZE }}
          className={
            track.mute
              ? 'bg-white'
              : 'bg-white/5 hover:bg-white/15 transition-colors'
          }
          title="mute"
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
            const display = displayStep(track, stepIndex);
            const isTiedChain = display !== track.steps[stepIndex];
            const isCurrent = playing && playingPage === viewPage && stepInPage === i;
            return (
              <StepButton
                key={i}
                trackId={track.id}
                index={stepIndex}
                on={display?.on ?? false}
                velocity={display?.velocity ?? 1}
                probability={display?.probability ?? 100}
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
