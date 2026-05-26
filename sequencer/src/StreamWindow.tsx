import { useEffect } from 'react';
import { Datafeed } from './stream/Datafeed';
import { Visualizer } from './stream/Visualizer';
import { announceStreamPresence } from './stream/streamEvents';

export function StreamWindow() {
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
      <Visualizer />
      <div
        className="absolute inset-y-0 left-0"
        style={{ width: '34%', pointerEvents: 'none' }}
      >
        <Datafeed />
      </div>
    </div>
  );
}
