import { useState } from 'react';
import {
  generateBank,
  GEN_MOVE_LABELS,
  COMPOSE_MOVES,
  type GenMove,
} from '../ghost/generator';

const ROW_HEIGHT = 'h-[28px]';

// Ghost controls — generate-bank picker only. The auto/ghost toggle
// lives in MacroStrip next to freeze; per-scene dwell is per-recipe (see
// RECIPE_DWELL in generator.ts) so the prior min/max/trans inputs were
// removed when the ghost became recipe-aware.
export function GhostPanel() {
  const [move, setMove] = useState<GenMove>('compose-sparse');
  const handleGenerate = () => {
    generateBank(move);
  };
  return (
    <div className="flex items-center gap-3 text-[11px] uppercase tracking-widest">
      <span className="opacity-55">gen</span>
      <select
        value={move}
        onChange={(e) => setMove(e.target.value as GenMove)}
        className={[
          ROW_HEIGHT,
          'px-2 bg-white/5 border border-white/15',
          'text-[11px] tracking-widest text-white',
          'focus:outline-none focus:border-white/50',
        ].join(' ')}
        title="compose recipe — generate a new bank from scratch"
      >
        {COMPOSE_MOVES.map((m) => (
          <option key={m} value={m}>
            {GEN_MOVE_LABELS[m]}
          </option>
        ))}
      </select>
      <button
        onClick={handleGenerate}
        title="generate a new bank from the selected recipe"
        className={[
          ROW_HEIGHT,
          'px-3 bg-white/5 hover:bg-white/15 border border-white/15',
          'text-[11px] uppercase tracking-widest text-white',
        ].join(' ')}
      >
        generate
      </button>
    </div>
  );
}
