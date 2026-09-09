// Audio-reactive layer around the visualizer, BROADCAST only. The pool video
// itself only changes at bank swaps; this makes the frame move with the
// music in between:
//   - engine output level (audio:level, ~30 Hz) breathes brightness and
//     contrast, and an onset (level jumping over its running average) fires
//     one of the count-in glitch styles at an intensity set by the jump;
//   - a hard kick-like hit sometimes seeks the clip to a new point: a cut
//     without reloading the video (the per-hit zoom pops that used to ride
//     the same events are gone — Chris 2026-09-08: drop the video zooming
//     in and out with the music);
//   - underneath it all a slow drift so even a still or a static clip moves.
// Styling is applied straight to the wrapper element (no React re-render on
// the audio path). The bank-swap count-in glitch (GlitchWrap) stays nested.
// Intensities halved 2026-09-08 after a first look (Chris: "2x too intense").
// The level/onset also feed `reactiveLevel` for the tube shader (TubeLayer),
// which wraps the source inside the GlitchWrap so every CSS effect here
// still lands on top of the GL picture.
// The pool's filename caption is hidden here — the desktop carries the text.
import { useEffect, useRef, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { subscribeStreamEvents } from '../../stream/streamEvents';
import { GlitchWrap, GLITCH_STYLES } from '../../stream/GlitchWrap';
import { useTransitionCountIn } from '../../stream/useTransitionCountIn';
import { TubeLayer } from './TubeLayer';
import { reactive } from './reactiveLevel';

const DRIFT_KEYFRAMES = `@keyframes ns-visual-drift {
  0%   { transform: scale(1.0) translate(0%, 0%); }
  50%  { transform: scale(1.035) translate(0.6%, -0.4%); }
  100% { transform: scale(1.01) translate(-0.4%, 0.3%); }
}`;

const KICKISH = /kick|\bbd\b|909|808|sub|boom/i;

// Onset glitches: every style but the scale "punch" (no zoom with the music).
const ONSET_STYLES = GLITCH_STYLES.filter((_, i) => i !== 4);

const HIDE_CAPTION = `.ns-reactive-visual [data-pool-caption] { display: none; }`;

export function ReactiveVisual({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const count = useTransitionCountIn();

  // Drift keyframes, injected once.
  useEffect(() => {
    if (document.getElementById('ns-visual-drift')) return;
    const st = document.createElement('style');
    st.id = 'ns-visual-drift';
    st.textContent = DRIFT_KEYFRAMES + '\n' + HIDE_CAPTION;
    document.head.appendChild(st);
  }, []);

  // Level → breathing + onsets.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | null = null;
    let env = 0;
    let avg = 0.02;
    let lastOnset = 0;
    let lastFilter = '';
    void listen<number>('audio:level', (e) => {
      const lvl = Math.max(0, Math.min(1, e.payload));
      env += (lvl - env) * (lvl > env ? 0.6 : 0.12);
      reactive.env = env;
      // The running average rises fast and falls slowly: a song coming in
      // from silence is loud relative to silence for a moment, not a stream
      // of onsets (it used to fire one every 140 ms for a second at every
      // song start — the visual lag Chris felt).
      avg += (lvl - avg) * (lvl > avg ? 0.3 : 0.04);
      const el = inner.current;
      if (!el) return;
      // Breathe: a touch brighter and harder on louder passages. Written
      // only when it moved — a filter change re-composites the video layer.
      const b = 0.94 + 0.22 * Math.min(1, env * 1.6);
      const c = 1 + 0.18 * Math.min(1, env * 1.4);
      const filter = `brightness(${b.toFixed(2)}) contrast(${c.toFixed(2)})`;
      if (filter !== lastFilter) {
        lastFilter = filter;
        el.style.filter = filter;
      }
      // Onset: a jump well above the running average.
      const now = performance.now();
      if (lvl > 0.06 && lvl > avg * 1.9 && now - lastOnset > 260) {
        lastOnset = now;
        const t = Math.max(0.12, Math.min(0.5, (lvl - avg) * 1.25));
        reactive.onsetAt = now;
        reactive.onsetAmp = Math.min(1, t * 2);
        const style = ONSET_STYLES[Math.floor(Math.random() * ONSET_STYLES.length)](t);
        outer.current?.animate(style.keyframes, { duration: style.duration, easing: style.easing });
      }
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);

  // Hard kicks → an occasional seek (a cut without reloading the video).
  useEffect(() => {
    let un: (() => void) | null = null;
    let cancelled = false;
    let lastSeek = 0;
    void subscribeStreamEvents((batch) => {
      if (cancelled) return;
      let kick = false;
      for (const e of batch) {
        if (e.kind === 'step' && e.velocity >= 0.8 && KICKISH.test(e.voice)) kick = true;
      }
      if (!kick) return;
      const now = performance.now();
      if (now - lastSeek > 1800 && Math.random() < 0.3) {
        const v = outer.current?.querySelector('video');
        if (v && Number.isFinite(v.duration) && v.duration > 2) {
          lastSeek = now;
          v.currentTime = Math.random() * (v.duration - 1);
        }
      }
    }).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  return (
    <div ref={outer} className="absolute inset-0 overflow-hidden ns-reactive-visual" style={{ background: '#050505' }}>
      <div
        ref={inner}
        className="absolute inset-0"
        style={{ animation: 'ns-visual-drift 26s ease-in-out infinite alternate', willChange: 'transform, filter' }}
      >
        <GlitchWrap count={count}>
          <TubeLayer>{children}</TubeLayer>
        </GlitchWrap>
      </div>
    </div>
  );
}
