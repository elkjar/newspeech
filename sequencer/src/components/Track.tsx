import { useSequencerStore, type Track as TrackData, PAGE_SIZE, NUM_PAGES } from '../state/store';
import { StepButton } from './StepButton';

const STEP_GAP = 6;
const STEP_SIZE = 36;

export function Track({ track }: { track: TrackData }) {
  const globalStep = useSequencerStore((s) => s.globalStep);
  const playing = useSequencerStore((s) => s.playing);
  const setTrackType = useSequencerStore((s) => s.setTrackType);
  const setTrackMute = useSequencerStore((s) => s.setTrackMute);
  const setTrackSolo = useSequencerStore((s) => s.setTrackSolo);
  const setTrackLength = useSequencerStore((s) => s.setTrackLength);
  const setTrackPage = useSequencerStore((s) => s.setTrackPage);

  const pillBase =
    'w-6 h-6 text-[10px] uppercase border transition-colors flex items-center justify-center';
  const pillIdle = 'border-white/30 hover:border-white/70';
  const pillActive = 'bg-white text-ink border-white';

  const localCurrent = globalStep % track.length;
  const playingPage = Math.floor(localCurrent / PAGE_SIZE);
  const stepInPage = localCurrent % PAGE_SIZE;
  const viewPage = track.viewPage;

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-[220px]">
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
        <button
          onClick={() => setTrackMute(track.id, !track.mute)}
          className={`${pillBase} ${track.mute ? pillActive : pillIdle}`}
          title="mute"
        >
          m
        </button>
        <button
          onClick={() => setTrackSolo(track.id, !track.solo)}
          className={`${pillBase} ${track.solo ? pillActive : pillIdle}`}
          title="solo"
        >
          s
        </button>
        <input
          type="number"
          min={1}
          max={64}
          value={track.length}
          onChange={(e) => setTrackLength(track.id, Number(e.target.value))}
          className="w-12 bg-transparent border border-white/30 text-[10px] tabular-nums px-1 py-0.5 focus:outline-none focus:border-white"
          title="track length"
        />
      </div>

      <div className="flex gap-1">
        {Array.from({ length: NUM_PAGES }, (_, p) => {
          const reachable = p * PAGE_SIZE < track.length;
          const isActive = p === viewPage;
          return (
            <button
              key={p}
              onClick={() => reachable && setTrackPage(track.id, p)}
              disabled={!reachable}
              className={
                isActive
                  ? 'w-3 h-3 bg-white'
                  : reachable
                    ? 'w-3 h-3 bg-white/25 hover:bg-white/50 transition-colors'
                    : 'w-3 h-3 bg-white/[0.05] cursor-not-allowed'
              }
              title={`page ${p + 1}`}
            />
          );
        })}
      </div>

      <div className="flex" style={{ gap: `${STEP_GAP}px` }}>
        {Array.from(
          { length: Math.max(0, Math.min(PAGE_SIZE, track.length - viewPage * PAGE_SIZE)) },
          (_, i) => {
            const stepIndex = viewPage * PAGE_SIZE + i;
            const step = track.steps[stepIndex];
            const isCurrent = playing && playingPage === viewPage && stepInPage === i;
            return (
              <StepButton
                key={i}
                trackId={track.id}
                index={stepIndex}
                on={step?.on ?? false}
                velocity={step?.velocity ?? 1}
                probability={step?.probability ?? 100}
                isMelodic={track.type === 'melodic'}
                isCurrent={isCurrent}
                size={STEP_SIZE}
              />
            );
          }
        )}
      </div>
    </div>
  );
}
