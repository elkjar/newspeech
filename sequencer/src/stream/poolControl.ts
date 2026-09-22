// External nudges for the pool (Pool.tsx): anything that isn't a bank commit
// but should still turn the picture over — BROADCAST's record clock while a
// finished audio file plays and Ghost is idle. A counter, not a callback, so
// the pool subscribes like it does to everything else.
import { create } from 'zustand';

interface PoolControl {
  tick: number;
}
export const usePoolControl = create<PoolControl>(() => ({ tick: 0 }));

export function advancePool(): void {
  usePoolControl.setState((s) => ({ tick: s.tick + 1 }));
}
