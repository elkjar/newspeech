import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Knob } from './Knob';
import {
  NOISE_CLOCK_LABELS,
  noiseCaptureBars,
  noiseClockHzFromKnob,
  noiseStop,
  noiseValues,
  noiseVersion,
  setNoiseClockDiv,
  setNoiseClockHz,
  setNoiseLevel,
  setNoiseMode,
  setNoiseParam,
  setNoiseSource,
  subscribeNoise,
  setNoiseClockMode,
  setNoiseClockSrc,
  setNoiseXDiv,
  XING_DIVS,
  XING_DIV_LABELS,
  type NoiseSource,
} from '../audio/noise';
import { noiseClockKnobFromHz } from '../audio/noise';
import { noiseScope, noiseViz } from '../audio/nativeEngine';
import { RATE_DIVISIONS, speedFromKnob } from '../audio/loops';
import { GLOBAL_TRACK_ID, type LFO, type LFODestKnobGlobal } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useRoutedLFOs } from '../hooks/useRoutedLFOs';
import { useSequencerStore } from '../state/store';

// Stable empty list for knobs without an LFO destination (same trick as
// FXPanel — a fresh [] per render would look like a routing change).
const EMPTY_LFO_LIST: LFO[] = [];

// Ping LEDs — the Mörser's tuning light, lifted. Two dots (L/R: the
// bitstreams are independent, so the stereo flicker is information),
// polled ~30Hz while the tab is open and drawn imperatively so the poll
// never re-renders React.
function PingLeds() {
  const lRef = useRef<HTMLSpanElement>(null);
  const rRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const v = await noiseViz();
        if (cancelled) return;
        if (lRef.current)
          lRef.current.style.opacity = `${0.12 + Math.min(1, v[0] ?? 0) * 0.88}`;
        if (rRef.current)
          rRef.current.style.opacity = `${0.12 + Math.min(1, v[1] ?? 0) * 0.88}`;
      } catch {
        /* engine not open */
      }
    };
    const id = window.setInterval(() => void tick(), 33);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return (
    <span
      className="flex items-center gap-1.5"
      title="ping LEDs — one flash per noise edge, per channel"
    >
      <span ref={lRef} className="w-2 h-2 rounded-full bg-white" style={{ opacity: 0.12 }} />
      <span ref={rRef} className="w-2 h-2 rounded-full bg-white" style={{ opacity: 0.12 }} />
    </span>
  );
}

// Output scope — scrolling min/max waveform of the unit's PRE-level output
// (~1/2s window), polled ~30Hz from the lock-free engine ring and drawn
// imperatively (same anatomy as the LOOPS view's LoopWave). Ring order:
// data[0] is the write cursor; the column AT the cursor is the oldest, so
// drawing from the cursor puts newest at the right edge.
function NoiseScope() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const draw = (data: number[] | null) => {
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
      if (!data) {
        // Engine not open — the idle line, same as LoopWave.
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(0, mid, width, 1);
        return;
      }
      const cols = (data.length - 1) / 2;
      const pos = data[0] | 0;
      // Zero-anchored fill, same brightness as the loop waveform. A silent
      // unit reads as a 1px flatline — scope language.
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      for (let x = 0; x < width; x++) {
        const col = Math.min(cols - 1, Math.floor((x / width) * cols));
        const idx = (pos + col) % cols;
        const mn = data[1 + idx * 2];
        const mx = data[2 + idx * 2];
        const yTop = mid - Math.max(mx, 0) * amp;
        const yBot = mid - Math.min(mn, 0) * amp;
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
    };
    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await noiseScope();
        if (cancelled) return;
        draw(data);
      } catch {
        draw(null);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 33);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return (
    <div ref={wrapRef} className="w-1/4 shrink-0 self-stretch">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        className="border border-white/15 bg-black/40"
        title="noise unit output — scrolling scope, ~1/2s window (pre-LEVEL: shows the unit's voice even while the return is low)"
      />
    </div>
  );
}

