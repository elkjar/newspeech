import { useEffect } from 'react';
import { Datafeed } from './stream/Datafeed';
import { Visualizer } from './stream/Visualizer';
import { GlitchWrap } from './stream/GlitchWrap';
import { TransitionCue } from './stream/TransitionCue';
import { useTransitionCountIn } from './stream/useTransitionCountIn';
import { announceStreamPresence } from './stream/streamEvents';

export function StreamWindow() {
  // One subscription to the transition count-in, shared by the video glitch
  // and the corner dots.
  const count = useTransitionCountIn();

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void announceStreamPresence().then((fn) => {
      cleanup = fn;
    });
    return () => {
      cleanup?.();
    };
  }, []);
  return (
    <div
      className="fixed inset-0 bg-[#050505] text-white overflow-hidden"
      style={{ cursor: 'default' }}
    >
      <GlitchWrap count={count}>
        <Visualizer />
      </GlitchWrap>
      <div
        className="absolute inset-y-0 left-0"
        style={{ width: '34%', pointerEvents: 'none' }}
      >
        <Datafeed />
      </div>
      <TransitionCue count={count} />
    </div>
  );
}
