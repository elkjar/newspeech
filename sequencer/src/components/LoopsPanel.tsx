import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Knob } from './Knob';
import {
  RATE_DIVISIONS,
  RATE_DIVISION_LABELS,
  captureBars,
  grainSecsFromSize,
  loopBars,
  loopLenFrames,
  loopParamValues,
  loopSaving,
  loopsVersion,
  saveLoop,
  rateHzFromKnob,
  setLoopGrains,
  setLoopLayerLevel,
  setLoopParam,
  pitchFromKnob,
  setLoopRateDiv,
  setLoopRateHz,
  toggleLoopLock,
  toggleLoopRateSynced,
  speedFromKnob,
  stopLoop,
  subscribeLoops,
} from '../audio/loops';
import { engineSampleRate } from '../audio/engineClock';
import { loopPeaks, loopViz } from '../audio/nativeEngine';
import { GLOBAL_TRACK_ID, type LFO, type LFODestKnobGlobal } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useRoutedLFOs } from '../hooks/useRoutedLFOs';
import { useSequencerStore } from '../state/store';

// Stable empty list for knobs without an LFO destination (same trick as
// FXPanel — a fresh [] per render would look like a routing change).
const EMPTY_LFO_LIST: LFO[] = [];

// LOOPS tab (P1+P2, docs/loop-resample.md) — the loop/resample view.
// Anatomy mirrors the params view: waveform window on the left (same
// height + framing as the instrument editor's Waveform), controls on the
// right. Capture pads grab the last N bars of the mix (retroactive,
// bar-locked, phase-continuous); the manipulation set is the
// Morphagene/ADDAC-112 blend: SPEED (thru-zero octave ladder), SIZE
// (tape → grains), GRAINS (concurrent voices), RATE (spawn hz), RANDOM
// (start-point randomness — position's deviation), LEVEL. SIZE/SPEED/RATE
// carry ADDAC-style per-control DEVIATION: shift-drag a knob to set it
// (±nn under the value) — each grain rolls its own value in that range.
// The waveform shows the captured loop with a live playhead (direction
// caret, like the params view) and one marker per sounding grain, polled
// ~30Hz from lock-free engine statics and drawn imperatively.

const CAPTURE_BARS = [1, 2, 4, 8];
const VIZ_POLL_MS = 33;
const DEV_DRAG_PX = 150; // full deviation range per 150px of shift-drag

function speedLabel(knob: number): string {
  const s = speedFromKnob(knob);
  if (s === 0) return 'stop';
  const mag = Math.abs(s);
  const body = mag >= 1 ? `${mag}x` : `1/${Math.round(1 / mag)}x`;
  return `${s > 0 ? '' : '−'}${body}`;
}

function pitchLabel(knob: number): string {
  const s = pitchFromKnob(knob);
  if (s === 0) return 'follow';
  const mag = Math.abs(s);
  const body = mag >= 1 ? `${mag}x` : `1/${Math.round(1 / mag)}x`;
  return `${s > 0 ? '' : '−'}${body}`;
}

function sizeLabel(size: number): string {
  const secs = grainSecsFromSize(size);
  return secs >= 1 ? `${secs.toFixed(1)}s` : `${Math.round(secs * 1000)}ms`;
}

