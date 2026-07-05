// React hook returning every registered sample kit.
// Mirrors useRegistryVoices but at kit granularity — for surfaces that
// want to display voices grouped by source pack.

import { useSyncExternalStore } from 'react';
import { getRegisteredKits, subscribe, type RegisteredKit } from './manifestRegistry';

function snapshot(): readonly RegisteredKit[] {
  return getRegisteredKits();
}

export function useRegistryKits(): readonly RegisteredKit[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
