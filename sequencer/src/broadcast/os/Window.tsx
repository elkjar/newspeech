// A desktop window: invented chrome (not macOS), draggable by its title bar,
// resizable from the corner, raised on pointer-down, closable. Content is
// whatever the window is about — the OS only frames it.
import { useRef, type ReactNode } from 'react';
import { useLayout, useStage, FORMATS, WINDOW_TITLES, type WindowId } from './layout';

export function OSWindow({ id, children, index }: { id: WindowId; children: ReactNode; index: number }) {
  const rect = useLayout((s) => s.windows[id]);
  const move = useLayout((s) => s.move);
  const resize = useLayout((s) => s.resize);
  const raise = useLayout((s) => s.raise);
  const toggle = useLayout((s) => s.toggle);
  const format = useLayout((s) => s.format);
  const zoom = useLayout((s) => s.zoom);
  const { safe } = FORMATS[format];
  // The desktop is a scaled stage: pointer px → stage px through the fit.
  const fit = useStage();
  const sx = (clientX: number) => (clientX - fit.ox) / fit.scale;
  const sy = (clientY: number) => (clientY - fit.oy) / fit.scale;
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const size = useRef<{ x0: number; y0: number; w0: number; h0: number } | null>(null);

  if (!rect.open) return null;

  const onTitleDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    raise(id);
    drag.current = { dx: sx(e.clientX) - rect.x, dy: sy(e.clientY) - rect.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onTitleMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    move(id, Math.round(Math.max(safe.x, sx(e.clientX) - drag.current.dx)), Math.round(Math.max(safe.y, sy(e.clientY) - drag.current.dy)));
  };
  const onTitleUp = () => {
    drag.current = null;
  };
  const onGripDown = (e: React.PointerEvent) => {
    raise(id);
    size.current = { x0: sx(e.clientX), y0: sy(e.clientY), w0: rect.w, h0: rect.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const onGripMove = (e: React.PointerEvent) => {
    if (!size.current) return;
    resize(id, Math.round(size.current.w0 + (sx(e.clientX) - size.current.x0)), Math.round(size.current.h0 + (sy(e.clientY) - size.current.y0)));
  };
  const onGripUp = () => {
    size.current = null;
  };

  return (
    <section
      className="absolute flex flex-col text-white"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: rect.z,
        background: 'rgba(5,5,5,0.94)',
        border: '1px solid rgba(255,255,255,0.28)',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.9), 0 18px 40px rgba(0,0,0,0.55)',
      }}
      onPointerDown={() => raise(id)}
    >
      <header
        className="flex items-center gap-2 select-none shrink-0"
        style={{
          // Chrome grows half as fast as content: legible on a CRT without
          // eating the small 4:3 windows.
          zoom: zoom !== 1 ? 1 + (zoom - 1) / 2 : undefined,
          height: 22,
          padding: '0 8px',
          borderBottom: '1px solid rgba(255,255,255,0.22)',
          background: 'rgba(255,255,255,0.04)',
          cursor: 'grab',
          touchAction: 'none',
        }}
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
        onPointerCancel={onTitleUp}
      >
        <span className="text-[8px] tracking-[0.2em] opacity-40 tabular-nums">{String(index).padStart(2, '0')}</span>
        <span className="font-sans text-[10px] tracking-[0.18em] lowercase">{WINDOW_TITLES[id]}</span>
        <span className="ml-auto flex items-center gap-3 text-[10px] opacity-50">
          <button className="hover:opacity-100 px-1" onClick={() => toggle(id)} title="close">
            ×
          </button>
        </span>
      </header>
      {/* Content zoom (4:3 defaults to 1.5 — CRT type). `zoom` scales layout,
          so the content lays out in w/zoom × h/zoom px; the 4:3 picture also
          makes this box the container for the cq units the headline sizes
          use (NowWindow/CardWindow) so a title fits its window rather than
          sizing off the viewport. 16:9 is left exactly as it was. */}
      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        style={zoom !== 1 ? { zoom, containerType: 'inline-size' } : undefined}
      >
        {children}
      </div>
      <div
        className="absolute right-0 bottom-0"
        style={{ width: 14, height: 14, cursor: 'nwse-resize', touchAction: 'none' }}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      >
        <svg width="14" height="14" className="opacity-40">
          <path d="M13 6 L6 13 M13 10 L10 13" stroke="white" strokeWidth="1" />
        </svg>
      </div>
    </section>
  );
}