// Captured-loop waveform + live playhead/grain overlay. Imperative canvas:
// peaks re-fetch on engine viz version change; overlay redraws every poll.
function LoopWave({
  active,
  onBounce,
}: {
  active: boolean;
  // Reports save-bounce progress (0..1, -1 = none) each viz poll.
  onBounce?: (p: number) => void;
}) {
  const onBounceRef = useRef(onBounce);
  onBounceRef.current = onBounce;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<number[] | null>(null);
  const versionRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    const draw = (pos: number, grains: number[]) => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const width = Math.floor(wrap.clientWidth);
      const height = Math.floor(wrap.clientHeight);
      if (width <= 0 || height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr) canvas.width = width * dpr;
      if (canvas.height !== height * dpr) canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const mid = height / 2;
      const amp = mid - 3;
      const peaks = peaksRef.current;
      if (!peaks || !active) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(0, mid, width, 1);
        return;
      }
      const cols = peaks.length / 2;
      // Zero-anchored fill — a bare min/max band hollows out on
      // low-frequency material (see Waveform.tsx; same glitch family).
      // Brightness matches the params view's in-window fill.
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      for (let x = 0; x < width; x++) {
        const col = Math.min(cols - 1, Math.floor((x / width) * cols));
        const mn = peaks[col * 2];
        const mx = peaks[col * 2 + 1];
        const yTop = mid - Math.max(mx, 0) * amp;
        const yBot = mid - Math.min(mn, 0) * amp;
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
      // Grain markers — width from the SIZE knob, brightness from the
      // grain's live window level. Drawn under the playhead.
      const lenFrames = loopLenFrames();
      const { size, grainLevel } = loopParamValues();
      if (lenFrames && grainLevel > 0) {
        const grainFrac = Math.min(
          1,
          (grainSecsFromSize(size) * engineSampleRate()) / lenFrames,
        );
        const gw = Math.max(2, grainFrac * width);
        for (let i = 0; i < grains.length / 2; i++) {
          const gp = grains[i * 2];
          const env = grains[i * 2 + 1];
          if (gp < 0 || env <= 0) continue;
          ctx.fillStyle = `rgba(255,255,255,${(0.1 + env * 0.28).toFixed(3)})`;
          ctx.fillRect(gp * width - gw / 2, 0, gw, height);
        }
      }
      // Playhead + direction caret — same language as the params view.
      if (pos >= 0) {
        const px = pos * width;
        ctx.strokeStyle = 'rgba(255,255,255,1)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, height);
        ctx.stroke();
        const s = speedFromKnob(loopParamValues().speedKnob);
        if (s !== 0) {
          const d = s > 0 ? 1 : -1;
          const cy = height - 6;
          ctx.fillStyle = 'rgba(255,255,255,1)';
          ctx.beginPath();
          ctx.moveTo(px, cy - 4);
          ctx.lineTo(px + 6 * d, cy);
          ctx.lineTo(px, cy + 4);
          ctx.closePath();
          ctx.fill();
        }
      }
    };
    const tick = async () => {
      if (cancelled) return;
      try {
        const viz = await loopViz();
        if (cancelled) return;
        if (viz.version !== versionRef.current) {
          versionRef.current = viz.version;
          peaksRef.current = await loopPeaks();
          if (cancelled) return;
        }
        draw(active ? viz.pos : -1, viz.grains);
        onBounceRef.current?.(viz.bounce);
      } catch {
        // engine not open — draw the idle line
        draw(-1, []);
        onBounceRef.current?.(-1);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), VIZ_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);

  // 1/3 of the tab width, full height — the controls own the rest.
  return (
    <div ref={wrapRef} className="w-1/3 shrink-0 self-stretch">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        className="border border-white/15 bg-black/40"
      />
    </div>
  );
}

// Thin vertical rule between groups — same as the FX/master section's.
function Divider() {
  return <div className="self-stretch w-px bg-white/10" />;
}

// Group shell matching FXGroup: centered micro-label over the controls.
function LoopGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      <div className="flex items-start gap-3">{children}</div>
    </div>
  );
}

