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
}

const HEIGHT = 96;

export function Waveform({ voiceId, start, end, loopMode, playhead, onChange }: Props) {
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
      if (!cancelled) setPeaks(p);
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

    if (peaks) {
      const sx = peaks.columns / width;
      for (let x = 0; x < width; x++) {
        const col = Math.min(peaks.columns - 1, Math.floor(x * sx));
        const min = peaks.peaks[col * 2];
        const max = peaks.peaks[col * 2 + 1];
        const frac = x / width;
        const inWindow = frac >= start && frac <= end;
        ctx.strokeStyle = inWindow ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, mid - max * amp);
        ctx.lineTo(x + 0.5, mid - min * amp);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, mid, width, 1);
    }

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

    // Playhead + direction caret.
    if (playhead != null && playhead >= 0) {
      const px = playhead * width;
      ctx.strokeStyle = 'rgba(255,255,255,1)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, HEIGHT);
      ctx.stroke();
      const d = loopMode === 'bwd' ? -1 : dirRef.current;
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
  }, [peaks, width, start, end, playhead, loopMode]);

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
    const which = Math.abs(frac - start) <= Math.abs(frac - end) ? 'start' : 'end';
    dragRef.current = which;
    canvasRef.current!.setPointerCapture(e.pointerId);
    applyDrag(which, frac);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragRef.current) applyDrag(dragRef.current, xToFrac(e.clientX));
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
