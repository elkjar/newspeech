import { useShallow } from 'zustand/react/shallow';
import { useSequencerStore } from '../state/store';
import { findRouted, type LFO, type LFODestKnob } from '../audio/lfo';

// Returns the list of LFOs whose destinations include (trackId, knob), with
// a reference that's stable across store updates UNLESS the membership
// (which LFO objects appear in the filtered set) actually changes.
//
// Why this exists: every knob in the app (~80) used to do
//     const lfos = useSequencerStore((s) => s.lfos);
//     const routed = findRouted(lfos, trackId, knob);
// which meant ANY LFO mutation (depth tweak, destination toggle, freeze)
// allocated a new `lfos` array → every knob re-rendered, regardless of
// whether its own routing changed. With `useShallow`, the equality check
// compares LFO references inside the filtered array — when an unrelated
// LFO's depth changes, that LFO object identity moves but the filtered
// array contents for an unrelated knob are unchanged, so no re-render.
//
// Cost: O(LFO_COUNT × destinations) per knob per store change. With
// LFO_COUNT = 8 and a handful of destinations each, that's ~tens of ops
// per knob per change — far cheaper than reconciling the knob's React tree.
export function useRoutedLFOs(trackId: string, knob: LFODestKnob): LFO[] {
  return useSequencerStore(
    useShallow((s) => findRouted(s.lfos, trackId, knob)),
  );
}
