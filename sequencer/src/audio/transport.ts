import { ensureAudioRunning } from './audioContext';
import { scheduler } from './scheduler';
import { midiPanic } from './midiOut';
import { useSequencerStore } from '../state/store';

export async function togglePlayback(): Promise<void> {
  const store = useSequencerStore.getState();
  if (store.playing) {
    scheduler.stop();
    midiPanic();
    store.setPlaying(false);
    store.commitMutationOverlay();
  } else {
    await ensureAudioRunning();
    store.fireAllProgramChanges();
    scheduler.start();
    store.setPlaying(true);
  }
}
