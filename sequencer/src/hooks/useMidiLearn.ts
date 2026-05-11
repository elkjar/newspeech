// Hook for any UI control that wants to be a MIDI-learn target.
// Returns the learn-mode flag, whether this target is the active
// pinned one, whether it has a binding, and an onClick override that
// pins the target when learn mode is on.

import { useMidiMapStore } from '../midi/midiMapStore';
import type { MidiTarget } from '../midi/midiMap';

export interface MidiLearnState {
  learning: boolean;
  isLearnTarget: boolean;
  bound: boolean;
  bindingLabel?: string;
  onLearnClick?: () => void;
}

export function useMidiLearn(target: MidiTarget | undefined): MidiLearnState {
  const learning = useMidiMapStore((s) => s.learnMode);
  const learnTarget = useMidiMapStore((s) => s.learnTarget);
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const setLearnTarget = useMidiMapStore((s) => s.setLearnTarget);

  if (!target) return { learning: false, isLearnTarget: false, bound: false };

  const map = activeId ? midiMaps[activeId] : null;
  const binding = map?.bindings.find((b) => b.target === target) ?? null;
  const bound = !!binding;
  const bindingLabel = binding
    ? binding.msg === 'cc'
      ? `cc${binding.num}`
      : `n${binding.num}`
    : undefined;

  return {
    learning,
    isLearnTarget: learnTarget === target,
    bound,
    bindingLabel,
    onLearnClick: learning ? () => setLearnTarget(target) : undefined,
  };
}
