import { ensureAudioRunning } from './audioContext';
import { scheduler } from './scheduler';
import { useSequencerStore } from '../state/store';

export async function togglePlayback(): Promise<void> {
  const store = useSequencerStore.getState();
  if (store.playing) {
    scheduler.stop();
    store.setPlaying(false);
    store.commitMutationOverlay();
  } else {
    await ensureAudioRunning();
    scheduler.start();
    store.setPlaying(true);
  }
}