function ParamKnob({
  label,
  valueText,
  value,
  onChange,
  bipolar = false,
  title,
  dev,
  onDev,
  lfoKnob,
}: {
  label: string;
  valueText: string;
  value: number;
  onChange: (v: number) => void;
  bipolar?: boolean;
  title?: string;
  // ADDAC-style per-control deviation: shift-drag sets it; each grain
  // rolls its own value within ±dev of the base.
  dev?: number;
  onDev?: (v: number) => void;
  // Global LFO destination — click during LFO-select toggles routing, the
  // visual swings with routed LFOs (same pattern as FXPanel knobs).
  lfoKnob?: LFODestKnobGlobal;
}) {
  const selectingLFO = useSequencerStore((st) => st.selectingLFO);
  const toggleLFODestination = useSequencerStore((st) => st.toggleLFODestination);
  const routedForKnob = useRoutedLFOs(GLOBAL_TRACK_ID, lfoKnob ?? 'density');
  const routed = lfoKnob ? routedForKnob : EMPTY_LFO_LIST;
  const displayValue = useLFOValue(value, routed, 1);
  const onModulationClick =
    lfoKnob && selectingLFO !== null
      ? () =>
          toggleLFODestination(selectingLFO, {
            trackId: GLOBAL_TRACK_ID,
            knob: lfoKnob,
          })
      : undefined;
  const lfoLabels = routed.map((l) => `L${l.id + 1}`).join(',');
  const modulationLabel =
    selectingLFO !== null
      ? lfoLabels || undefined
      : routed.length > 0
        ? lfoLabels
        : undefined;
  const devRef = useRef(dev ?? 0);
  devRef.current = dev ?? 0;
  const onDevRef = useRef(onDev);
  onDevRef.current = onDev;

  const handleShiftDown = (e: React.PointerEvent) => {
    if (!e.shiftKey || !onDevRef.current) return;
    // preventDefault suppresses the compatibility mousedown, so the inner
    // Knob never starts its own value drag.
    e.preventDefault();
    const startY = e.clientY;
    const startDev = devRef.current;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(
        0,
        Math.min(1, startDev + (startY - ev.clientY) / DEV_DRAG_PX),
      );
      onDevRef.current?.(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="flex flex-col items-center gap-1" onPointerDown={handleShiftDown}>
      <Knob
        size={40}
        value={value}
        displayValue={displayValue}
        onChange={onChange}
        bipolar={bipolar}
        title={title ?? label}
        onModulationClick={onModulationClick}
        modulationLabel={modulationLabel}
      />
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</span>
      <span className="text-[10px] tabular-nums opacity-50">{valueText}</span>
      {onDev && (
        <span
          className={[
            'text-[9px] tabular-nums',
            (dev ?? 0) > 0 ? 'opacity-60' : 'opacity-25',
          ].join(' ')}
          title="deviation — shift-drag the knob; each grain rolls its own value in ±this range"
        >
          ±{Math.round((dev ?? 0) * 100)}
        </span>
      )}
    </div>
  );
}

export function LoopsPanel() {
  useSyncExternalStore(subscribeLoops, loopsVersion);
  const bars = loopBars();
  const saving = loopSaving();
  // Save-bounce progress from the viz poll; quantized to whole percents so
  // the 30Hz poll only re-renders when the bar visibly moves.
  const [bouncePct, setBouncePct] = useState(-1);
  const onBounce = (p: number) => {
    const pct = p < 0 ? -1 : Math.round(p * 100);
    setBouncePct((cur) => (cur === pct ? cur : pct));
  };
  const {
    speedKnob,
    pitchKnob,
    loopLock,
    loopLevel,
    grainLevel,
    fxSend,
    revSend,
    delSend,
    size,
    random,
    grains,
    rateSynced,
    rateDivIdx,
    rateHz,
    sizeDev,
    pitchDev,
    rateDev,
  } = loopParamValues();

  return (
    <div className="h-full p-3 flex items-stretch gap-4">
      <LoopWave active={bars !== null} onBounce={onBounce} />
      {/* Capture stack — bar lengths + stop, riding the visualizer's right
          edge like a hardware button column. */}
      <div className="flex flex-col gap-1.5 shrink-0 self-stretch justify-center">
        {CAPTURE_BARS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => captureBars(n)}
            onContextMenu={(e) => e.preventDefault()}
            title={`capture the last ${n} bar${n === 1 ? '' : 's'} of the mix (bar-locked, seamless)`}
            className={[
              'w-12 h-9 border text-[11px] uppercase tracking-widest transition-colors select-none',
              bars === n
                ? 'bg-white text-ink border-white'
                : 'border-white/20 text-white/60 hover:text-white hover:border-white',
            ].join(' ')}
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          onClick={stopLoop}
          onContextMenu={(e) => e.preventDefault()}
          title="drop the loop"
          className={[
            'w-12 h-9 border text-[11px] uppercase tracking-widest transition-colors select-none',
            bars === null
              ? 'border-white/10 text-white/25'
              : 'border-white/40 text-white/80 hover:text-white hover:border-white',
          ].join(' ')}
        >
          stop
        </button>
        <button
          type="button"
          onClick={() => void saveLoop()}
          onContextMenu={(e) => e.preventDefault()}
          disabled={bars === null || saving}
          title="bounce the loop's OUTPUT (mangle included) to the samples library — one bar-aligned pass at the current speed, lands as a voice; filename carries bpm + printed bars"
          className={[
            'relative overflow-hidden w-12 h-9 border text-[11px] uppercase tracking-widest transition-colors select-none',
            bars === null
              ? 'border-white/10 text-white/25 cursor-default'
              : saving
                ? 'border-white/40 text-white/80 cursor-default'
                : 'border-white/40 text-white/80 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {saving && bouncePct >= 0 && (
            <span
              className="absolute inset-y-0 left-0 bg-white/25"
              style={{ width: `${bouncePct}%` }}
            />
          )}
          <span className={saving && bouncePct < 1 ? 'animate-pulse relative' : 'relative'}>
            {saving ? (bouncePct > 0 ? `${bouncePct}` : '···') : 'save'}
          </span>
        </button>
      </div>
      {/* Controls, grouped by workflow — spacing + dividers match the
          FX/master section (gap-4 container, w-px white/10 rules). */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-3">
        <div className="flex items-stretch justify-center gap-4">
          <Divider />
          <LoopGroup label="loop">
            <div className="flex flex-col items-center gap-1">
              <ParamKnob
                label="speed"
                lfoKnob="loopSpeed"
                valueText={speedLabel(speedKnob)}
                value={speedKnob}
                bipolar
                onChange={(v) => setLoopParam('speedKnob', v)}
                title={
                  loopLock
                    ? 'pure time control (pitch locked) — stretch, reverse-at-pitch, frozen slice at stop'
                    : 'thru-zero vari-speed, octave ladder — center stops the tape; pitch follows (tape physics)'
                }
              />
              <button
                type="button"
                onClick={toggleLoopLock}
                className="flex items-center gap-1 text-[9px] uppercase tracking-widest bg-transparent border-0 text-white/50 hover:text-white transition-colors"
                title="pitch-lock the loop layer — speed becomes pure timestretch (off = tape: pitch follows speed)"
              >
                <span>{loopLock ? '●' : '○'}</span>
                <span>lock</span>
              </button>
            </div>
            <ParamKnob
              label="level"
              lfoKnob="loopLevel"
              valueText={`${Math.round(loopLevel * 100)}`}
              value={Math.min(1, loopLevel / 1.5)}
              onChange={(v) => setLoopLayerLevel('loop', v * 1.5)}
              title="tape-loop layer return level — independent of the grain layer"
            />
          </LoopGroup>
          <Divider />
          <LoopGroup label="granular">
            <ParamKnob
              label="pitch"
              lfoKnob="loopPitch"
              valueText={pitchLabel(pitchKnob)}
              value={pitchKnob}
              bipolar
              onChange={(v) => setLoopParam('pitchKnob', v)}
              dev={pitchDev}
              onDev={(v) => setLoopParam('pitchDev', v)}
              title="grain pitch — center FOLLOWS speed (tape feel); off-center fixes grain pitch on the octave ladder regardless of speed = timestretch artifacts · shift-drag: per-grain deviation, quantized to fifths + octaves"
            />
            <ParamKnob
              label="size"
              lfoKnob="loopSize"
              valueText={sizeLabel(size)}
              value={size}
              onChange={(v) => setLoopParam('size', v)}
              dev={sizeDev}
              onDev={(v) => setLoopParam('sizeDev', v)}
              title="grain size (20ms–1.8s) · shift-drag: per-grain size deviation"
            />
            <ParamKnob
              label="grains"
              valueText={`${grains}`}
              value={(grains - 1) / 7}
              onChange={(v) => setLoopGrains(1 + v * 7)}
              title="concurrent grain voices (1–8) — new spawns steal the oldest"
            />
            <div className="flex flex-col items-center gap-1">
              <ParamKnob
                label="rate"
                lfoKnob="loopRate"
                valueText={
                  rateSynced
                    ? RATE_DIVISION_LABELS[rateDivIdx]
                    : rateHz >= 10
                      ? `${rateHz.toFixed(0)}hz`
                      : `${rateHz.toFixed(1)}hz`
                }
                value={
                  rateSynced
                    ? rateDivIdx / (RATE_DIVISIONS.length - 1)
                    : Math.log(rateHz / 0.5) / Math.log(120)
                }
                onChange={(v) =>
                  rateSynced
                    ? setLoopRateDiv(v * (RATE_DIVISIONS.length - 1))
                    : setLoopRateHz(rateHzFromKnob(v))
                }
                dev={rateDev}
                onDev={(v) => setLoopParam('rateDev', v)}
                title={
                  rateSynced
                    ? 'grain spawn division — spawns land ON the bar grid (1/1–1/32) · shift-drag: timing deviation'
                    : 'grain spawn rate (0.5–60hz, free-running) · shift-drag: timing deviation'
                }
              />
              <button
                type="button"
                onClick={toggleLoopRateSynced}
                className="flex items-center gap-1 text-[9px] uppercase tracking-widest bg-transparent border-0 text-white/50 hover:text-white transition-colors"
                title="clocked (divisions of the bar, grid-anchored) vs free (hz)"
              >
                <span>{rateSynced ? '●' : '○'}</span>
                <span>sync</span>
              </button>
            </div>
            <ParamKnob
              label="random"
              lfoKnob="loopRandom"
              valueText={`${Math.round(random * 100)}`}
              value={random}
              onChange={(v) => setLoopParam('random', v)}
              title="start-point randomness — 0 grains at the playhead, 100 anywhere in the loop"
            />
            <ParamKnob
              label="level"
              lfoKnob="loopGrainLevel"
              valueText={`${Math.round(grainLevel * 100)}`}
              value={Math.min(1, grainLevel / 1.5)}
              onChange={(v) => setLoopLayerLevel('grain', v * 1.5)}
              title="grain layer return level — independent of the tape loop"
            />
          </LoopGroup>
          <Divider />
          <LoopGroup label="sends">
            <ParamKnob
              label="fx"
              valueText={`${Math.round(fxSend * 100)}`}
              value={fxSend}
              onChange={(v) => setLoopParam('fxSend', v)}
              title="unit output → mangler bus (tape/glitch/drive chain)"
            />
            <ParamKnob
              label="verb"
              valueText={`${Math.round(revSend * 100)}`}
              value={revSend}
              onChange={(v) => setLoopParam('revSend', v)}
              title="unit output → reverb bus"
            />
            <ParamKnob
              label="dly"
              valueText={`${Math.round(delSend * 100)}`}
              value={delSend}
              onChange={(v) => setLoopParam('delSend', v)}
              title="unit output → delay bus"
            />
          </LoopGroup>
        </div>
      </div>
    </div>
  );
}
