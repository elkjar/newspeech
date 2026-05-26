import { useEffect, useState } from 'react';
import { Camera } from './Camera';
import { Pool } from './Pool';

// Visualizer wrapper — owns the source selection across raw (grayscale)
// camera feed and a media pool (pre-effected videos/images dropped into
// a folder). Hotkey `v` cycles sources; choice persists across reloads
// via localStorage. The active source mounts; the inactive source fully
// unmounts (camera releases the device, pool releases video src).

type Source = 'camera' | 'pool';

const STORAGE_KEY = 'newspeech:stream:source';
const ALL_SOURCES: Source[] = ['camera', 'pool'];

function isSource(v: unknown): v is Source {
  return v === 'camera' || v === 'pool';
}

function readPersisted(): Source {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isSource(v)) return v;
  } catch {
    // localStorage can throw in private browsing — fall through to default.
  }
  return 'pool';
}

export function Visualizer() {
  const [source, setSource] = useState<Source>(readPersisted);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, source);
    } catch {
      // ignore
    }
  }, [source]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when typing in an input — irrelevant here (the stream window
      // has no inputs) but cheap and future-proof.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        setSource((current) => {
          const idx = ALL_SOURCES.indexOf(current);
          return ALL_SOURCES[(idx + 1) % ALL_SOURCES.length];
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="absolute inset-0 bg-[#050505]" style={{ zIndex: 0 }}>
      {source === 'camera' && <Camera />}
      {source === 'pool' && <Pool />}
      <div
        className="absolute bottom-3 right-4 font-mono text-[9px] uppercase tracking-[0.25em] opacity-40 text-white pointer-events-none select-none"
        style={{ textShadow: '0 0 4px rgba(0,0,0,0.8)' }}
      >
        src · {source} <span className="opacity-60">[v]</span>
      </div>
    </div>
  );
}
