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
  type LfoDivision,
} from '../instruments/voiceEditsStore';

export interface DepthCfg {
  min: number;
  max: number;
  format: (d: number) => string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Readable labels for the shape dropdown (the stored values are terse).
const SHAPE_LABEL: Record<LfoShape, string> = {
  revsaw: 'rev saw',
  saw: 'saw',
  tri: 'triangle',
  square: 'square',
  random: 'random',
};

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
      {/* shape plot on top; shape + rate dropdowns below it (no labels). */}
      <div className={`h-16 mb-1 ${value.on ? '' : 'opacity-50'}`}>
        <LfoShapePlot
          shape={value.shape}
          rateHz={lfoDivisionToHz(value.division, bpm)}
          depth={Math.abs(value.depth) / (depthCfg.max || 1)}
        />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <select
          value={value.shape}
          onChange={(e) => onChange({ shape: e.target.value as LfoShape })}
          className="select-chevron flex-1 min-w-0 bg-transparent border border-white/15 pl-2 pr-5 py-0.5 text-[10px] uppercase tracking-widest text-white/80 focus:outline-none focus:border-white"
        >
          {(['revsaw', 'saw', 'tri', 'square', 'random'] as LfoShape[]).map((s) => (
            <option key={s} value={s} className="bg-[#050505]">
              {SHAPE_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          value={value.division}
          onChange={(e) => onChange({ division: e.target.value as LfoDivision })}
          className="select-chevron flex-1 min-w-0 bg-transparent border border-white/15 pl-2 pr-5 py-0.5 text-[10px] tabular-nums text-white/80 focus:outline-none focus:border-white"
        >
          {LFO_DIVISIONS.map((d) => (
            <option key={d} value={d} className="bg-[#050505]">
              {d}
            </option>
          ))}
        </select>
      </div>
      <DepthKnob depth={value.depth} cfg={depthCfg} onChange={(d) => onChange({ depth: d })} />
    </div>
  );
}
