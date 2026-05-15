import {
  useSequencerStore,
  cloneTrack,
  BANK_SLOT_COUNT,
  TRANSITION_SLOT_START,
  type BankSlot,
  type BankKind,
} from '../../state/store';
import type { GenMove, MoveDef } from './types';
import { composeSparse } from './moves/composeSparse';
import { composePolyrhythmic } from './moves/composePolyrhythmic';
import { composeMelodic } from './moves/composeMelodic';
import { composeDrumsOnly } from './moves/composeDrumsOnly';
import { composeBuild } from './moves/composeBuild';
import { composeHits } from './moves/composeHits';
import { composeAmbient } from './moves/composeAmbient';
import { composeHalftime } from './moves/composeHalftime';
import { composeDance } from './moves/composeDance';
import { composeDriving } from './moves/composeDriving';

export { resetPalette, getCurrentPalette } from './palette';
export { type GenMove, GEN_MOVE_LABELS, RECIPE_DWELL, COMPOSE_MOVES } from './types';

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

const MOVES: Record<GenMove, MoveDef> = {
  'compose-sparse': { fn: composeSparse },
  'compose-poly': { fn: composePolyrhythmic },
  'compose-melodic': { fn: composeMelodic },
  'compose-drums': { fn: composeDrumsOnly },
  'compose-build': { fn: composeBuild },
  'compose-hits': { fn: composeHits },
  'compose-ambient': { fn: composeAmbient },
  'compose-halftime': { fn: composeHalftime },
  'compose-dance': { fn: composeDance },
  'compose-driving': { fn: composeDriving },
};

function findEmptySlot(banks: (BankSlot | null)[], kind: BankKind): number | null {
  if (kind === 'transition') {
    for (let i = TRANSITION_SLOT_START; i < BANK_SLOT_COUNT; i++) {
      if (!banks[i]) return i;
    }
    return null;
  }
  for (let i = 0; i < TRANSITION_SLOT_START; i++) {
    if (!banks[i]) return i;
  }
  return null;
}

export function generateBank(move: GenMove): { slotIndex: number } | null {
  const state = useSequencerStore.getState();
  const def = MOVES[move];
  // Tag the generated bank with its recipe so the conductor can apply
  // per-recipe dwell ranges and same-recipe avoidance.
  const newSlot: BankSlot = {
    ...def.fn({
      tracks: state.tracks,
      rootNote: state.rootNote,
      scale: state.scale,
    }),
    recipe: move,
  };
  const slotIndex = findEmptySlot(state.banks, newSlot.kind);
  if (slotIndex === null) return null;
  const banks = state.banks.slice();
  banks[slotIndex] = newSlot;
  useSequencerStore.setState({ banks });
  return { slotIndex };
}

// Auto-seed pass — called once on app mount. Wipes scene banks and fills
// slots 0-9 with one of each recipe in song-arc order (ambient → sparse →
// melodic → driving → dance → halftime → poly → drums → build → hits).
// Transition slots (14-15) are left untouched. Applies the first seeded
// bank's tracks to active state so the user opens to a recipe pattern
// rather than the default-preset stub.
//
// User-saved bank state (from persist.ts localStorage) is intentionally
// clobbered here — the model the user wants is "fresh series of patterns
// on each load," not "session-persistent banks." Voices propagate via
// store.tracks (band identity is preserved across reload via persist.ts
// hydration), so each fresh seed uses the user's current voice setup via
// activeVoice() in compose moves.
export function autoSeedBanks(): void {
  const seedOrder: GenMove[] = [
    'compose-ambient',
    'compose-sparse',
    'compose-melodic',
    'compose-driving',
    'compose-dance',
    'compose-halftime',
    'compose-poly',
    'compose-drums',
    'compose-build',
    'compose-hits',
  ];

  // Wipe scene banks; preserve transition slots (14-15) since those are
  // user-authored inserts and transition-kind compose doesn't exist.
  const wipedBanks: (BankSlot | null)[] = useSequencerStore
    .getState()
    .banks.map((b, i) => (i < TRANSITION_SLOT_START ? null : b));
  useSequencerStore.setState({
    banks: wipedBanks,
    activeBank: null,
    pendingBank: null,
  });

  // Generate in order — findEmptySlot iterates 0..TRANSITION_SLOT_START-1
  // so each call lands at the next free index.
  for (const move of seedOrder) {
    generateBank(move);
  }

  // Apply the first seeded bank's tracks to active state. Without this the
  // user opens with defaultPreset's stub tracks while activeBank claims
  // they're hearing the ambient recipe — they only see the recipe content
  // after the conductor's first scene change.
  const state = useSequencerStore.getState();
  const firstSlot = state.banks[0];
  if (firstSlot) {
    useSequencerStore.setState({
      tracks: firstSlot.tracks.map(cloneTrack),
      density: firstSlot.macros.density,
      chaos: firstSlot.macros.chaos,
      motion: firstSlot.macros.motion,
      drift: firstSlot.macros.drift,
      tension: firstSlot.macros.tension,
      activeBank: 0,
      pendingBank: null,
    });
  }
}
