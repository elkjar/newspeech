import { Fragment } from 'react';
import { useSequencerStore, type Track as TrackData, PAGE_SIZE, NUM_PAGES } from '../state/store';
import { StepButton } from './StepButton';

const STEP_GAP = 6;
const STEP_SIZE = 36;

export function Track({ track }: { track: TrackData }) {
  const globalStep = useSequencerStore((s) => s.globalStep);
  const playing = useSequencerStore((s) => s.playing);
  const anySolo = useSequencerStore((s) => s.tracks.some((t) => t.solo));
  const setTrackType = useSequencerStore((s) => s.setTrackType);
  const setTrackMute = useSequencerStore((s) => s.setTrackMute);
  const setTrackSolo = useSequencerStore((s) => s.setTrackSolo);
  const setTrackLength = useSequencerStore((s) => s.setTrackLength);
  const setTrackPage = useSequencerStore((s) => s.setTrackPage);
  const setTrackEuclidean = useSequencerStore((s) => s.setTrackEuclidean);

  const silenced = track.mute || (anySolo && !track.solo);

  const pillBase =
    'w-6 h-6 text-[10px] uppercase border transition-colors flex items-center justify-center';
  const pillIdle = 'border-white/30 hover:border-white/70';

  const localCurrent = globalStep % track.length;
  const playingPage = Math.floor(localCurrent / PAGE_SIZE);
  const stepInPage = localCurrent % PAGE_SIZE;
  const viewPage = track.viewPage;

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-[240px]">
        <span className="w-14 text-xs uppercase tracking-widest opacity-80 truncate">
          {track.name}
        </span>
        <button
          onClick={() =>
            setTrackType(track.id, track.type === 'drum' ? 'melodic' : 'drum')
          }
          className={`${pillBase} ${pillIdle}`}
          title={track.type === 'drum' ? 'drum (click for melodic)' : 'melodic (click for drum)'}
        >
          {track.type === 'drum' ? 'd' : 'm'}
        </button>
        <input
          type="number"
          min={1}
          max={64}
          value={track.length}
          onChange={(e) => setTrackLength(track.id, Number(e.target.value))}
          className="w-10 bg-transparent border border-white/30 text-[10px] tabular-nums px-1 py-0.5 focus:outline-none focus:border-white"
          title="track length"
        />
        <span className="text-[9px] uppercase tracking-widest text-white/40 ml-1">eu</span>
        <input
          type="number"
          min={0}
          max={track.length}
          value={track.euclidean.hits}
          onChange={(e) => setTrackEuclidean(track.id, { hits: Number(e.target.value) })}
          className="w-10 bg-transparent border border-white/30 text-[10px] tabular-nums px-1 py-0.5 focus:outline-none focus:border-white"
          title="euclidean hits"
        />
        <input
          type="number"
          min={0}
          max={Math.max(0, track.length - 1)}
          value={track.euclidean.rotation}
          onChange={(e) => setTrackEuclidean(track.id, { rotation: Number(e.target.value) })}
          className="w-10 bg-transparent border border-white/30 text-[10px] tabular-nums px-1 py-0.5 focus:outline-none focus:border-white"
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

      <div
        className={`flex items-center gap-3 transition-opacity ${silenced ? 'opacity-30' : ''}`}
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

      <div className="flex">
        {Array.from(
          { length: Math.max(0, Math.min(PAGE_SIZE, track.length - viewPage * PAGE_SIZE)) },
          (_, i) => {
            const visibleCount = Math.max(
              0,
              Math.min(PAGE_SIZE, track.length - viewPage * PAGE_SIZE)
            );
            const stepIndex = viewPage * PAGE_SIZE + i;
            const step = track.steps[stepIndex];
            const isCurrent = playing && playingPage === viewPage && stepInPage === i;
            const tied = step?.tieToNext === true;
            return (
              <Fragment key={i}>
                <StepButton
                  trackId={track.id}
                  index={stepIndex}
                  on={step?.on ?? false}
                  velocity={step?.velocity ?? 1}
                  probability={step?.probability ?? 100}
                  ratchet={step?.ratchet ?? 1}
                  microTiming={step?.microTiming ?? 0}
                  gate={step?.gate ?? 1}
                  isMelodic={track.type === 'melodic'}
                  isCurrent={isCurrent}
                  size={STEP_SIZE}
                />
                {i < visibleCount - 1 && (
                  <div
                    style={{
                      width: STEP_GAP,
                      height: STEP_SIZE,
                      background: tied ? '#fff' : 'transparent',
                    }}
                  />
                )}
              </Fragment>
            );
          }
        )}
      </div>
      </div>
    </div>
  );
}