// NOISE tab (docs/loop-resample.md §NOISE) — the Mörser-shaped second unit.
// Groups + dividers match the FX/master section. INPUT picks the routing:
// INS (true insert — Loop A routes through this chain, wet-only, and the
// loop's SAVE prints the post-noise output) · PAR (parallel — Loop A feeds
// the chain but keeps its direct out; send/return) · CAP (own bar-quantized
// capture — a second bed) · OFF (self-sounding: the clocked noise alone
// through the filter). The digital noise is clocked (bar divisions or free
// Hz) and feeds BOTH the audio path and the cutoff (the hardware's
// noise→CV normalling). Distortion is always on — DE philosophy.

const CAPTURE_BARS = [1, 2, 4, 8];

function Divider() {
  return <div className="self-stretch w-px bg-white/10" />;
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2">
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

function PKnob({
  label,
  valueText,
  value,
  onChange,
  bipolar = false,
  title,
  disabled = false,
  lfoKnob,
}: {
  label: string;
  valueText: string;
  value: number;
  onChange: (v: number) => void;
  bipolar?: boolean;
  title?: string;
  // Inert under the current settings (wrong source/mode) — dimmed and
  // non-interactive, but the title still explains what it would do.
  disabled?: boolean;
  // Global LFO destination — click during LFO-select toggles routing, the
  // visual swings with routed LFOs (same pattern as the LOOPS/FX knobs).
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
  return (
    <div
      className={[
        'flex flex-col items-center gap-1 transition-opacity',
        disabled ? 'opacity-30' : '',
      ].join(' ')}
      title={disabled ? (title ?? label) : undefined}
    >
      <div className={disabled ? 'pointer-events-none' : ''}>
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
      </div>
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</span>
      <span className="text-[10px] tabular-nums opacity-50">{valueText}</span>
    </div>
  );
}

function SlotButton({
  label,
  active,
  disabled = false,
  onClick,
  title,
  wide = false,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onContextMenu={(e) => e.preventDefault()}
      title={title}
      className={[
        wide ? 'w-14' : 'w-11',
        'h-9 border text-[11px] uppercase tracking-widest transition-colors select-none',
        disabled
          ? 'border-white/10 text-white/25 cursor-default'
          : active
            ? 'bg-white text-ink border-white'
            : 'border-white/20 text-white/60 hover:text-white hover:border-white',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function speedLabel(knob: number): string {
  const s = speedFromKnob(knob);
  if (s === 0) return 'stop';
  const mag = Math.abs(s);
  const body = mag >= 1 ? `${mag}x` : `1/${Math.round(1 / mag)}x`;
  return `${s > 0 ? '' : '−'}${body}`;
}

export function NoisePanel() {
  useSyncExternalStore(subscribeNoise, noiseVersion);
  const v = noiseValues();

  return (
    <div className="h-full p-3 flex items-stretch gap-4">
      <NoiseScope />
      {/* Capture stack — bar lengths + stop riding the scope's right edge,
          mirroring the LOOPS view; live only for the CAP source. */}
      <div className="flex flex-col gap-1.5 shrink-0 self-stretch justify-center">
        {CAPTURE_BARS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => noiseCaptureBars(n)}
            onContextMenu={(e) => e.preventDefault()}
            disabled={v.source !== 2}
            title={`capture the last ${n} bar${n === 1 ? '' : 's'} of the mix into the noise unit (CAP source)`}
            className={[
              'w-12 h-9 border text-[11px] uppercase tracking-widest transition-colors select-none',
              v.source !== 2
                ? 'border-white/10 text-white/25 cursor-default'
                : v.bars === n
                  ? 'bg-white text-ink border-white'
                  : 'border-white/20 text-white/60 hover:text-white hover:border-white',
            ].join(' ')}
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          onClick={noiseStop}
          onContextMenu={(e) => e.preventDefault()}
          disabled={v.source !== 2 || v.bars === null}
          title="drop the noise unit's capture"
          className={[
            'w-12 h-9 border text-[11px] uppercase tracking-widest transition-colors select-none',
            v.source !== 2 || v.bars === null
              ? 'border-white/10 text-white/25 cursor-default'
              : 'border-white/40 text-white/80 hover:text-white hover:border-white',
          ].join(' ')}
        >
          stop
        </button>
      </div>
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-3">
        <div className="flex items-center justify-center gap-4">
          <Divider />
          <Group label="input">
            <div className="flex flex-col gap-1.5">
              {(
                [
                  [0, 'ins', 'insert: Loop A routes THROUGH this chain (wet-only; loop SAVE prints the post-noise output)'],
                  [1, 'par', 'parallel: Loop A feeds this chain but keeps its direct out — send/return (SAVE prints loop + noise)'],
                  [2, 'cap', 'own bar-quantized capture — a second bed alongside Loop A'],
                  [3, 'off', 'no input — the clocked noise alone through the filter (self-sounding)'],
                ] as [NoiseSource, string, string][]
              ).map(([src, label, title]) => (
                <SlotButton
                  key={src}
                  label={label}
                  wide
                  active={v.source === src}
                  onClick={() => setNoiseSource(src)}
                  title={title}
                />
              ))}
            </div>
            <PKnob
              label="speed"
              lfoKnob="noiseSpeed"
              valueText={speedLabel(v.speedKnob)}
              value={v.speedKnob}
              bipolar
              disabled={v.source !== 2}
              onChange={(x) => setNoiseParam('speedKnob', x)}
              title="capture playback vari-speed (octave ladder, thru-zero) — CAP source only"
            />
          </Group>
          <Divider />
          <Group label="filter">
            <PKnob
              label="drive"
              lfoKnob="noiseDrive"
              valueText={`${Math.round(v.drive * 100)}`}
              value={v.drive}
              onChange={(x) => setNoiseParam('drive', x)}
              title="input gain INTO the filter (1–24x) — the WASP level-sensitivity: pushing it is the sound; resonance squelches under load"
            />
            <PKnob
              label="cutoff"
              lfoKnob="noiseCutoff"
              valueText={`${Math.round(v.cutoff * 100)}`}
              value={v.cutoff}
              onChange={(x) => setNoiseParam('cutoff', x)}
              title="WASP-grit filter cutoff (40hz–12k log) — the clocked noise jitters it via cv"
            />
            <PKnob
              label="res"
              lfoKnob="noiseRes"
              valueText={`${Math.round(v.res * 100)}`}
              value={v.res}
              onChange={(x) => setNoiseParam('res', x)}
              title="resonance — top of range rides the edge of self-oscillation (the tanh keeps the scream musical)"
            />
            <PKnob
              label="width"
              lfoKnob="noiseWidth"
              valueText={`${Math.round(v.width * 100)}`}
              value={v.width}
              onChange={(x) => setNoiseParam('width', x)}
              title="L/R resonance offset — stereo instability"
            />
            <div className="flex flex-col gap-1.5 pt-1">
              <SlotButton
                label="lp"
                active={v.mode === 0}
                onClick={() => setNoiseMode(0)}
                title="lowpass tap"
              />
              <SlotButton
                label="bp"
                active={v.mode === 1}
                onClick={() => setNoiseMode(1)}
                title="bandpass tap"
              />
            </div>
          </Group>
          <Divider />
          <div className="flex flex-col items-center justify-center gap-2">
            <span className="flex items-center gap-2 text-[9px] uppercase tracking-widest text-white/40">
              noise
              <PingLeds />
            </span>
            <div className="flex items-center gap-3">
              <PKnob
                label="noise"
                lfoKnob="noiseAmt"
                valueText={`${Math.round(v.noise * 100)}`}
                value={v.noise}
                onChange={(x) => setNoiseParam('noise', x)}
                title="clocked digital noise into the audio path (excites the resonance)"
              />
              <PKnob
                label="cv"
                lfoKnob="noiseCv"
                valueText={`${Math.round(v.cv * 100)}`}
                value={v.cv}
                onChange={(x) => setNoiseParam('cv', x)}
                title="clocked noise into the cutoff (±2 octaves at full) — the morse-code/rainforest maker"
              />
            </div>
          </div>
          <Divider />
          <Group label="clock">
            <div className="flex flex-col gap-1.5">
              <SlotButton
                label="sync"
                active={v.clockMode === 0 && v.clockSynced}
                onClick={() => setNoiseClockMode('sync')}
                title="timer clock, bar divisions — grid-anchored (the chatter locks to the groove)"
              />
              <SlotButton
                label="free"
                active={v.clockMode === 0 && !v.clockSynced}
                onClick={() => setNoiseClockMode('free')}
                title="timer clock, free-running hz — slow = stepped CV blips, audio-rate = pitched digital hash"
              />
              <SlotButton
                label="self"
                active={v.clockMode === 1 && v.clockSrc === 0}
                onClick={() => setNoiseClockSrc(0)}
                title="signal clock — the unit's own input's zero crossings tick it (true Spektrum self-reference; silence stops the clock)"
              />
              <SlotButton
                label="loop"
                active={v.clockMode === 1 && v.clockSrc === 1}
                onClick={() => setNoiseClockSrc(1)}
                title="signal clock — Loop A's output ticks it (two captures intermodulating, the ecosystem patch)"
              />
              <SlotButton
                label="mix"
                active={v.clockMode === 1 && v.clockSrc === 2}
                onClick={() => setNoiseClockSrc(2)}
                title="signal clock — the whole live mix ticks it"
              />
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <PKnob
                label="clock"
                lfoKnob="noiseClock"
                valueText={
                  v.clockMode === 1
                    ? XING_DIV_LABELS[v.xDivIdx]
                    : v.clockSynced
                      ? NOISE_CLOCK_LABELS[v.clockDivIdx]
                      : v.clockHz >= 1000
                        ? `${(v.clockHz / 1000).toFixed(1)}k`
                        : v.clockHz >= 10
                          ? `${v.clockHz.toFixed(0)}hz`
                          : `${v.clockHz.toFixed(1)}hz`
                }
                value={
                  v.clockMode === 1
                    ? v.xDivIdx / (XING_DIVS.length - 1)
                    : v.clockSynced
                      ? v.clockDivIdx / (RATE_DIVISIONS.length - 1)
                      : noiseClockKnobFromHz(v.clockHz)
                }
                onChange={(x) =>
                  v.clockMode === 1
                    ? setNoiseXDiv(x * (XING_DIVS.length - 1))
                    : v.clockSynced
                      ? setNoiseClockDiv(x * (RATE_DIVISIONS.length - 1))
                      : setNoiseClockHz(noiseClockHzFromKnob(x))
                }
                title={
                  v.clockMode === 1
                    ? 'crossing divider — ticks every Nth zero crossing of the clock source (audio-rate pitches → gesture rate)'
                    : v.clockSynced
                      ? 'noise clock — bar divisions, grid-anchored (the chatter locks to the groove)'
                      : 'noise clock — free, 0.5hz to 8k: slow = stepped CV blips, audio-rate = pitched digital hash'
                }
              />
              <PKnob
                label="sens"
                lfoKnob="noiseSens"
                valueText={`${Math.round(v.sens * 100)}`}
                value={v.sens}
                disabled={v.clockMode !== 1}
                onChange={(x) => setNoiseParam('sens', x)}
                title="crossing hysteresis (signal clocks only) — low: everything clocks it; high: only loud material gets to be the clock"
              />
            </div>
          </Group>
          <Divider />
          <Group label="sends">
            <PKnob
              label="fx"
              lfoKnob="noiseFxSend"
              valueText={`${Math.round(v.fxSend * 100)}`}
              value={v.fxSend}
              onChange={(x) => setNoiseParam('fxSend', x)}
              title="unit output → mangler bus"
            />
            <PKnob
              label="verb"
              lfoKnob="noiseRevSend"
              valueText={`${Math.round(v.revSend * 100)}`}
              value={v.revSend}
              onChange={(x) => setNoiseParam('revSend', x)}
              title="unit output → reverb bus"
            />
            <PKnob
              label="dly"
              lfoKnob="noiseDelSend"
              valueText={`${Math.round(v.delSend * 100)}`}
              value={v.delSend}
              onChange={(x) => setNoiseParam('delSend', x)}
              title="unit output → delay bus"
            />
          </Group>
          <Divider />
          <Group label="out">
            <PKnob
              label="level"
              lfoKnob="noiseLevel"
              valueText={`${Math.round(v.level * 100)}`}
              value={Math.min(1, v.level / 1.5)}
              onChange={(x) => setNoiseLevel(x * 1.5)}
              title="unit return level — 0 bypasses (an INS loop injects direct again); distortion is always on, no blend"
            />
          </Group>
        </div>
      </div>
    </div>
  );
}
