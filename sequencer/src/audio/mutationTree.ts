import type { Track } from '../state/store';
import type { ChordContext } from './chordContext';
import type { MutationProfile } from './voices';
import { octaveDegrees, fifthDegrees, type Scale } from './scale';

// Dev: this module's exports are captured by the audio scheduler's step callback
// (registered once at mount), so HMR can't hot-swap them in the running loop —
// edits would silently NOT take effect until a reload. Force a full reload on
// change so engine edits are always audible. No-op in production.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

// -----------------------------------------------------------------------------
// Lead mutation tree
//
// Replaces the per-cycle stochastic on-flip + pitch-jump (for lead-role melodic
// tracks only) with a DETERMINISTIC, PROGRESSIVELY-OPENING binary tree, so the
// mutation control reads as "navigate a space of related variations" rather
// than "amount of random noise."
//
// Shape: a depth-FORK_LEVELS binary tree → 2^FORK_LEVELS leaves (8 for 3). Each
// fork adds a BUNDLE of transforms and has two equal-weight variants (A / B).
// Bundles are ordered subtle → dramatic: fork 0 = gentle small-step melodic
// moves, fork 1 = fifth leaps + flips, fork 2 = octave leaps + flips.
//
// Two coordinates:
//   DEPTH  `treePos` in [0,1] (LFO-swept) = how far the tree has OPENED.
//          `reach = treePos * FORK_LEVELS` walks through the forks: fork f is
//          off until reach > f, phases in across one unit, fully on past f+1.
//          So reachable leaves grow 2 → 4 → 8 as the control rises — the tree
//          literally "opens up into 8 paths over the course of the mutation."
//   BRANCH `leaf` (A/B bitmask, bit f ← fork f) = which variant at each OPEN
//          fork. The leaf is chosen by a MARKOV WALK (markovStep, state held in
//          treeState): each loop it stays or flips one open fork, weighted by
//          dwell / home-pull / depth-decay. Single-fork moves keep each step an
//          adjacent sibling; home-pull makes the walk breathe out and resolve
//          back toward the trunk. (Replaced the old deterministic Gray cycle.)
//
// CRITICAL: the tree STRUCTURE (every variant of every fork) is seeded from the
// trackId ALONE — so the walk traverses a FIXED tree rather than re-rolling it.
// Fixed structure + single-fork Markov moves is what makes the traversal
// coherent variation-of-a-theme. leaf = 0 (all-A) is the trunk.
// -----------------------------------------------------------------------------

// Tree depth → 2^FORK_LEVELS reachable leaves (3 → 8 paths).
const FORK_LEVELS = 3;

// Rhythm-relocation budget as a fraction of the SOURCE note count. Melodic
// mutation MOVES notes (density-conserving) rather than adding them — adding is
// right for drums (energetic), wrong for melodies (nobody plays a lead by
// hammering every step). So this only scales how many authored notes relocate
// (~half); the note count itself never changes.
const MOVE_FRACTION = 0.5;

// Guardrailed density GROWTH (on top of moves). A sparse line may breathe up a
// little — adds up to GROWTH_FRACTION of its own note count — but never past
// MAX_DENSITY of the steps (the anti-spam ceiling). So 4/16 can drift to ~6,
// while 11/16 stays put (already above the ceiling). Sparse grows, dense can't.
const GROWTH_FRACTION = 0.5;
const MAX_DENSITY = 0.6;

// Diatonic shift (fork 0 — the gentle fork): move the melody's tonal centre up
// the scale while keeping its CONTOUR ("sequence the motif up a step"). Whole
// melody for small patterns (≤ this many notes), the second half for busier ones
// (state-then-echo-up). Offsets are scale DEGREES — the pitch axis is scale-
// quantized at output, so adding a constant degree-offset to a run IS a diatonic
// transposition that stays in key. Up-biased per "extend up the scale."
const WHOLE_SHIFT_MAX_NOTES = 6;
const SHIFT_OFFSETS = [1, 2, 3];

// Markov branch-walk policy (v1 — fixed defaults, tune by ear before exposing /
// letting Ghost drive). The open-fork hypercube is traversed by a weighted
// random walk instead of the old deterministic Gray cycle: each loop, stay or
// flip exactly one open fork.
const MARKOV_STAY_WEIGHT = 0.7; // dwell vs move — higher = holds a variation longer (phrasing)
const MARKOV_HOME_PULL = 1.7; // >1: flips that head back toward the trunk (B→A) favored → wander-and-return
const MARKOV_DEPTH_DECAY = 0.55; // <1: deeper/dramatic forks flipped less often than shallow/subtle ones
const WALK_SEED_OFFSET = 4096; // keep transition seeds clear of the structure seed (salt 0)

