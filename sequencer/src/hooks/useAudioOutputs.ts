import { useEffect, useState } from 'react';
import {
  getAudioOutputs,
  onAudioOutputsChanged,
  type AudioOutputInfo,
} from '../audio/audioOutput';

export function useAudioOutputs(): AudioOutputInfo[] {
  const [list, setList] = useState<AudioOutputInfo[]>(() => getAudioOutputs());
  useEffect(() => {
    setList(getAudioOutputs());
    return onAudioOutputsChanged(() => setList(getAudioOutputs()));
  }, []);
  return list;
}
