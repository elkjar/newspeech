// Audio-reactive layer around the visualizer, BROADCAST only. The pool video
// itself only changes at bank swaps; this makes the frame move with the
// music in between:
//   - engine output level (audio:level, ~30 Hz) breathes brightness and
//     contrast, and an onset (level jumping over its running average) fires
//     one of the count-in glitch styles at an intensity set by the jump;
//   - every audible hit (stream `step` events, with velocity) pops the frame
//     a hair — more for louder hits;
//   - a hard kick-like hit sometimes seeks the clip to a new point: a cut
//     without reloading the video;
//   - underneath it all a slow drift so even a still or a static clip moves.
// Styling is applied straight to the wrapper element (no React re-render on
// the audio path). The bank-swap count-in glitch (GlitchWrap) stays nested.
import { useEffect, useRef, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { subscribeStreamEvents } from '../../stream/streamEvents';
import { GlitchWrap, GLITCH_STYLES } from '../../stream/GlitchWrap';
import { useTransitionCountIn } from '../../stream/useTransitionCountIn';

const DRIFT_KEYFRAMES = `@keyframes ns-visual-drift {
  0%   { transform: scale(1.0) translate(0%, 0%); }
  50%  { transform: scale(1.07) translate(1.2%, -0.8%); }
  100% { transform: scale(1.02) translate(-0.8%, 0.6%); }
}`;

const KICKISH = /kick|\bbd\b|909|808|sub|boom/i;

export function ReactiveVisual({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const count = useTransitionCountIn();

  // Drift keyframes, injected once.
  useEffect(() => {
    if (document.getElementById('ns-visual-drift')) return;
    const st = document.createElement('style');
    st.id = 'ns-visual-drift';
    st.textContent = DRIFT_KEYFRAMES;
    document.head.appendChild(st);
  }, []);

  // Level → breathing + onsets.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | null = null;
    let env = 0;
    let avg = 0.02;
    let lastOnset = 0;
    void listen<number>('audio:level', (e) => {
      const lvl = Math.max(0, Math.min(1, e.payload));
      env += (lvl - env) * (lvl > env ? 0.6 : 0.12);
      avg += (lvl - avg) * 0.05;
      const el = inner.current;
      if (!el) return;
      // Breathe: a touch brighter and harder on louder passages.
      const b = 0.88 + 0.45 * Math.min(1, env * 1.6);
      const c = 1 + 0.35 * Math.min(1, env * 1.4);
      el.style.filter = `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)})`;
      // Onset: a jump well above the running average.
      const now = performance.now();
      if (lvl > 0.06 && lvl > avg * 1.9 && now - lastOnset > 140) {
        lastOnset = now;
        const t = Math.max(0.25, Math.min(1, (lvl - avg) * 2.5));
        const style = GLITCH_STYLES[Math.floor(Math.random() * GLITCH_STYLES.length)](t);
        outer.current?.animate(style.keyframes, { duration: style.duration, easing: style.easing });
      }
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);

  // Hits → pops + occasional seek.
  useEffect(() => {
    let un: (() => void) | null = null;
    let cancelled = false;
    let lastSeek = 0;
    void subscribeStreamEvents((batch) => {
      if (cancelled) return;
      let vel = 0;
      let kick = false;
      for (const e of batch) {
        if (e.kind !== 'step') continue;
        vel = Math.max(vel, e.velocity);
        if (e.velocity >= 0.8 && KICKISH.test(e.voice)) kick = true;
      }
      if (vel <= 0) return;
      const el = inner.current;
      if (!el) return;
      const k = Math.min(1, vel);
      el.animate(
        [
          { transform: 'scale(1)', offset: 0 },
          { transform: `scale(${(1 + 0.014 * k).toFixed(4)})`, offset: 0.25 },
          { transform: 'scale(1)', offset: 1 },
        ],
        { duration: 110, easing: 'ease-out', composite: 'add' },
      );
      const now = performance.now();
      if (kick && now - lastSeek > 1800 && Math.random() < 0.3) {
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
    <div ref={outer} className="absolute inset-0 overflow-hidden" style={{ background: '#050505' }}>
      <div
        ref={inner}
        className="absolute inset-0"
        style={{ animation: 'ns-visual-drift 26s ease-in-out infinite alternate', willChange: 'transform, filter' }}
      >
        <GlitchWrap count={count}>{children}</GlitchWrap>
      </div>
    </div>
  );
}
