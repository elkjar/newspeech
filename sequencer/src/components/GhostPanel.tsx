import { useState } from 'react';
import {
  generateBank,
  GEN_MOVE_LABELS,
  COMPOSE_MOVES,
  type GenMove,
} from '../ghost/generator';

// Ghost controls — generate-bank picker only. Styling mirrors the
// TransportControls row (BPM / root / scale) so generate sits naturally
// at the right end of that line.
export function GhostPanel() {
  const [move, setMove] = useState<GenMove>('compose-sparse');
  const handleGenerate = () => {
    generateBank(move);
  };
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
        <span className="opacity-55">gen</span>
        <select
          value={move}
          onChange={(e) => setMove(e.target.value as GenMove)}
          className="select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white h-[28px]"
          title="compose recipe — generate a new bank from scratch"
        >
          {COMPOSE_MOVES.map((m) => (
            <option key={m} value={m} className="bg-[#050505]">
              {GEN_MOVE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={handleGenerate}
        title="generate a new bank from the selected recipe"
        className="bg-transparent border border-white/15 hover:border-white px-3 text-[11px] uppercase tracking-widest text-white/70 hover:text-white transition-colors h-[28px]"
      >
        generate
      </button>
    </div>
  );
}
