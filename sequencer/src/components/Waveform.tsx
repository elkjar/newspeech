// Waveform display for the instrument editor. Renders the focused voice's
// sample as min/max peaks, dims the region outside the [start, end] window,
// draws draggable start/end handles, and overlays a live playhead that tracks
// the native engine's read position — moving right for forward playback, left
// for backward, and bouncing for pingpong (direction is inferred from the
// position delta so the caret matches what you hear). Monochrome to match the
// rest of the Sequence UI.
import { useEffect, useRef, useState } from 'react';
import type { LoopMode } from '../instruments/voiceEditsStore';
import { loadVoicePeaks, type WaveformPeaks } from '../tracker/waveformPeaks';

interface Props {
  voiceId: string;
  start: number;
  end: number;
  loopMode: LoopMode;
  playhead: number | null; // 0..1 read position, or null when not playing
  onChange: (patch: { start?: number; end?: number }) => void;
  // Granular mode: when set, the trim handles are replaced by a grain-window
  // band you drag directly — the left edge / body sets the read position, the
  // right edge sets the grain length. The playhead (when playing) shows the
  // live mod-swept position. null = normal sample-trim view.
  granular?: { position: number; grainMs: number } | null;
  onGranularPosition?: (position: number) => void;
  onGranularGrain?: (grainMs: number) => void;
  // Reports the decoded sample duration (seconds) once peaks load, so callers
  // can show position/grain in seconds (the Tracker measures position in s).
  onDuration?: (secs: number) => void;
}

const HEIGHT = 192;

