// React hook that subscribes a component to the manifest registry. Re-renders
// whenever kits register / unregister so source-picker dropdowns populate as
// manifests load asynchronously after first paint. Backed by
// useSyncExternalStore for tear-free reads across concurrent rendering.

import { useSyncExternalStore } from 'react';
import { getVoices } from '../audio/voices';
import type { VoiceDef } from '../audio/voices';
import { subscribe } from './manifestRegistry';

export function useRegistryVoices(): VoiceDef[] {
  return useSyncExternalStore(subscribe, getVoices, getVoices);
}