// FNV-1a 32-bit of trackId, folded with a salt, → PRNG seed. Shares the hashing
// philosophy of mutationTie.ts's stepSeed.
function fnvSeed(trackId: string, salt: number): number {
  let h = 2166136261;
  for (let i = 0; i < trackId.length; i++) {
    h ^= trackId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= salt;
  h = Math.imul(h, 16777619);
  return h >>> 0;
}

// mulberry32 — small, fast, well-distributed PRNG. Gives a reproducible stream
// from one seed so the whole tree structure is deterministic per track.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Metric strength of a 16th-grid step — the "coherent musical timing" weighting
// (quarters > eighths > sixteenth offbeats), so ADDED notes land on strong
// beats rather than true-random positions. Engine grid is 16ths; groups of 4 =
// quarter notes.
function metricWeight(i: number): number {
  if (i % 16 === 0) return 1; // bar downbeat
  if (i % 4 === 0) return 0.85; // quarter notes
  if (i % 2 === 0) return 0.5; // eighth notes
  return 0.18; // sixteenth offbeats
}

// Sample up to `n` distinct indices in [0,L) by weight, using the seeded stream
// (deterministic). Weighted without replacement so transforms spread across the
// bar instead of stacking on one step.
function pickDistinct(
  L: number,
  weightOf: (i: number) => number,
  n: number,
  rnd: () => number,
): number[] {
  const idx: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < L; i++) {
    idx.push(i);
    w.push(Math.max(0, weightOf(i)));
  }
  const out: number[] = [];
  for (let k = 0; k < n && idx.length > 0; k++) {
    let total = 0;
    for (const x of w) total += x;
    if (total <= 0) break;
    let r = rnd() * total;
    let j = 0;
    while (j < idx.length - 1 && r >= w[j]) {
      r -= w[j];
      j++;
    }
    out.push(idx[j]);
    idx.splice(j, 1);
    w.splice(j, 1);
  }
  return out;
}

// Number of forks "open" at this depth (reach = treePos*FORK_LEVELS; fork f
// opens once reach > f). The walk may only flip currently-open forks.
export function openForkCount(treePos: number): number {
  const reach = Math.max(0, Math.min(1, treePos)) * FORK_LEVELS;
  let n = 0;
  for (let f = 0; f < FORK_LEVELS; f++) if (reach > f) n++;
  return n;
}

// One step of the branch walk. From `leaf` (the A/B bitmask), deterministically
// (seeded by trackId + step) either DWELL or flip exactly one open fork,
// weighted by the policy, and return the next leaf. Single-fork moves keep each
// step an adjacent sibling (shared trunk); home-pull biases toward the trunk so
// the walk breathes out and resolves back; depth-decay keeps the dramatic forks
// rare. This replaces the deterministic Gray cycle with a steerable walk.
export function markovStep(
  trackId: string,
  leaf: number,
  step: number,
  openForks: number,
): number {
  if (openForks <= 0) return leaf;
  const rng = mulberry32(fnvSeed(trackId, step + WALK_SEED_OFFSET));
  const weights: number[] = [];
  let total = MARKOV_STAY_WEIGHT;
  for (let f = 0; f < openForks; f++) {
    const base = Math.pow(MARKOV_DEPTH_DECAY, f);
    // bit set (currently B) → flipping it returns toward the trunk (A) → favored.
    const homeward = ((leaf >>> f) & 1) === 1;
    const wt = base * (homeward ? MARKOV_HOME_PULL : 1 / MARKOV_HOME_PULL);
    weights.push(wt);
    total += wt;
  }
  let r = rng() * total;
  if (r < MARKOV_STAY_WEIGHT) return leaf; // dwell
  r -= MARKOV_STAY_WEIGHT;
  for (let f = 0; f < openForks; f++) {
    if (r < weights[f]) return leaf ^ (1 << f); // flip fork f
    r -= weights[f];
  }
  return leaf;
}

export interface VariationOpts {
  scale: Scale;
  chordContext: ChordContext;
  isChordMaster: boolean;
  profile: MutationProfile;
  // tension biases, already split into stable/color multipliers by the caller.
  tStableMul: number;
  tColorMul: number;
}

