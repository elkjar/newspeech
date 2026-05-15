import { useEffect, useState } from 'react';
import { getConnectedInputNames, onMIDIInputsChanged } from '../midi/midiIn';

export function useMIDIInputs(): string[] {
  const [list, setList] = useState<string[]>(() => getConnectedInputNames());
  useEffect(() => {
    setList(getConnectedInputNames());
    return onMIDIInputsChanged(() => setList(getConnectedInputNames()));
  }, []);
  return list;
}
