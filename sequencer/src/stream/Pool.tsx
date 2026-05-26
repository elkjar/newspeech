import { useEffect, useRef, useState } from 'react';
import { invoke, convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { emitStreamEvent, subscribeStreamEvents } from './streamEvents';

// Pool source — cycles through video + image files dropped into
// `~/Documents/newspeech-visuals/`. Files load via Tauri's asset
// protocol (`convertFileSrc`) scoped to that directory in
// tauri.conf.json. Plays source material straight (the user pre-renders
// destruction into the files); grayscale baseline matches the rest of
// the visualizer suite.
//
// Hotkeys: `n` next, `p` previous, `r` rescan folder.

const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const IMAGE_EXT = /\.(jpe?g|png)$/i;

type Status =
  | { kind: 'loading' }
  | { kind: 'empty'; dir: string }
  | { kind: 'error'; msg: string }
  | { kind: 'ready' };

export function Pool() {
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<string>('');
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  // Load file list + dir on mount.
  useEffect(() => {
    if (!isTauri()) {
      setStatus({ kind: 'error', msg: 'pool requires native (Tauri) build' });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [list, dirPath] = await Promise.all([
          invoke<string[]>('pool_list_visuals'),
          invoke<string>('pool_get_dir'),
        ]);
        if (cancelled) return;
        setDir(dirPath);
        setFiles(list);
        setStatus(list.length === 0 ? { kind: 'empty', dir: dirPath } : { kind: 'ready' });
      } catch (e) {
        if (!cancelled) {
          setStatus({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-advance on bank-swap (pattern pick — auto or manual). Keeps
  // pool media changes lock-step with the music so the audience reads
  // visualizer + audio as one system rather than independent layers.
  useEffect(() => {
    if (files.length === 0) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void subscribeStreamEvents((batch) => {
      if (cancelled) return;
      let didAdvance = false;
      for (const e of batch) {
        if (e.kind !== 'ghost') continue;
        if (e.subkind !== 'auto' && e.subkind !== 'manual') continue;
        if (didAdvance) break; // collapse multiple picks in one tick
        didAdvance = true;
        setIndex((i) => (i + 1) % files.length);
      }
    }).then((u) => {
      if (cancelled) u();
      else unsub = u;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [files.length]);

  // Emit a visual-change event whenever the active index changes — both
  // from hotkeys and from auto-advance. Logged in the datafeed so the
  // audience sees the visual transition called out alongside the music.
  const lastLoggedRef = useRef<string | null>(null);
  useEffect(() => {
    if (files.length === 0) return;
    const current = files[index % files.length];
    if (!current || current === lastLoggedRef.current) return;
    lastLoggedRef.current = current;
    const name = current.split('/').pop() ?? current;
    emitStreamEvent({ kind: 'visual', label: `visual · ${name}` });
  }, [index, files]);

  // n/p/r hotkeys
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'n') {
        setIndex((i) => (files.length > 0 ? (i + 1) % files.length : 0));
      } else if (e.key === 'p') {
        setIndex((i) =>
          files.length > 0 ? (i - 1 + files.length) % files.length : 0,
        );
      } else if (e.key === 'r') {
        void invoke<string[]>('pool_list_visuals')
          .then((list) => {
            setFiles(list);
            setIndex(0);
            setStatus(list.length === 0 ? { kind: 'empty', dir } : { kind: 'ready' });
          })
          .catch((err) => {
            setStatus({
              kind: 'error',
              msg: err instanceof Error ? err.message : String(err),
            });
          });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [files.length, dir]);

  if (status.kind === 'loading') {
    return <PoolStatusOverlay text="pool · loading" />;
  }
  if (status.kind === 'error') {
    return <PoolStatusOverlay text={`pool · error · ${status.msg}`} />;
  }
  const current = files.length > 0 ? files[index % files.length] : null;
  if (status.kind === 'empty' || files.length === 0 || !current) {
    return (
      <PoolStatusOverlay
        lines={[
          'pool · empty',
          'drop video/image files into:',
          dir || '~/Documents/newspeech-visuals/',
          'press [r] to rescan',
        ]}
      />
    );
  }

  const fileName = current.split('/').pop() ?? current;
  const url = convertFileSrc(current);
  const isVideo = VIDEO_EXT.test(current);
  const isImage = IMAGE_EXT.test(current);

  return (
    <div className="absolute inset-0 bg-[#050505]">
      {/* Single-element render. key={current} forces a fresh <video>
          mount on each advance — fresh decoder, fresh autoplay, no
          carry-over state from the previous file. Pays a small load
          lag per advance but plays reliably. */}
      {isVideo && (
        <video
          key={current}
          src={url}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
            filter: 'grayscale(1)',
          }}
        />
      )}
      {isImage && (
        <img
          key={current}
          src={url}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
            filter: 'grayscale(1)',
          }}
        />
      )}
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 font-mono text-[9px] uppercase tracking-[0.25em] opacity-50 text-white pointer-events-none select-none whitespace-nowrap"
        style={{ textShadow: '0 0 4px rgba(0,0,0,0.8)' }}
      >
        {fileName} <span className="opacity-50">[{index + 1}/{files.length}]</span>{' '}
        <span className="opacity-50">[n · p · r]</span>
      </div>
    </div>
  );
}

function PoolStatusOverlay({
  text,
  lines,
}: {
  text?: string;
  lines?: string[];
}) {
  const items = lines ?? (text ? [text] : []);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#050505] text-white font-mono">
      <div className="flex flex-col items-center gap-2 text-[10px] uppercase tracking-[0.3em] opacity-60 max-w-2xl text-center">
        {items.map((line, i) => (
          <div key={i} className={i === 0 ? '' : 'opacity-75 tracking-[0.18em]'}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