export function Waveform({
  voiceId,
  start,
  end,
  loopMode,
  playhead,
  onChange,
  granular = null,
  onGranularPosition,
  onGranularGrain,
  onDuration,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<WaveformPeaks | null>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<'start' | 'end' | null>(null);
  const lastPh = useRef<number | null>(null);
  const dirRef = useRef(1); // inferred playhead travel direction (+1 / -1)

  // Track the rendered width so peaks resolve at ~1 column per pixel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (width <= 0) return;
    let cancelled = false;
    setPeaks(null);
    loadVoicePeaks(voiceId, width).then((p) => {
      if (cancelled) return;
      setPeaks(p);
      if (p) onDuration?.(p.frames / 44100);
    });
    return () => {
      cancelled = true;
    };
  }, [voiceId, width]);

  // Infer travel direction from the position delta (works for all loop modes,
  // including pingpong where the sign flips at the turns).
  useEffect(() => {
    if (playhead == null || playhead < 0) {
      lastPh.current = null;
      return;
    }
    const last = lastPh.current;
    if (last != null) {
      const d = playhead - last;
      if (Math.abs(d) > 0.0005) dirRef.current = d > 0 ? 1 : -1;
    }
    lastPh.current = playhead;
  }, [playhead]);

  // Grain window width as a fraction of the sample (granular mode). Shared by
  // the draw pass and the drag hit-testing so the right-edge size handle lines
  // up with what's rendered. 44.1k = the peaks decode rate.
  const grainFrac = granular && peaks
    ? Math.max(0.004, Math.min(1, ((granular.grainMs / 1000) * 44100) / peaks.frames))
    : 0;
  // Inverse: a window fraction back to grain length in ms (right-edge drag).
  const fracToGrainMs = (widthFrac: number): number => {
    if (!peaks) return granular?.grainMs ?? 80;
    const ms = ((widthFrac * peaks.frames) / 44100) * 1000;
    return Math.max(1, Math.min(1000, ms));
  };

  // Redraw on any geometry/playhead change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const mid = HEIGHT / 2;
    const amp = mid - 3;

    // The "bright" window: the trim region in sample mode, the grain window in
    // granular mode (read position → grainFrac, computed above).
    const winStart = granular ? granular.position : start;
    const winEnd = granular ? Math.min(1, granular.position + grainFrac) : end;

    if (peaks) {
      // fillRect with a 1px height floor — stroked zero-height lines draw
      // nothing at all, which is what made quiet/smooth spans render hollow.
      const sx = peaks.columns / width;
      for (let x = 0; x < width; x++) {
        const col = Math.min(peaks.columns - 1, Math.floor(x * sx));
        const min = peaks.peaks[col * 2];
        const max = peaks.peaks[col * 2 + 1];
        const frac = x / width;
        const inWindow = frac >= winStart && frac <= winEnd;
        ctx.fillStyle = inWindow ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)';
        const yTop = mid - max * amp;
        const yBot = mid - min * amp;
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, mid, width, 1);
    }

    if (granular) {
      // Grain window band + two draggable edges: left = read position, right =
      // grain length. Drag the band/left to move, the right edge to resize.
      const lx = winStart * width;
      const rx = winEnd * width;
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(lx, 0, Math.max(1, rx - lx), HEIGHT);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      for (const hx of [lx, rx]) {
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, HEIGHT);
        ctx.stroke();
      }
      // Grab tabs: position (left, top) + size (right, bottom) so the two edges
      // read as distinct affordances.
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(lx - 1.5, 0, 3, 6);
      ctx.fillRect(rx - 1.5, HEIGHT - 6, 3, 6);
    } else {
      // Window handles.
      const sxp = start * width;
      const exp = end * width;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      for (const hx of [sxp, exp]) {
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, HEIGHT);
        ctx.stroke();
      }
      // Small grab tabs at the top of each handle.
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(sxp, 0, 3, 6);
      ctx.fillRect(exp - 3, 0, 3, 6);
    }

    // Playhead + direction caret.
    if (playhead != null && playhead >= 0) {
      const px = playhead * width;
      ctx.strokeStyle = 'rgba(255,255,255,1)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, HEIGHT);
      ctx.stroke();
      const d = loopMode === 'bwd' || loopMode === 'rev' ? -1 : dirRef.current;
      const cy = HEIGHT - 6;
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.beginPath();
      if (d >= 0) {
        ctx.moveTo(px, cy - 4);
        ctx.lineTo(px + 6, cy);
        ctx.lineTo(px, cy + 4);
      } else {
        ctx.moveTo(px, cy - 4);
        ctx.lineTo(px - 6, cy);
        ctx.lineTo(px, cy + 4);
      }
      ctx.closePath();
      ctx.fill();
    }
  }, [peaks, width, start, end, playhead, loopMode, granular?.position, granular?.grainMs]);

  const xToFrac = (clientX: number): number => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const applyDrag = (which: 'start' | 'end', frac: number) => {
    if (which === 'start') onChange({ start: Math.min(frac, end - 0.001) });
    else onChange({ end: Math.max(frac, start + 0.001) });
  };
  const onDown = (e: React.PointerEvent) => {
    const frac = xToFrac(e.clientX);
    canvasRef.current!.setPointerCapture(e.pointerId);
    if (granular) {
      // 'end' = resize (right edge), 'start' = move (left edge / band). Pick the
      // nearer edge; the right edge wins only when it's the closer of the two.
      const rightEdge = Math.min(1, granular.position + grainFrac);
      const which =
        Math.abs(frac - rightEdge) < Math.abs(frac - granular.position) ? 'end' : 'start';
      dragRef.current = which;
      if (which === 'end') onGranularGrain?.(fracToGrainMs(frac - granular.position));
      else onGranularPosition?.(frac);
      return;
    }
    const which = Math.abs(frac - start) <= Math.abs(frac - end) ? 'start' : 'end';
    dragRef.current = which;
    applyDrag(which, frac);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const frac = xToFrac(e.clientX);
    if (granular) {
      if (dragRef.current === 'end') onGranularGrain?.(fracToGrainMs(frac - granular.position));
      else onGranularPosition?.(frac);
      return;
    }
    applyDrag(dragRef.current, frac);
  };
  const onUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <div ref={wrapRef} className="mb-3">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: HEIGHT, touchAction: 'none', display: 'block' }}
        className="border border-white/15 bg-black/40 cursor-ew-resize"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      />
    </div>
  );
}
