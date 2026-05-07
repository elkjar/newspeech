import { useSequencerStore, type Track as TrackData } from '../state/store';
import { StepButton } from './StepButton';

const GRID_TARGET_WIDTH = 640;
const STEP_GAP = 6;
const STEP_MIN = 14;
const STEP_MAX = 40;

function computeStepSize(length: number) {
  const totalGap = (length - 1) * STEP_GAP;
  const raw = (GRID_TARGET_WIDTH - totalGap) / length;
  return Math.max(STEP_MIN, Math.min(STEP_MAX, raw));
}

export function Track({ track }: { track: TrackData }) {
  const globalStep = useSequencerStore((s) => s.globalStep);
  const playing = useSequencerStore((s) => s.playing);
  const setTrackType = useSequencerStore((s) => s.setTrackType);
  const setTrackMute = useSequencerStore((s) => s.setTrackMute);
  const setTrackSolo = useSequencerStore((s) => s.setTrackSolo);
  const setTrackLength = useSequencerStore((s) => s.setTrackLength);

  const pillBase =
    'w-6 h-6 text-[10px] uppercase border transition-colors flex items-center justify-center';
  const pillIdle = 'border-white/30 hover:border-white/70';
  const pillActive = 'bg-white text-ink border-white';

  const localCurrent = globalStep % track.length;
  const stepSize = computeStepSize(track.length);

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
      <div className="flex" style={{ gap: `${STEP_GAP}px` }}>
        {track.steps.slice(0, track.length).map((step, i) => (
          <StepButton
            key={i}
            trackId={track.id}
            index={i}
            on={step.on}
            velocity={step.velocity}
            probability={step.probability}
            isMelodic={track.type === 'melodic'}
            isCurrent={playing && localCurrent === i}
            size={stepSize}
          />
        ))}
      </div>
    </div>
  );
}
