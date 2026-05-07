import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { ensureAudioRunning } from '../audio/audioContext';

export function Transport() {
  const bpm = useSequencerStore((s) => s.bpm);
  const playing = useSequencerStore((s) => s.playing);
  const setBpm = useSequencerStore((s) => s.setBpm);
  const setPlaying = useSequencerStore((s) => s.setPlaying);

  const togglePlay = async () => {
    if (playing) {
      scheduler.stop();
      setPlaying(false);
    } else {
      await ensureAudioRunning();
      scheduler.start();
      setPlaying(true);
    }
  };

  return (
    <div className="flex items-center gap-8">
      <button
        onClick={togglePlay}
        className="px-6 py-3 border border-bone/30 hover:border-bone uppercase tracking-widest text-sm transition-colors"
      >
        {playing ? '■ stop' : '▶ play'}
      </button>
      <label className="flex items-center gap-3 text-xs uppercase tracking-widest opacity-70">
        <span>bpm</span>
        <input
          type="number"
          min={40}
          max={240}
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          className="w-20 bg-transparent border border-bone/30 px-2 py-1 text-bone tabular-nums focus:outline-none focus:border-bone"
        />
      </label>
    </div>
  );
}
