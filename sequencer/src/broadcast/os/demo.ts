// `?demo=1` in a plain browser: seed the stores with a plausible running set
// so the desktop can be designed and screenshotted without the engine.
import { useSequencerStore } from '../../state/store';
import { useBroadcast } from '../setlist';
import { useStreamState, type Snapshot } from './streamState';
import { forceSignalEvent } from './signal';
import { demoGap } from '../gap';
import { useCards, showCard } from '../cards';
import { demoBoot } from '../boot';

const NAMES = [
  'rdll', 'breaks', 'noisy-ns', 'enrichment-time', 'newspeech-2026-05-19-0119', 'scene-2-test',
  'piper-maru-EXT', '138BPM-ns-nice-one', 'intro', 'hurricane-arcs', 'piano-swell', 'test-wave',
  'SONG1', 'NS-1-SCENE2', 'rg-test-2', 'wavetable-test', 'newspeech-song-2026-06-06-0037',
];

export function seedDemo(): void {
  // Screenshots: window.__nsSignal('sync' | 'dropout' | 'tear' | 'roll' | 'fade')
  (window as unknown as { __nsSignal: typeof forceSignalEvent }).__nsSignal = forceSignalEvent;
  // window.__nsGap('hold' | 'reboot' | 'none'), window.__nsCard()
  (window as unknown as { __nsGap: typeof demoGap }).__nsGap = demoGap;
  (window as unknown as { __nsCard: () => void }).__nsCard = () => showCard();
  // window.__nsBoot() — replay the station-initializing sequence.
  (window as unknown as { __nsBoot: () => void }).__nsBoot = demoBoot;
  useCards.setState({
    cards: [
      { path: '/demo/CARDS/ident-receiving.txt', kind: 'ident', weight: 1, url: null, headline: 'You are receiving', body: ['NEWSPEECH // BROADCAST', 'uptime {uptime} · {songs} songs in rotation'] },
      { path: '/demo/CARDS/support-plugins.txt', kind: 'plugin', weight: 1, url: 'newspeechsound.com/plugins', headline: 'Four plugins', body: ['VIBE · GLITCH · SATURATE · SLICE', 'free, in exchange for an address'] },
    ],
  });
  useBroadcast.setState({
    entries: NAMES.map((n) => ({ path: `/Users/demo/Desktop/BROADCAST-TEST/${n}.seq`, name: n })),
    current: 6,
    next: 11,
    nextSlot: 1,
    recent: [2, 9, 0, 14],
    status: 'running',
    played: 23,
    startedAt: Date.now() - 3 * 3600_000 - 754_000,
    mode: 'random',
  });
  const seq = useSequencerStore.getState();
  useSequencerStore.setState({
    songTitle: 'piper-maru-EXT',
    bpm: 128,
    rootNote: 3,
    playing: true,
    bootDone: true,
    globalStep: 32 * 41 + 12,
    ghostCompositionStartStep: 32 * 3,
    sceneGraph: { ...seq.sceneGraph, enabled: true, shape: 'arc', phaseLength: 80 },
  });
  const push = useSequencerStore.getState().pushGhostPickEvent;
  push({ kind: 'system', globalStep: 32 * 3, label: 'song 64 bars', nonce: 'demo1' });
  push({ kind: 'auto', globalStep: 32 * 4, slot: 2, shape: 'arc', phase: 0.02, target: 0.31, pickedEntropy: 0.29, deltaFromTarget: -0.02, candidateCount: 7 });
  push({ kind: 'commit', globalStep: 32 * 5, slot: 2, trigger: 'auto', dwellBars: 12 });
  push({ kind: 'auto', globalStep: 32 * 16, slot: 5, shape: 'arc', phase: 0.21, target: 0.48, pickedEntropy: 0.51, deltaFromTarget: 0.03, candidateCount: 7 });
  push({ kind: 'commit', globalStep: 32 * 17, slot: 5, trigger: 'auto', dwellBars: 10 });
  push({ kind: 'auto', globalStep: 32 * 27, slot: 7, shape: 'arc', phase: 0.4, target: 0.66, pickedEntropy: 0.62, deltaFromTarget: -0.04, candidateCount: 7 });
  push({ kind: 'commit', globalStep: 32 * 28, slot: 7, trigger: 'auto', dwellBars: 14 });
  push({ kind: 'auto', globalStep: 32 * 41, slot: 3, shape: 'arc', phase: 0.55, target: 0.79, pickedEntropy: 0.74, deltaFromTarget: -0.05, candidateCount: 7 });

  const bank = (e: number) => ({ kind: 'normal' as const, entropy: e });
  const snapshot: Snapshot = {
    kind: 'state',
    density: 0.58, chaos: 0.22, motion: 0.41, drift: 0.13, tension: 0.35,
    activeBank: 7, pendingBank: 3, transitionCountIn: 3,
    shape: 'arc', phaseLength: 80, phase: 0.56, targetEntropy: 0.79,
    ghostEnabled: true, bankOrderMode: 'entropy', elapsedBars: 45, minE: 0.21, maxE: 0.88,
    bankSummary: [bank(0.29), null, bank(0.31), bank(0.74), null, bank(0.51), null, bank(0.62), bank(0.88), { kind: 'transition', entropy: 0.21 }, null, null, bank(0.45), null, null, null],
    activeBreakdown: { total: 0.62, channels: 0.7, voiceType: 0.55, stepDensity: 0.61, mutation: 0.3, polyphony: 0.4 },
  };
  const rows = [
    ['ghost', 'ghost · pattern 3 · ent 0.29'], ['param', 'density 0.58'], ['mutate', 'lead2 spotlight'], ['param', 'chaos 0.22'],
    ['lfo', 'LFO1 · depth 0.40'], ['ghost', 'pattern 6 · active'], ['param', 't3 · cutoff 0.71'], ['visual', 'pool → drift_4f2a.mp4'],
    ['ghost', 'ghost · pattern 8 · ent 0.62'], ['param', 'tension 0.35'], ['mutate', 'bass tie flip'], ['ghost', 'pattern 8 · active'],
  ].map(([kind, label], i) => ({ id: i + 1, t: performance.now() - (12 - i) * 4000, kind: kind as 'ghost' | 'param' | 'mutate' | 'lfo' | 'visual', label }));
  useStreamState.getState().seed(snapshot, rows, [2, 5, 7, 2, 8, 5, 7]);
  const VOICES = ['user/drums/rack-909/kick', 'user/drums/rack-909/hat-closed', 'user/drums/rack-909/snare', 'user/bass/monolith/monolith-C2', 'user/pads/nasa-databent/nasa-databent-E3', 'user/textures/larslejsstraede/larslejsstraede', 'user/instruments/haunted/haunted-C4'];
  let step = 0;
  window.setInterval(() => {
    step++;
    const ev: import('../../stream/streamEvents').StreamEvent[] = [];
    if (step % 2 === 0) ev.push({ kind: 'step', voice: VOICES[0], velocity: 0.9 });
    ev.push({ kind: 'step', voice: VOICES[1], velocity: 0.35 + 0.3 * Math.random() });
    if (step % 4 === 2) ev.push({ kind: 'step', voice: VOICES[2], velocity: 0.8 });
    if (step % 8 === 0) ev.push({ kind: 'step', voice: VOICES[3], velocity: 0.7 });
    if (step % 16 === 4) ev.push({ kind: 'step', voice: VOICES[4], velocity: 0.5 });
    if (step % 64 === 1) ev.push({ kind: 'step', voice: VOICES[5], velocity: 0.6 });
    if (step % 24 === 7) ev.push({ kind: 'step', voice: VOICES[6], velocity: 0.55 });
    useStreamState.getState().push(ev);
  }, 234);

  // Breathe: phase creeps, macros wander, bars tick.
  let t = 0;
  window.setInterval(() => {
    t += 0.1;
    const s = useStreamState.getState().snapshot;
    if (!s) return;
    useStreamState.getState().seed(
      { ...s, phase: Math.min(1, s.phase + 0.0004), density: 0.58 + 0.08 * Math.sin(t / 3), chaos: 0.22 + 0.05 * Math.sin(t / 5), transitionCountIn: 4 - (Math.floor(t * 2) % 4) },
      useStreamState.getState().rows,
      useStreamState.getState().walk,
    );
    useSequencerStore.setState((st) => ({ globalStep: st.globalStep + 1 }));
  }, 100);
}
