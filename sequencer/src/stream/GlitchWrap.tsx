import { useEffect, useRef, type ReactNode } from 'react';

// Wraps the visualizer and fires a short glitch burst on each beat of the
// transition count-in so the drummer can read an incoming transition off the
// whole frame, not just the corner dots. Intensity ramps with the count
// (subtle at 4, hardest on 1). Each beat picks a RANDOM style from the 8 below
// (never the same one twice running), so the cue stays unpredictable rather
// than a repeating tell.
//
// Driven by the Web Animations API on the wrapper, NOT by remounting (which
// would reload the video). Between beats the wrapper sits clean (identity
// transform/filter), so it never degrades the visual outside the cue window.

type GlitchStyle = (t: number) => {
  keyframes: Keyframe[];
  duration: number;
  easing: string;
};

// `t` is 0.25 → 1.0 across the count-in (wider/harder toward the drop). Each
// style returns its keyframes + timing; the caller fires it on the wrapper.
const STYLES: GlitchStyle[] = [
  // 0 — horizontal tear: clip-path bands + translateX jumps, invert mid.
  (t) => ({
    keyframes: [
      { transform: 'translate(0,0)', filter: 'none', clipPath: 'inset(0 0 0 0)', offset: 0 },
      { transform: `translate(${22 * t}px,0)`, filter: `contrast(${1 + 0.9 * t})`, clipPath: `inset(${18 * t}% 0 ${46 * t}% 0)`, offset: 0.3 },
      { transform: `translate(${-15 * t}px,0)`, filter: 'invert(1)', clipPath: `inset(${52 * t}% 0 ${8 * t}% 0)`, offset: 0.6 },
      { transform: 'translate(0,0)', filter: 'none', clipPath: 'inset(0 0 0 0)', offset: 1 },
    ],
    duration: Math.round(200 - 80 * t),
    easing: 'steps(5, end)',
  }),
  // 1 — invert strobe: rapid polarity flips, contrast climbing.
  (t) => ({
    keyframes: [
      { filter: 'invert(0) contrast(1)', offset: 0 },
      { filter: `invert(1) contrast(${1 + 0.5 * t})`, offset: 0.2 },
      { filter: 'invert(0)', offset: 0.4 },
      { filter: 'invert(1)', offset: 0.65 },
      { filter: 'none', offset: 1 },
    ],
    duration: Math.round(170 - 40 * t),
    easing: 'steps(4, end)',
  }),
  // 2 — vertical roll: translateY jumps + top/bottom clip, like vhold loss.
  (t) => ({
    keyframes: [
      { transform: 'translateY(0)', filter: 'none', clipPath: 'inset(0 0 0 0)', offset: 0 },
      { transform: `translateY(${-20 * t}px)`, filter: `brightness(${1 + 0.3 * t})`, clipPath: `inset(0 0 ${30 * t}% 0)`, offset: 0.3 },
      { transform: `translateY(${14 * t}px)`, filter: 'none', clipPath: `inset(${30 * t}% 0 0 0)`, offset: 0.6 },
      { transform: 'translateY(0)', filter: 'none', clipPath: 'inset(0 0 0 0)', offset: 1 },
    ],
    duration: Math.round(190 - 70 * t),
    easing: 'steps(4, end)',
  }),
  // 3 — shear: skewX shudder with lateral drift, smooth.
  (t) => ({
    keyframes: [
      { transform: 'skewX(0deg) translate(0,0)', filter: 'none', offset: 0 },
      { transform: `skewX(${12 * t}deg) translate(${10 * t}px,0)`, filter: `contrast(${1 + 0.6 * t})`, offset: 0.35 },
      { transform: `skewX(${-9 * t}deg) translate(${-8 * t}px,0)`, filter: 'none', offset: 0.65 },
      { transform: 'skewX(0deg) translate(0,0)', filter: 'none', offset: 1 },
    ],
    duration: Math.round(200 - 70 * t),
    easing: 'ease-in-out',
  }),
  // 4 — punch: scale pop + contrast/brightness spike + invert frame.
  (t) => ({
    keyframes: [
      { transform: 'scale(1)', filter: 'none', offset: 0 },
      { transform: `scale(${1 + 0.09 * t})`, filter: `contrast(${1 + 0.7 * t}) brightness(${1 + 0.4 * t})`, offset: 0.3 },
      { transform: `scale(${1 - 0.03 * t})`, filter: 'invert(1)', offset: 0.55 },
      { transform: 'scale(1)', filter: 'none', offset: 1 },
    ],
    duration: Math.round(180 - 60 * t),
    easing: 'steps(3, end)',
  }),
  // 5 — column slice: left/right clip + lateral shift (vertical seams).
  (t) => ({
    keyframes: [
      { transform: 'translate(0,0)', filter: 'none', clipPath: 'inset(0 0 0 0)', offset: 0 },
      { transform: `translate(${-18 * t}px,0)`, filter: `contrast(${1 + 0.5 * t})`, clipPath: `inset(0 ${50 * t}% 0 0)`, offset: 0.3 },
      { transform: `translate(${18 * t}px,0)`, filter: 'none', clipPath: `inset(0 0 0 ${50 * t}%)`, offset: 0.6 },
      { transform: 'translate(0,0)', filter: 'none', clipPath: 'inset(0 0 0 0)', offset: 1 },
    ],
    duration: Math.round(190 - 70 * t),
    easing: 'steps(4, end)',
  }),
  // 6 — hue spin: chroma swing + saturate (colour); contrast carries it on mono.
  (t) => ({
    keyframes: [
      { filter: 'hue-rotate(0deg) saturate(1)', transform: 'translate(0,0)', offset: 0 },
      { filter: `hue-rotate(${120 * t}deg) saturate(${1 + 2 * t}) contrast(${1 + 0.4 * t})`, transform: `translate(${6 * t}px,0)`, offset: 0.4 },
      { filter: `hue-rotate(${-90 * t}deg) saturate(${1 + 1.5 * t})`, transform: 'translate(0,0)', offset: 0.7 },
      { filter: 'none', transform: 'translate(0,0)', offset: 1 },
    ],
    duration: Math.round(220 - 80 * t),
    easing: 'ease-out',
  }),
  // 7 — crush: blur smear + blown-out contrast/brightness, then a dim dip.
  (t) => ({
    keyframes: [
      { filter: 'blur(0px) contrast(1) brightness(1)', transform: 'translate(0,0)', offset: 0 },
      { filter: `blur(${2 * t}px) contrast(${1 + 1.4 * t}) brightness(${1 + 0.6 * t})`, transform: 'translate(0,0)', offset: 0.3 },
      { filter: `blur(0px) contrast(${1 + 0.8 * t}) brightness(${1 - 0.2 * t})`, transform: `translate(${-6 * t}px,0)`, offset: 0.6 },
      { filter: 'none', transform: 'translate(0,0)', offset: 1 },
    ],
    duration: Math.round(200 - 70 * t),
    easing: 'steps(4, end)',
  }),
];

export function GlitchWrap({
  count,
  children,
}: {
  count: number | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Previous count so we only glitch when the beat actually advances (the 10Hz
  // snapshot repeats the same count several times per beat).
  const prev = useRef<number | null>(null);
  // Last style index, so a fresh beat never re-fires the same style.
  const lastStyle = useRef<number>(-1);

  useEffect(() => {
    const last = prev.current;
    prev.current = count;
    if (count === null || count === last) return;
    const el = ref.current;
    if (!el) return;

    // 0.25 at "4" → 1.0 at "1".
    const t = (5 - count) / 4;
    let idx = Math.floor(Math.random() * STYLES.length);
    if (idx === lastStyle.current) idx = (idx + 1) % STYLES.length;
    lastStyle.current = idx;
    const { keyframes, duration, easing } = STYLES[idx](t);
    el.animate(keyframes, { duration, easing });
  }, [count]);

  return (
    <div ref={ref} className="absolute inset-0" style={{ zIndex: 0 }}>
      {children}
    </div>
  );
}
