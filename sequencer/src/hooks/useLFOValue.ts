import { useEffect, useRef, useState } from 'react';
import { getAudioContext } from '../audio/audioContext';
import { applyLFO, getFrozenLFOOutput, isLFOFrozen, lfoShapeValue, type LFO } from '../audio/lfo';

// Drives a value at RAF rate from a base + a list of routed LFOs. Mirrors what
// `modulated()` does in the audio dispatch, but in a React-rendering form so
// UI surfaces (knobs, step grid, etc.) can show the live modulated value
// without the store having to push every frame.
export function useLFOValue(
  baseValue: number,
  routed: LFO[],
  rateMul: number = 1
): number {
  const baseRef = useRef(baseValue);
  baseRef.current = baseValue;
  const routedRef = useRef<LFO[]>(routed);
  routedRef.current = routed;
  const rateMulRef = useRef(rateMul);
  rateMulRef.current = rateMul;

  const [v, setV] = useState(baseValue);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const list = routedRef.current;
      const b = baseRef.current;
      const rm = rateMulRef.current;
      let next: number;
      if (list.length === 0) {
        next = b;
      } else {
        const totalDepth = list.reduce((s, l) => s + l.depth, 0);
        if (totalDepth === 0) {
          next = b;
        } else {
          const frozen = isLFOFrozen();
          const t = getAudioContext().currentTime;
          let summed = 0;
          for (const l of list) {
            const o = frozen
              ? getFrozenLFOOutput(l.id)
              : lfoShapeValue(l.shape, l.rate * rm * t);
            summed += o * l.depth;
          }
          next = applyLFO(b, totalDepth, summed / totalDepth);
        }
      }
      setV(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return v;
}
