import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { ensureAudioRunning } from '../audio/audioContext';
import { NOTE_NAMES, SCALES } from '../audio/scale';

export function Transport() {
  const bpm = useSequencerStore((s) => s.bpm);
  const playing = useSequencerStore((s) => s.playing);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const setBpm = useSequencerStore((s) => s.setBpm);
  const setPlaying = useSequencerStore((s) => s.setPlaying);
  const setRootNote = useSequencerStore((s) => s.setRootNote);
  const setScale = useSequencerStore((s) => s.setScale);

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

  const rootName = NOTE_NAMES[rootNote % 12];

  return (
    <div className="flex items-center gap-8 flex-wrap">
      <button
        onClick={togglePlay}
        className="px-6 py-3 border border-white/30 hover:border-white uppercase tracking-widest text-xs transition-colors"
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
          className="w-20 bg-transparent border border-white/30 px-2 py-1 tabular-nums focus:outline-none focus:border-white"
        />
      </label>
      <label className="flex items-center gap-3 text-xs uppercase tracking-widest opacity-70">
        <span>root</span>
        <select
          value={rootName}
          onChange={(e) => {
            const idx = NOTE_NAMES.indexOf(e.target.value);
            if (idx >= 0) setRootNote(60 + idx);
          }}
          className="bg-transparent border border-white/30 px-2 py-1 focus:outline-none focus:border-white text-white"
        >
          {NOTE_NAMES.map((n) => (
            <option key={n} value={n} className="bg-[#050505]">
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-3 text-xs uppercase tracking-widest opacity-70">
        <span>scale</span>
        <select
          value={scale}
          onChange={(e) => setScale(e.target.value as typeof scale)}
          className="bg-transparent border border-white/30 px-2 py-1 focus:outline-none focus:border-white text-white"
        >
          {SCALES.map((s) => (
            <option key={s} value={s} className="bg-[#050505]">
              {s}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
