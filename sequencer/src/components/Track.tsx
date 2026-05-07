import { useSequencerStore, type Track as TrackData } from '../state/store';
import { StepButton } from './StepButton';

export function Track({ track }: { track: TrackData }) {
  const currentStep = useSequencerStore((s) => s.currentStep);
  const playing = useSequencerStore((s) => s.playing);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const setTrackType = useSequencerStore((s) => s.setTrackType);
  const setTrackMute = useSequencerStore((s) => s.setTrackMute);
  const setTrackSolo = useSequencerStore((s) => s.setTrackSolo);
  const setTrackVolume = useSequencerStore((s) => s.setTrackVolume);

  const pillBase =
    'w-6 h-6 text-[10px] uppercase border transition-colors flex items-center justify-center';
  const pillIdle = 'border-white/30 hover:border-white/70';
  const pillActive = 'bg-white text-ink border-white';

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-[240px]">
        <span className="w-16 text-xs uppercase tracking-widest opacity-80 truncate">
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
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          onChange={(e) => setTrackVolume(track.id, Number(e.target.value))}
          className="w-20 accent-white"
          title="volume"
        />
      </div>
      <div className="flex gap-1.5">
        {track.steps.map((step, i) => (
          <StepButton
            key={i}
            trackId={track.id}
            index={i}
            on={step.on}
            pitch={step.pitch}
            isMelodic={track.type === 'melodic'}
            isCurrent={playing && currentStep === i}
            rootNote={rootNote}
            scale={scale}
          />
        ))}
      </div>
    </div>
  );
}
