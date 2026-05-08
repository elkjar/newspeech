import { useEffect, useState } from 'react';
import { getMIDIOutputs, onMIDIOutputsChanged, type MIDIOutputInfo } from '../audio/midiOut';

export function useMIDIOutputs(): MIDIOutputInfo[] {
  const [list, setList] = useState<MIDIOutputInfo[]>(() => getMIDIOutputs());
  useEffect(() => {
    setList(getMIDIOutputs());
    return onMIDIOutputsChanged(() => setList(getMIDIOutputs()));
  }, []);
  return list;
}
