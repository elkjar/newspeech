import { openForkCount, markovStep } from './mutationTree';

// Dev: captured by the scheduler step callback at mount; HMR can't hot-swap it
// in the running loop. Force a reload on change so edits take effect. No-op in prod.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

// Per-track branch-walk state for the lead mutation tree. Same module-level-Map
// shape as padState / mutationOverlay — updates fire at dispatch rate and React
// subscribers don't need to know.
//
// `leaf` is the current A/B bitmask (which fork variant the track sits on);
// `step` is the loop counter that seeds each transition deterministically. The
// engine advances the walk once per track loop (markovStep picks the next leaf
// — stay or flip one open fork). leaf 0 = the trunk (all-A) = the authored line.
interface BranchWalk {
  leaf: number;
  step: number;
}

const walks = new Map<string, BranchWalk>();

// Read the current leaf; when `advance` is true (engine passes this at a track's
// loop boundary while mutation is on) take one Markov step first, so the new
// leaf takes effect for the loop that's starting. `treePos` gates how many forks
// are open (the walk can only flip open forks). Mirrors padState.tickPadDrift's
// read-and-maybe-mutate contract.
export function consumeBranchLeaf(trackId: string, advance: boolean, treePos: number): number {
  let w = walks.get(trackId);
  if (!w) {
    w = { leaf: 0, step: 0 };
    walks.set(trackId, w);
  }
  if (advance) {
    w.leaf = markovStep(trackId, w.leaf, w.step, openForkCount(treePos));
    w.step += 1;
  }
  return w.leaf;
}

// Reset alongside resetPadDrift on importProject / applyBankSlot / preset apply
// so the walk restarts from the trunk and doesn't carry across pattern swaps.
export function resetBranchWalk(trackId?: string): void {
  if (trackId === undefined) walks.clear();
  else walks.delete(trackId);
}
