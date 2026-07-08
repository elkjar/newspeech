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
  toggleNoiseClockSynced,
  type NoiseSource,
} from '../audio/noise';
import { noiseClockKnobFromHz } from '../audio/noise';
import { noiseViz } from '../audio/nativeEngine';
import { RATE_DIVISIONS, speedFromKnob } from '../audio/loops';

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

// NOISE tab (docs/loop-resample.md §NOISE) — the Mörser-shaped second unit.
// Groups + dividers match the FX/master section. INPUT picks the routing:
// LOOP (true insert — Loop A routes through this chain, wet-only, and the
// loop's SAVE prints the post-noise output) · CAPT (own bar-quantized
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
    <div className="flex flex-col items-center gap-2">
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      <div className="flex items-start gap-3">{children}</div>
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
}: {
  label: string;
  valueText: string;
  value: number;
  onChange: (v: number) => void;
  bipolar?: boolean;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Knob size={40} value={value} onChange={onChange} bipolar={bipolar} title={title ?? label} />
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
    <div className="h-full p-3 flex flex-col justify-center gap-3">
      <div className="flex items-stretch justify-center gap-4">
        <Group label="input">
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              {(
                [
                  [0, 'loop', 'Loop A routes THROUGH this chain (wet-only; loop SAVE prints the post-noise output)'],
                  [1, 'capt', 'own bar-quantized capture — a second bed alongside Loop A'],
                  [2, 'off', 'no input — the clocked noise alone through the filter (self-sounding)'],
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
            <div className="flex gap-1.5 items-end">
              {CAPTURE_BARS.map((n) => (
                <SlotButton
                  key={n}
                  label={`${n}`}
                  active={v.bars === n}
                  disabled={v.source !== 1}
                  onClick={() => noiseCaptureBars(n)}
                  title={`capture the last ${n} bar${n === 1 ? '' : 's'} into the noise unit`}
                />
              ))}
              <SlotButton
                label="stop"
                wide
                active={false}
                disabled={v.source !== 1 || v.bars === null}
                onClick={noiseStop}
                title="drop the noise unit's capture"
              />
            </div>
          </div>
          <PKnob
            label="speed"
            valueText={speedLabel(v.speedKnob)}
            value={v.speedKnob}
            bipolar
            onChange={(x) => setNoiseParam('speedKnob', x)}
            title="capture playback vari-speed (octave ladder, thru-zero) — CAPT source only"
          />
        </Group>
        <Divider />
        <Group label="filter">
          <PKnob
            label="drive"
            valueText={`${Math.round(v.drive * 100)}`}
            value={v.drive}
            onChange={(x) => setNoiseParam('drive', x)}
            title="input gain INTO the filter (1–24x) — the WASP level-sensitivity: pushing it is the sound; resonance squelches under load"
          />
          <PKnob
            label="cutoff"
            valueText={`${Math.round(v.cutoff * 100)}`}
            value={v.cutoff}
            onChange={(x) => setNoiseParam('cutoff', x)}
            title="WASP-grit filter cutoff (40hz–12k log) — the clocked noise jitters it via cv"
          />
          <PKnob
            label="res"
            valueText={`${Math.round(v.res * 100)}`}
            value={v.res}
            onChange={(x) => setNoiseParam('res', x)}
            title="resonance — top of range rides the edge of self-oscillation (the tanh keeps the scream musical)"
          />
          <PKnob
            label="width"
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
        <div className="flex flex-col items-center gap-2">
          <span className="flex items-center gap-2 text-[9px] uppercase tracking-widest text-white/40">
            noise
            <PingLeds />
          </span>
          <div className="flex items-start gap-3">
          <PKnob
            label="noise"
            valueText={`${Math.round(v.noise * 100)}`}
            value={v.noise}
            onChange={(x) => setNoiseParam('noise', x)}
            title="clocked digital noise into the audio path (excites the resonance)"
          />
          <PKnob
            label="cv"
            valueText={`${Math.round(v.cv * 100)}`}
            value={v.cv}
            onChange={(x) => setNoiseParam('cv', x)}
            title="clocked noise into the cutoff (±2 octaves at full) — the morse-code/rainforest maker"
          />
          <div className="flex flex-col items-center gap-1">
            <PKnob
              label="clock"
              valueText={
                v.clockSynced
                  ? NOISE_CLOCK_LABELS[v.clockDivIdx]
                  : v.clockHz >= 1000
                    ? `${(v.clockHz / 1000).toFixed(1)}k`
                    : v.clockHz >= 10
                      ? `${v.clockHz.toFixed(0)}hz`
                      : `${v.clockHz.toFixed(1)}hz`
              }
              value={
                v.clockSynced
                  ? v.clockDivIdx / (RATE_DIVISIONS.length - 1)
                  : noiseClockKnobFromHz(v.clockHz)
              }
              onChange={(x) =>
                v.clockSynced
                  ? setNoiseClockDiv(x * (RATE_DIVISIONS.length - 1))
                  : setNoiseClockHz(noiseClockHzFromKnob(x))
              }
              title={
                v.clockSynced
                  ? 'noise clock — bar divisions, grid-anchored (the chatter locks to the groove)'
                  : 'noise clock — free, 0.5hz to 8k: slow = stepped CV blips, audio-rate = pitched digital hash'
              }
            />
            <button
              type="button"
              onClick={toggleNoiseClockSynced}
              className="flex items-center gap-1 text-[9px] uppercase tracking-widest bg-transparent border-0 text-white/50 hover:text-white transition-colors"
              title="clocked (divisions of the bar) vs free (hz)"
            >
              <span>{v.clockSynced ? '●' : '○'}</span>
              <span>sync</span>
            </button>
          </div>
          </div>
        </div>
        <Divider />
        <Group label="sends">
          <PKnob
            label="fx"
            valueText={`${Math.round(v.fxSend * 100)}`}
            value={v.fxSend}
            onChange={(x) => setNoiseParam('fxSend', x)}
            title="unit output → mangler bus"
          />
          <PKnob
            label="verb"
            valueText={`${Math.round(v.revSend * 100)}`}
            value={v.revSend}
            onChange={(x) => setNoiseParam('revSend', x)}
            title="unit output → reverb bus"
          />
          <PKnob
            label="dly"
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
            valueText={`${Math.round(v.level * 100)}`}
            value={Math.min(1, v.level / 1.5)}
            onChange={(x) => setNoiseLevel(x * 1.5)}
            title="unit return level — 0 bypasses (LOOP source injects direct again); distortion is always on, no blend"
          />
        </Group>
      </div>
    </div>
  );
}
