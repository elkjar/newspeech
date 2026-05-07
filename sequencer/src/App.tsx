import { useEffect } from 'react';
import { PlayButton, TransportControls } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { useSequencerStore, type EditMode, type Track } from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { quantize } from './audio/scale';

const MODES: EditMode[] = ['note', 'velocity', 'chance', 'ratchet', 'timing', 'gate'];

function ModeSwitcher() {
  const editMode = useSequencerStore((s) => s.editMode);
  const setEditMode = useSequencerStore((s) => s.setEditMode);
  return (
    <div className="flex gap-2 text-[11px] uppercase tracking-widest">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => setEditMode(m)}
          className={[
            'px-3 py-1.5 border transition-colors',
            editMode === m
              ? 'bg-white text-ink border-white'
              : 'border-white/30 text-white/60 hover:text-white hover:border-white/70',
          ].join(' ')}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function isSilencedByTie(track: Track, i: number): boolean {
  const len = track.length;
  if (len <= 0) return false;
  let cur = (i - 1 + len) % len;
  for (let walked = 0; walked < len; walked++) {
    const s = track.steps[cur];
    if (!s?.tieToNext) return false;
    if (s.on) return true;
    cur = (cur - 1 + len) % len;
  }
  return false;
}

function tieLength(track: Track, i: number): number {
  const len = track.length;
  if (len <= 0) return 1;
  let count = 1;
  let cur = i;
  for (let walked = 0; walked < len; walked++) {
    if (!track.steps[cur]?.tieToNext) break;
    count++;
    cur = (cur + 1) % len;
  }
  return count;
}

export function App() {
  const bpm = useSequencerStore((s) => s.bpm);

  useEffect(() => {
    return scheduler.onStep((globalStep, when, stepDuration) => {
      const { tracks, rootNote, scale } = useSequencerStore.getState();
      const anySolo = tracks.some((t) => t.solo);
      for (const track of tracks) {
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const localStep = globalStep % track.length;
        const step = track.steps[localStep];
        if (!step?.on) continue;
        if (isSilencedByTie(track, localStep)) continue;
        if (step.probability < 100 && Math.random() * 100 >= step.probability) continue;
        const ties = tieLength(track, localStep);
        const v = step.velocity;
        const baseTime = when + step.microTiming * stepDuration;
        const ratchet = Math.max(1, Math.floor(step.ratchet));
        const subDur = stepDuration / ratchet;
        const effectiveGate = step.gate * ties;
        const midi = track.type === 'melodic' ? quantize(rootNote, scale, step.pitch) : undefined;
        for (let r = 0; r < ratchet; r++) {
          const t = baseTime + r * subDur;
          if (track.type === 'melodic') {
            samplePlayer.trigger(track.voice, t, v, midi, effectiveGate);
          } else {
            samplePlayer.trigger(track.voice, t, v, undefined, effectiveGate);
          }
        }
      }
    });
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
  }, [bpm]);

  return (
    <div className="min-h-full w-full flex flex-col">
      <header className="crumb">
        <span className="label">
          <a href="/">newspeech</a>
          <span className="sep"> / </span>sequence
        </span>
        <span className="aux">
          click selects · cmd-click toggles · drag/scroll adjusts active mode · shift = velocity · cmd = chance
        </span>
      </header>
      <main className="flex-1 flex items-center justify-center px-[72px] py-12">
        <div className="flex flex-col gap-8 w-[1280px] max-w-full">
          <div className="flex justify-between items-start gap-8">
            <StepInspector />
            <TransportControls />
          </div>
          <div className="flex justify-center">
            <TrackGrid />
          </div>
          <div className="flex justify-between items-center gap-8">
            <PlayButton />
            <ModeSwitcher />
          </div>
        </div>
      </main>
    </div>
  );
}