export interface TreeVariation {
  // Per authored step: does mutation toggle its on-state, and what raw pitch
  // degree-delta to add (engine clamps). `clampMax` mirrors the engine's
  // chord-tone-aware bound so the caller clamps `step.pitch + pitchJump`
  // identically to the stochastic path.
  flip: boolean[];
  pitchJump: number[];
  clampMax: number;
}

export function deriveVariation(
  track: Track,
  treePos: number,
  leaf: number,
  opts: VariationOpts,
): TreeVariation {
  const L = track.length;
  const flip = new Array<boolean>(L).fill(false);
  const pitchJump = new Array<number>(L).fill(0);

  // Pitch-jump vocabulary — mirrors resolveStepMutation's pitch block so the
  // tree speaks the same intervals (chord-tone-mode followers measure octaves
  // in chord-tone count rather than scale degrees).
  const isChordToneMode = !opts.isChordMaster && track.pitchInterp === 'chord-tone';
  const ctxLen = isChordToneMode ? Math.max(1, opts.chordContext.intervals.length) : 0;
  const oct = isChordToneMode ? ctxLen : octaveDegrees(opts.scale);
  const fifth = isChordToneMode ? 0 : fifthDegrees(opts.scale);
  const clampMax = isChordToneMode ? ctxLen : 14;
  const w = opts.profile.pitchWeights;
  const eOct = (isChordToneMode ? w.octave + w.fifth : w.octave) * opts.tStableMul;
  const eFifth = isChordToneMode ? 0 : w.fifth * opts.tStableMul;
  const eSmall = w.small * opts.tColorMul;

  if (treePos <= 0) return { flip, pitchJump, clampMax };

  // Structure seed: trackId ONLY. The whole tree is fixed per track; the leaf
  // (from the Markov walk) only chooses the path, so the walk traverses it.
  const rnd = mulberry32(fnvSeed(track.id, 0));

  const pitchWeight = (i: number) => (track.steps[i]?.on ? 1 : 0.15);
  // Density-conserving rhythm MOVES (vs adds). A move toggles one removeW step
  // and one addW step → the note relocates, count unchanged. removeW favours
  // offbeats (keep strong-beat anchors; never the bar downbeat at i=0, which the
  // engine protects anyway); addW favours grid positions.
  const removeW = (i: number) =>
    i === 0 || !track.steps[i]?.on ? 0 : 1 - metricWeight(i) * 0.75;
  const addW = (i: number) => (track.steps[i]?.on ? 0 : metricWeight(i));

  // Build one variant of a fork: nP pitch moves (magFn magnitude on pitch-
  // weighted steps), then `moves` density-conserving relocations. Each move is
  // ONE atomic closure toggling a remove + an add, so partial fork-opening can't
  // apply half a move (which would leak density). Returned as closures so the
  // in-progress fork applies partially as the control sweeps.
  const buildVariant = (
    nP: number,
    magFn: () => number,
    moves: number,
    nAdds: number,
  ): Array<() => void> => {
    const out: Array<() => void> = [];
    if (nP > 0) {
      for (const i of pickDistinct(L, pitchWeight, nP, rnd)) {
        const j = magFn();
        // += so a fifth/octave accent stacks on top of fork 0's diatonic shift
        // (a leap from the developed line, not a clobber of it). Engine clamps.
        out.push(() => { pitchJump[i] += j; });
      }
    }
    if (moves > 0 || nAdds > 0) {
      const removes = pickDistinct(L, removeW, moves, rnd);
      const m = removes.length; // actual relocations possible (may be < moves)
      // One distinct grid-weighted off-step per relocation AND per pure add.
      const offTargets = pickDistinct(L, addW, m + nAdds, rnd);
      for (let k = 0; k < m && k < offTargets.length; k++) {
        const rm = removes[k];
        const ad = offTargets[k];
        out.push(() => { flip[rm] = true; flip[ad] = true; }); // relocate — density-neutral
      }
      for (let k = m; k < offTargets.length; k++) {
        const ad = offTargets[k];
        out.push(() => { flip[ad] = true; }); // pure add — bounded density growth
      }
    }
    return out;
  };

  const fifthMag = () => (rnd() < 0.5 ? -1 : 1) * fifth;
  const octMag = () => (rnd() < 0.5 ? -1 : 1) * oct;

  // Pitch-move counts per category from the (tension-scaled) profile weights, so
  // the track's pitchWeights + tension still shape the mix. Distributed across
  // the forks by drama. Flips split across the two dramatic forks.
  const pitchTotal = eOct + eFifth + eSmall;
  const pitchTarget = Math.max(1, Math.round(L * 0.45));
  const nFifth = pitchTotal > 0 ? Math.round((pitchTarget * eFifth) / pitchTotal) : 0;
  const nOct = pitchTotal > 0 ? Math.round((pitchTarget * eOct) / pitchTotal) : 0;
  // Rhythm varies by RELOCATING notes, not adding them — count is conserved, so
  // a sparse melody can't balloon and a dense one can't spam-grow. Move budget
  // scales to the SOURCE note count (relocate ~half), bounded by how many notes
  // exist and how many empty slots there are to move them into.
  let srcOnCount = 0;
  for (let i = 0; i < L; i++) if (track.steps[i]?.on) srcOnCount++;
  const headroom = L - srcOnCount;
  const nMoves = Math.min(srcOnCount, headroom, Math.round(srcOnCount * MOVE_FRACTION));
  // Bounded growth: up to GROWTH_FRACTION of the source count, capped so the
  // final density never crosses MAX_DENSITY of the steps. Sparse breathes up
  // (4 → ~6); dense (≥ ceiling) gets 0.
  const maxOn = Math.floor(L * MAX_DENSITY);
  const nAdds = Math.max(
    0,
    Math.min(Math.round(srcOnCount * GROWTH_FRACTION), maxOn - srcOnCount),
  );

  // Fork 0 (the gentle fork) = a DIATONIC SHIFT: move the tonal centre up the
  // scale, contour intact ("sequence the motif up a step") — coherent melodic
  // development, not the contour-scrambling per-note jumps it replaced. One
  // atomic closure adds the same degree-offset to every sounding note in scope:
  // the WHOLE melody for small patterns, the SECOND HALF for busy ones (so the
  // bar reads state-then-echo-up). Density-neutral; engine scale-quantize keeps
  // it in key. A and B variants draw different offsets, so the walk varies the
  // lift amount; the arc returns it to the written centre at the edges.
  const buildDiatonicShift = (): Array<() => void> => {
    const shiftStart = srcOnCount <= WHOLE_SHIFT_MAX_NOTES ? 0 : Math.floor(L / 2);
    const offset = SHIFT_OFFSETS[Math.floor(rnd() * SHIFT_OFFSETS.length)];
    return [
      () => {
        for (let i = shiftStart; i < L; i++) {
          if (track.steps[i]?.on) pitchJump[i] += offset;
        }
      },
    ];
  };

  // Three forks, subtle → dramatic, each with an A and B variant. A-pass before
  // B-pass keeps leaf = 0 → all-A (the trunk). Rhythm (moves + the few bounded
  // adds) lives ONLY in fork 1 (the mid fork); fork 0 is the diatonic shift and
  // fork 2 (the dramatic TOP) is octave leaps only — so the bounded growth lands
  // by mid-depth and HOLDS, and reaching the top adds pitch drama, not notes.
  const mkForks = (): Array<Array<() => void>> => [
    buildDiatonicShift(), // fork 0: diatonic tonal-centre shift (contour-preserving), no rhythm
    buildVariant(nFifth, fifthMag, nMoves, nAdds), // fork 1: fifth leaps + timing shifts + bounded growth
    buildVariant(nOct, octMag, 0, 0), // fork 2: octave leaps only — pitch drama, no rhythm change
  ];
  const forkA = mkForks();
  const forkB = mkForks();

  // Progressive opening: reach walks through the forks; each opens, phases in,
  // then locks full. `leaf` (the A/B bitmask chosen by the Markov branch walk,
  // bit f ← fork f) selects each open fork's variant. Closed forks' bits are
  // ignored here (their bundle isn't applied), so they stay frozen until they
  // reopen.
  const reach = treePos * FORK_LEVELS;
  for (let f = 0; f < FORK_LEVELS; f++) {
    const localReach = Math.max(0, Math.min(1, reach - f));
    if (localReach <= 0) continue;
    const variant = ((leaf >>> f) & 1) === 1 ? forkB[f] : forkA[f];
    const cnt = Math.round(localReach * variant.length);
    for (let j = 0; j < cnt; j++) variant[j]();
  }

  return { flip, pitchJump, clampMax };
}
