// Reusable modulation sections for the instrument editor (B2 grid). Each target
// (pan / cutoff / pitch / vol) gets an envelope section and/or an LFO section.
// They wrap the shared EnvelopeGraph + LfoShapePlot and a ○/● enable toggle,
// with a per-target depth knob (range + formatting supplied by the caller, so a
// bipolar cutoff sweep and a semitone pitch depth reuse the same component).
import { EnvelopeGraph } from './EnvelopeGraph';
import { LfoShapePlot } from './LfoShapePlot';
import { Knob } from './Knob';
import {
  LFO_DIVISIONS,
  lfoDivisionToHz,
  type EnvMod,
  type LfoMod,
  type LfoShape,
} from '../instruments/voiceEditsStore';

export interface DepthCfg {
  min: number;
  max: number;
  format: (d: number) => string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function ModHeader({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  // The whole row (dot + label) is the toggle hit target — easier than the dot.
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex items-center gap-2 mb-2"
      title={on ? 'on — click to disable' : 'off — click to enable'}
    >
      <span
        className={`text-[11px] leading-none transition-colors ${
          on ? 'text-white' : 'text-white/40 group-hover:text-white/70'
        }`}
      >
        {on ? '●' : '○'}
      </span>
      <span
        className={`text-[10px] uppercase tracking-widest whitespace-nowrap transition-colors ${
          on ? 'text-white/80' : 'text-white/40 group-hover:text-white/70'
        }`}
      >
        {label}
      </span>
    </button>
  );
}

function DepthKnob({
  depth,
  cfg,
  onChange,
}: {
  depth: number;
  cfg: DepthCfg;
  onChange: (d: number) => void;
}) {
  const norm = clamp01((depth - cfg.min) / (cfg.max - cfg.min));
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-[10px] uppercase tracking-widest text-white/50 w-14">depth</span>
      <div className="flex-1">
        <Knob
          value={norm}
          displayValue={norm}
          bipolar={cfg.min < 0}
          onChange={(n) => onChange(cfg.min + n * (cfg.max - cfg.min))}
          size={34}
        />
      </div>
      <span className="text-[11px] tabular-nums text-white/70 w-16 text-right">
        {cfg.format(depth)}
      </span>
    </div>
  );
}

export function ModEnvSection({
  label,
  value,
  depthCfg,
  onChange,
}: {
  label: string;
  value: EnvMod;
  depthCfg: DepthCfg;
  onChange: (patch: Partial<EnvMod>) => void;
}) {
  const ms = (s: number) => `${Math.round(s * 1000)}`;
  return (
    <div className="mb-5">
      <ModHeader label={label} on={value.on} onToggle={() => onChange({ on: !value.on })} />
      <div className={value.on ? '' : 'opacity-50'}>
        <EnvelopeGraph env={value} onChange={(p) => onChange(p)} />
      </div>
      <div className="flex justify-between text-[9px] uppercase tracking-widest text-white/40 tabular-nums mb-2 px-1">
        <span>atk {ms(value.attack)}</span>
        <span>dcy {ms(value.decay)}</span>
        <span>sus {(value.sustain * 100).toFixed(0)}%</span>
        <span>rel {ms(value.release)}</span>
      </div>
      <DepthKnob depth={value.depth} cfg={depthCfg} onChange={(d) => onChange({ depth: d })} />
    </div>
  );
}

export function ModLfoSection({
  label,
  value,
  depthCfg,
  bpm,
  onChange,
}: {
  label: string;
  value: LfoMod;
  depthCfg: DepthCfg;
  bpm: number;
  onChange: (patch: Partial<LfoMod>) => void;
}) {
  return (
    <div className="mb-5">
      <ModHeader label={label} on={value.on} onToggle={() => onChange({ on: !value.on })} />
      <div className="flex items-stretch gap-2 mb-1">
        <div className="flex gap-1">
          <div className="flex flex-col gap-1">
            {(['revsaw', 'saw', 'tri', 'square', 'random'] as LfoShape[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onChange({ shape: s })}
                className={`w-12 flex-1 px-1 py-1 text-[9px] uppercase tracking-widest border transition-colors ${
                  value.shape === s
                    ? 'border-white text-white'
                    : 'border-white/15 text-white/40 hover:text-white/70'
                }`}
              >
                {s === 'revsaw' ? 'rsaw' : s === 'square' ? 'sqr' : s === 'random' ? 'rnd' : s}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {LFO_DIVISIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onChange({ division: d })}
                className={`w-12 flex-1 px-1 py-1 text-[9px] tabular-nums tracking-widest border transition-colors ${
                  value.division === d
                    ? 'border-white text-white'
                    : 'border-white/15 text-white/40 hover:text-white/70'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className={`flex-1 min-w-0 ${value.on ? '' : 'opacity-50'}`}>
          <LfoShapePlot
            shape={value.shape}
            rateHz={lfoDivisionToHz(value.division, bpm)}
            depth={Math.abs(value.depth) / (depthCfg.max || 1)}
          />
        </div>
      </div>
      <div className="flex justify-end text-[9px] tabular-nums text-white/40 mb-2 pr-1">
        {value.division} · ≈{lfoDivisionToHz(value.division, bpm).toFixed(1)} Hz
      </div>
      <DepthKnob depth={value.depth} cfg={depthCfg} onChange={(d) => onChange({ depth: d })} />
    </div>
  );
}
