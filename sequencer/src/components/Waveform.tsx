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
import { onSliceHit } from '../audio/sliceHits';

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
  // Slice mode: when set (even empty), a third display mode — the whole waveform
  // reads bright and each slice start-point draws a marker line + top tab (with
  // faint alternating cell shading). Takes precedence over granular/trim. null =
  // not slice mode. Editable (S2b): drag a marker to move, double-click empty to
  // add, alt/⌘-click a marker to remove, single-click a region to audition it.
  slices?: number[] | null;
  onSlicesChange?: (slices: number[]) => void;
  onSlicePreview?: (index: number, on: boolean) => void;
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
  slices = null,
  onSlicesChange,
  onSlicePreview,
  onDuration,
}: Props) {
  const sliceMode = slices != null;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<WaveformPeaks | null>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<'start' | 'end' | null>(null);
  const sliceDragRef = useRef<number | null>(null); // index of the marker being dragged
  const slicePreviewingRef = useRef(false); // a region-click audition is held
  const lastPh = useRef<number | null>(null);
  const dirRef = useRef(1); // inferred playhead travel direction (+1 / -1)
  // The slice the sequence most recently fired (slice mode) — lit in the draw
  // pass, auto-clears shortly after the last hit so it goes dark when playback
  // stops. Driven by the dispatch-path sliceHit telemetry, filtered to this voice.
  const [activeSlice, setActiveSlice] = useState<number | null>(null);
  const hitTimer = useRef<number | null>(null);

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

  // Live active-slice highlight: subscribe to the dispatch-path slice hits for
  // this voice, hold the last-fired index, and clear it ~260ms after the last
  // hit so it darkens when the sequence stops. Same-index consecutive hits keep
  // resetting the clear timer (stays lit); a new index re-renders the cell.
  useEffect(() => {
    setActiveSlice(null);
    const off = onSliceHit((hitVoice, index) => {
      if (hitVoice !== voiceId) return;
      setActiveSlice(index);
      if (hitTimer.current != null) window.clearTimeout(hitTimer.current);
      hitTimer.current = window.setTimeout(() => setActiveSlice(null), 260);
    });
    return () => {
      off();
      if (hitTimer.current != null) window.clearTimeout(hitTimer.current);
    };
  }, [voiceId]);

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

    // The "bright" window: the whole sample in slice mode, the trim region in
    // sample mode, the grain window in granular mode (read position → grainFrac).
    const winStart = sliceMode ? 0 : granular ? granular.position : start;
    const winEnd = sliceMode ? 1 : granular ? Math.min(1, granular.position + grainFrac) : end;

    if (peaks) {
      // fillRect with a 1px height floor — stroked zero-height lines draw
      // nothing at all, which is what made quiet/smooth spans render hollow.
      // Each column's band is ANCHORED TO THE ZERO LINE: a pure min/max band
      // degenerates to a 1px contour on low-frequency material (a kick's
      // cycle spans hundreds of samples, so min≈max within one column — the
      // "hollow waveform on rhythm channels" report). Filling from the zero
      // crossing gives the classic solid body; dense columns (noise, snares)
      // already straddle zero and render identically. Don't revert to a bare
      // min/max band — this is the third recurrence of this glitch family.
      const sx = peaks.columns / width;
      for (let x = 0; x < width; x++) {
        const col = Math.min(peaks.columns - 1, Math.floor(x * sx));
        const min = peaks.peaks[col * 2];
        const max = peaks.peaks[col * 2 + 1];
        const frac = x / width;
        const inWindow = frac >= winStart && frac <= winEnd;
        ctx.fillStyle = inWindow ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)';
        const yTop = mid - Math.max(max, 0) * amp;
        const yBot = mid - Math.min(min, 0) * amp;
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, mid, width, 1);
    }

    if (sliceMode) {
      // Slice markers: a vertical line + top grab-tab at each slice start, with
      // faint alternating cell shading so adjacent slices read as distinct. The
      // implied last edge (sample end) isn't drawn — the waveform edge marks it.
      for (let i = 0; i < slices!.length; i++) {
        const mx = slices![i] * width;
        const nx = (i + 1 < slices!.length ? slices![i + 1] : 1) * width;
        const isActive = i === activeSlice;
        if (isActive) {
          // The slice the sequence is currently firing — a bright wash over the
          // whole cell so you can watch the pattern walk the break.
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.fillRect(mx, 0, Math.max(1, nx - mx), HEIGHT);
        } else if (i % 2 === 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(mx, 0, Math.max(1, nx - mx), HEIGHT);
        }
        ctx.strokeStyle = isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mx, 0);
        ctx.lineTo(mx, HEIGHT);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(mx - 1, 0, 3, 6);
      }
    } else if (granular) {
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
  }, [peaks, width, start, end, playhead, loopMode, granular?.position, granular?.grainMs, sliceMode, slices, activeSlice]);

  const xToFrac = (clientX: number): number => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const applyDrag = (which: 'start' | 'end', frac: number) => {
    if (which === 'start') onChange({ start: Math.min(frac, end - 0.001) });
    else onChange({ end: Math.max(frac, start + 0.001) });
  };

  // --- slice-mode editing helpers (S2b) ---
  // Min spacing between markers, ~20ms of the sample so cuts can't stack.
  const sliceMinGap = (): number => (peaks ? (0.02 * 44100) / peaks.frames : 0.005);
  // The slice a fraction falls in: the last start-point ≤ frac (0 if before all).
  const sliceIndexAt = (frac: number): number => {
    if (!slices || slices.length === 0) return 0;
    let idx = 0;
    for (let i = 0; i < slices.length; i++) {
      if (slices[i] <= frac) idx = i;
      else break;
    }
    return idx;
  };

  const onDown = (e: React.PointerEvent) => {
    if (sliceMode) {
      const frac = xToFrac(e.clientX);
      canvasRef.current!.setPointerCapture(e.pointerId);
      // Nearest marker within the grab threshold → drag it (or alt/⌘-click to
      // remove). Otherwise a bare region click auditions that slice.
      const hitFrac = 6 / (width || 1);
      let nearest = -1;
      let nd = Infinity;
      for (let i = 0; i < slices!.length; i++) {
        const d = Math.abs(slices![i] - frac);
        if (d < nd) {
          nd = d;
          nearest = i;
        }
      }
      if (nearest >= 0 && nd <= hitFrac) {
        if (e.altKey || e.metaKey) {
          onSlicesChange?.(slices!.filter((_, i) => i !== nearest));
        } else {
          sliceDragRef.current = nearest;
        }
        return;
      }
      slicePreviewingRef.current = true;
      onSlicePreview?.(sliceIndexAt(frac), true);
      return;
    }
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
    if (sliceMode) {
      if (sliceDragRef.current == null) return;
      const i = sliceDragRef.current;
      const frac = xToFrac(e.clientX);
      const gap = sliceMinGap();
      // Clamp between neighbours so the array stays sorted (index stable).
      const lo = i > 0 ? slices![i - 1] + gap : 0;
      const hi = i + 1 < slices!.length ? slices![i + 1] - gap : 1;
      const next = slices!.slice();
      next[i] = Math.max(lo, Math.min(hi, frac));
      onSlicesChange?.(next);
      return;
    }
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
    if (sliceMode && slicePreviewingRef.current) {
      slicePreviewingRef.current = false;
      onSlicePreview?.(0, false);
    }
    sliceDragRef.current = null;
    dragRef.current = null;
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  // Double-click empty space adds a marker there (rejected if it would stack on
  // an existing one or exceed the 48-point .pti cap).
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!sliceMode || !slices) return;
    if (slices.length >= 48) return;
    const frac = xToFrac(e.clientX);
    const gap = sliceMinGap();
    if (slices.some((s) => Math.abs(s - frac) < gap)) return;
    onSlicesChange?.([...slices, frac].sort((a, b) => a - b));
  };

  return (
    <div ref={wrapRef} className="mb-3">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: HEIGHT, touchAction: 'none', display: 'block' }}
        className={`border border-white/15 bg-black/40 ${sliceMode ? 'cursor-pointer' : 'cursor-ew-resize'}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
