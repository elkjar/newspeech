import { useCallback, useEffect, useState } from 'react';
import { useSequencerStore } from '../state/store';
import { Knob } from './Knob';
import { GLOBAL_TRACK_ID, type LFO, type LFODestKnobGlobal } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useRoutedLFOs } from '../hooks/useRoutedLFOs';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget } from '../midi/midiMap';
import type { TapeParams } from '../audio/tape';
import type { GlitchParams } from '../audio/glitch';
import type { ReverbParams } from '../audio/reverb';
import type { SaturationParams } from '../audio/saturation';
import {
  loCutLabel,
  modeLabel,
  compAttackLabel,
  compReleaseLabel,
  LO_CUT_POSITIONS,
  MODE_COUNT,
  COMP_ATTACK_COUNT,
  COMP_RELEASE_COUNT,
  MASTER_PRESET_NAMES,
  findActivePreset,
  type MasterParams,
} from '../audio/master';

// Stage wrappers below own per-knob subscriptions so a single FX field
// change only re-renders the knob bound to that field. The parent FXPanel
// no longer subscribes to any FX stage object directly — pre-refactor, a
// `setTape({position: v})` mousemove re-rendered all 40+ knobs in the
// panel because every knob's parent subscribed to the whole `tape` object.
type NumericKeys<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];
type BooleanKeys<T> = {
  [K in keyof T]: T[K] extends boolean ? K : never;
}[keyof T];

const KNOB_SIZE = 44;

// Stable empty reference for knobs that don't participate in LFO routing
// (those without an lfoKnob prop). Returning a fresh `[]` each render would
// look like a routing change to useLFOValue's downstream `routed` ref and
// cause an unnecessary render hop the first time the empty list "settles."
const EMPTY_LFO_LIST: LFO[] = [];

function LabeledKnob({
  label,
  value,
  onChange,
  bipolar = false,
  lfoKnob,
  midiTarget,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  bipolar?: boolean;
  // When set, the knob participates in the LFO routing system: clicks during
  // LFO-select toggle a destination assignment, and the visual swings with
  // any routed LFOs. Same pattern as MacroKnob.
  lfoKnob?: LFODestKnobGlobal;
  // When set, the knob is a MIDI learn target.
  midiTarget?: MidiTarget;
}) {
  // Knob component is unipolar 0..1; for bipolar params we map externally.
  const knobValue = bipolar ? (value + 1) / 2 : value;
  const handleKnobChange = (v: number) => onChange(bipolar ? v * 2 - 1 : v);

  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);
  const learn = useMidiLearn(midiTarget);

  // useRoutedLFOs returns a stable reference unless this knob's specific
  // routing changes, so unrelated LFO tweaks (depth, other destinations,
  // freeze) no longer re-render every knob in the panel.
  const routedForKnob = useRoutedLFOs(GLOBAL_TRACK_ID, lfoKnob ?? ('density' as LFODestKnobGlobal));
  const routed = lfoKnob ? routedForKnob : EMPTY_LFO_LIST;
  const displayValue = useLFOValue(knobValue, routed, 1);

  // Precedence: LFO-selecting mode > MIDI learn mode > normal drag.
  const onModulationClick =
    lfoKnob && selectingLFO !== null
      ? () => {
          toggleLFODestination(selectingLFO, { trackId: GLOBAL_TRACK_ID, knob: lfoKnob });
        }
      : learn.onLearnClick;

  const lfoLabels = routed.map((l) => `L${l.id + 1}`).join(',');
  const modulationLabel =
    selectingLFO !== null
      ? lfoLabels || undefined
      : learn.learning
        ? learn.isLearnTarget
          ? '?'
          : learn.bound
            ? learn.bindingLabel
            : undefined
        : routed.length > 0
          ? lfoLabels
          : undefined;

  const titleParts: string[] = [label];
  if (routed.length > 0) titleParts.push(lfoLabels);
  if (learn.learning && learn.bound && learn.bindingLabel)
    titleParts.push(learn.bindingLabel);
  if (learn.isLearnTarget) titleParts.push('learning…');

  return (
    <div className="flex flex-col items-center gap-1">
      <Knob
        size={KNOB_SIZE}
        value={knobValue}
        displayValue={displayValue}
        onChange={handleKnobChange}
        bipolar={bipolar}
        title={titleParts.join(' · ')}
        onModulationClick={onModulationClick}
        modulationLabel={modulationLabel}
      />
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">
        {label}
      </span>
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onToggle,
  midiTarget,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  midiTarget?: MidiTarget;
}) {
  const learn = useMidiLearn(midiTarget);
  const handleClick = () => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    onToggle();
  };
  const titleSuffix =
    learn.learning && learn.bindingLabel ? ` · ${learn.bindingLabel}` : '';
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={handleClick}
        aria-pressed={active}
        title={
          learn.isLearnTarget
            ? `${label} — learning…`
            : `${label}${titleSuffix}`
        }
        style={{ width: KNOB_SIZE, height: KNOB_SIZE }}
        className="relative flex items-center justify-center bg-transparent cursor-pointer group"
      >
        <span
          style={{ width: KNOB_SIZE * 0.36, height: KNOB_SIZE * 0.36 }}
          className={[
            'block rounded-full border transition-colors',
            active
              ? 'bg-white border-white'
              : 'border-white/30 group-hover:border-white',
          ].join(' ')}
        />
        {learn.learning && (learn.isLearnTarget || learn.bound) && (
          <span
            className="absolute inset-2 pointer-events-none border border-white/70 rounded"
            style={{
              boxShadow: learn.isLearnTarget ? '0 0 0 1px #fff inset' : undefined,
            }}
          />
        )}
      </button>
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">
        {label}
      </span>
    </div>
  );
}

function CycleButton({
  label,
  value,
  count,
  format,
  onChange,
  midiTarget,
}: {
  label: string;
  value: number;
  count: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  midiTarget?: MidiTarget;
}) {
  const learn = useMidiLearn(midiTarget);
  const display = format(value);
  const handleClick = () => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    onChange((value + 1) % count);
  };
  const titleSuffix =
    learn.learning && learn.bindingLabel ? ` · ${learn.bindingLabel}` : '';
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={handleClick}
        title={
          learn.isLearnTarget
            ? `${label} — learning…`
            : `${label}${titleSuffix}`
        }
        style={{ width: KNOB_SIZE, height: KNOB_SIZE }}
        className="relative flex items-center justify-center bg-transparent cursor-pointer group border border-white/30 hover:border-white rounded-full"
      >
        <span className="text-[10px] uppercase tracking-[0.1em] opacity-80">
          {display}
        </span>
        {learn.learning && (learn.isLearnTarget || learn.bound) && (
          <span
            className="absolute inset-1 pointer-events-none border border-white/70 rounded-full"
            style={{
              boxShadow: learn.isLearnTarget ? '0 0 0 1px #fff inset' : undefined,
            }}
          />
        )}
      </button>
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">
        {label}
      </span>
    </div>
  );
}

function StageDivider({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-2 self-stretch">
      <span className="text-[10px] uppercase tracking-[0.16em] opacity-40 [writing-mode:vertical-rl] rotate-180">
        {label}
      </span>
    </div>
  );
}

const MASTER_EXPANDED_KEY = 'sequencer.fxPanel.masterExpanded';

function TapeKnob<F extends NumericKeys<TapeParams>>({
  field,
  label,
  lfoKnob,
  midiTarget,
}: {
  field: F;
  label: string;
  lfoKnob?: LFODestKnobGlobal;
  midiTarget?: MidiTarget;
}) {
  const value = useSequencerStore((s) => s.tape[field] as number);
  const setTape = useSequencerStore((s) => s.setTape);
  const onChange = useCallback(
    (v: number) => setTape({ [field]: v } as Partial<TapeParams>),
    [setTape, field],
  );
  return (
    <LabeledKnob
      label={label}
      value={value}
      onChange={onChange}
      lfoKnob={lfoKnob}
      midiTarget={midiTarget}
    />
  );
}

function TapeToggle<F extends BooleanKeys<TapeParams>>({
  field,
  label,
  midiTarget,
}: {
  field: F;
  label: string;
  midiTarget?: MidiTarget;
}) {
  const active = useSequencerStore((s) => s.tape[field] as boolean);
  const setTape = useSequencerStore((s) => s.setTape);
  // Read fresh state from the store on click instead of capturing `active`,
  // so the toggle handler reference is stable across renders.
  const onToggle = useCallback(
    () => setTape({ [field]: !useSequencerStore.getState().tape[field] } as Partial<TapeParams>),
    [setTape, field],
  );
  return (
    <ToggleButton
      label={label}
      active={active}
      onToggle={onToggle}
      midiTarget={midiTarget}
    />
  );
}

function GlitchKnob<F extends NumericKeys<GlitchParams>>({
  field,
  label,
  lfoKnob,
  midiTarget,
}: {
  field: F;
  label: string;
  lfoKnob?: LFODestKnobGlobal;
  midiTarget?: MidiTarget;
}) {
  const value = useSequencerStore((s) => s.glitch[field] as number);
  const setGlitch = useSequencerStore((s) => s.setGlitch);
  const onChange = useCallback(
    (v: number) => setGlitch({ [field]: v } as Partial<GlitchParams>),
    [setGlitch, field],
  );
  return (
    <LabeledKnob
      label={label}
      value={value}
      onChange={onChange}
      lfoKnob={lfoKnob}
      midiTarget={midiTarget}
    />
  );
}

function ReverbKnob<F extends NumericKeys<ReverbParams>>({
  field,
  label,
  lfoKnob,
  midiTarget,
}: {
  field: F;
  label: string;
  lfoKnob?: LFODestKnobGlobal;
  midiTarget?: MidiTarget;
}) {
  const value = useSequencerStore((s) => s.reverb[field] as number);
  const setReverb = useSequencerStore((s) => s.setReverb);
  const onChange = useCallback(
    (v: number) => setReverb({ [field]: v } as Partial<ReverbParams>),
    [setReverb, field],
  );
  return (
    <LabeledKnob
      label={label}
      value={value}
      onChange={onChange}
      lfoKnob={lfoKnob}
      midiTarget={midiTarget}
    />
  );
}


function SaturationKnob<F extends NumericKeys<SaturationParams>>({
  field,
  label,
  lfoKnob,
  midiTarget,
}: {
  field: F;
  label: string;
  lfoKnob?: LFODestKnobGlobal;
  midiTarget?: MidiTarget;
}) {
  const value = useSequencerStore((s) => s.saturation[field] as number);
  const setSaturation = useSequencerStore((s) => s.setSaturation);
  const onChange = useCallback(
    (v: number) => setSaturation({ [field]: v } as Partial<SaturationParams>),
    [setSaturation, field],
  );
  return (
    <LabeledKnob
      label={label}
      value={value}
      onChange={onChange}
      lfoKnob={lfoKnob}
      midiTarget={midiTarget}
    />
  );
}

function MasterKnob<F extends NumericKeys<MasterParams>>({
  field,
  label,
  lfoKnob,
  midiTarget,
  scale = 1,
}: {
  field: F;
  label: string;
  lfoKnob?: LFODestKnobGlobal;
  midiTarget?: MidiTarget;
  // For fields whose store range differs from the 0..1 knob range (currently
  // just `bias`, stored 0..0.2). knob = store / scale; store = knob * scale.
  scale?: number;
}) {
  const raw = useSequencerStore((s) => s.master[field] as number);
  const setMaster = useSequencerStore((s) => s.setMaster);
  const value = scale === 1 ? raw : raw / scale;
  const onChange = useCallback(
    (v: number) =>
      setMaster({ [field]: (scale === 1 ? v : v * scale) } as Partial<MasterParams>),
    [setMaster, field, scale],
  );
  return (
    <LabeledKnob
      label={label}
      value={value}
      onChange={onChange}
      lfoKnob={lfoKnob}
      midiTarget={midiTarget}
    />
  );
}

function MasterCycle<F extends NumericKeys<MasterParams>>({
  field,
  label,
  count,
  format,
  midiTarget,
}: {
  field: F;
  label: string;
  count: number;
  format: (v: number) => string;
  midiTarget?: MidiTarget;
}) {
  const value = useSequencerStore((s) => s.master[field] as number);
  const setMaster = useSequencerStore((s) => s.setMaster);
  const onChange = useCallback(
    (v: number) => setMaster({ [field]: v } as Partial<MasterParams>),
    [setMaster, field],
  );
  return (
    <CycleButton
      label={label}
      value={value}
      count={count}
      format={format}
      onChange={onChange}
      midiTarget={midiTarget}
    />
  );
}

function MasterToggle<F extends BooleanKeys<MasterParams>>({
  field,
  label,
  midiTarget,
}: {
  field: F;
  label: string;
  midiTarget?: MidiTarget;
}) {
  const active = useSequencerStore((s) => s.master[field] as boolean);
  const setMaster = useSequencerStore((s) => s.setMaster);
  const onToggle = useCallback(
    () =>
      setMaster({
        [field]: !useSequencerStore.getState().master[field],
      } as Partial<MasterParams>),
    [setMaster, field],
  );
  return (
    <ToggleButton label={label} active={active} onToggle={onToggle} midiTarget={midiTarget} />
  );
}

function MasterPresetSelect() {
  // Selector returns the matched preset name (or null) — a primitive, so
  // it only re-renders when active preset identity changes, not on every
  // master-knob mousemove. findActivePreset is O(presets × fields), tiny.
  const activePreset = useSequencerStore((s) => findActivePreset(s.master));
  const setMasterPreset = useSequencerStore((s) => s.setMasterPreset);
  return (
    <select
      value={activePreset ?? ''}
      onChange={(e) => {
        const name = e.target.value;
        if (name) setMasterPreset(name);
      }}
      className="select-chevron bg-transparent border border-white/15 pl-2 py-1 focus:outline-none focus:border-white text-white"
      title="Load a master-section preset"
    >
      {activePreset === null && (
        <option value="" disabled className="bg-[#050505]">
          modified
        </option>
      )}
      {MASTER_PRESET_NAMES.map((name) => (
        <option key={name} value={name} className="bg-[#050505]">
          {name}
        </option>
      ))}
    </select>
  );
}

export function FXPanel() {
  // Master controls are hidden by default — the section is 14+ knobs and
  // overwhelms the upstream-FX row otherwise. Audio routing is unaffected
  // by the toggle; only the UI is collapsed.
  const [masterExpanded, setMasterExpanded] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(MASTER_EXPANDED_KEY) === 'true';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(MASTER_EXPANDED_KEY, String(masterExpanded));
  }, [masterExpanded]);

  return (
    <div className="flex flex-col items-stretch gap-6 px-4 py-4">
      <div className="flex flex-wrap items-start justify-end gap-5">
      <StageDivider label="pre" />
      <SaturationKnob
        field="preDrive"
        label="drive"
        lfoKnob="preSaturationDrive"
        midiTarget="fx:saturation.preDrive"
      />
      <StageDivider label="tape" />
      <TapeKnob
        field="position"
        label="position"
        lfoKnob="tapePosition"
        midiTarget="fx:tape.position"
      />
      <TapeKnob
        field="length"
        label="length"
        lfoKnob="tapeLength"
        midiTarget="fx:tape.length"
      />
      <TapeToggle field="reverse" label="reverse" />
      <TapeToggle field="hold" label="hold" midiTarget="fx:tape.hold" />
      <TapeKnob
        field="grainRate"
        label="grain rate"
        lfoKnob="tapeGrainRate"
        midiTarget="fx:tape.grainRate"
      />
      <TapeKnob
        field="grainMix"
        label="grain mix"
        lfoKnob="tapeGrainMix"
        midiTarget="fx:tape.grainMix"
      />
      <TapeKnob
        field="mix"
        label="mix"
        lfoKnob="tapeMix"
        midiTarget="fx:tape.mix"
      />
      <StageDivider label="glitch" />
      <GlitchKnob
        field="chance"
        label="chance"
        lfoKnob="glitchChance"
        midiTarget="fx:glitch.chance"
      />
      <GlitchKnob
        field="mix"
        label="mix"
        lfoKnob="glitchMix"
        midiTarget="fx:glitch.mix"
      />
      <StageDivider label="reverb" />
      <ReverbKnob
        field="size"
        label="size"
        lfoKnob="reverbSize"
        midiTarget="fx:reverb.size"
      />
      <ReverbKnob
        field="mix"
        label="mix"
        lfoKnob="reverbMix"
        midiTarget="fx:reverb.mix"
      />
      <ReverbKnob
        field="diffusion"
        label="diff"
        lfoKnob="reverbDiffusion"
        midiTarget="fx:reverb.diffusion"
      />
      <ReverbKnob
        field="damping"
        label="damp"
        lfoKnob="reverbDamping"
        midiTarget="fx:reverb.damping"
      />
        <div className="flex flex-col items-stretch gap-2 self-center text-xs uppercase tracking-widest opacity-70">
          <MasterPresetSelect />
          <button
            onClick={() => setMasterExpanded(!masterExpanded)}
            title={masterExpanded ? 'Hide master output' : 'Show master output'}
            className="opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
          >
            master {masterExpanded ? '▴' : '▾'}
          </button>
        </div>
      </div>
      {masterExpanded && (
      <div className="flex flex-wrap items-start justify-end gap-5">
      <StageDivider label="master" />
      <MasterKnob
        field="input"
        label="input"
        lfoKnob="masterInput"
        midiTarget="fx:master.input"
      />
      <MasterCycle
        field="loCut"
        label="lo-cut"
        count={LO_CUT_POSITIONS}
        format={loCutLabel}
        midiTarget="fx:master.loCut"
      />
      <MasterKnob
        field="comp"
        label="comp"
        lfoKnob="masterComp"
        midiTarget="fx:master.comp"
      />
      <MasterCycle
        field="compAttack"
        label="atk"
        count={COMP_ATTACK_COUNT}
        format={compAttackLabel}
        midiTarget="fx:master.compAttack"
      />
      <MasterCycle
        field="compRelease"
        label="rel"
        count={COMP_RELEASE_COUNT}
        format={compReleaseLabel}
        midiTarget="fx:master.compRelease"
      />
      <MasterCycle
        field="mode"
        label="mode"
        count={MODE_COUNT}
        format={modeLabel}
        midiTarget="fx:master.mode"
      />
      <MasterKnob
        field="drive"
        label="drive"
        lfoKnob="masterDrive"
        midiTarget="fx:master.drive"
      />
      <MasterKnob
        field="bias"
        label="bias"
        lfoKnob="masterBias"
        midiTarget="fx:master.bias"
        scale={0.2}
      />
      <MasterKnob
        field="mix"
        label="mix"
        lfoKnob="masterMix"
        midiTarget="fx:master.mix"
      />
      <MasterKnob
        field="hiCut"
        label="hi-cut"
        lfoKnob="masterHiCut"
        midiTarget="fx:master.hiCut"
      />
      <MasterKnob
        field="trim"
        label="trim"
        lfoKnob="masterTrim"
        midiTarget="fx:master.trim"
      />
      <MasterToggle
        field="gateEnabled"
        label="gate"
        midiTarget="fx:master.gateEnabled"
      />
      <MasterKnob
        field="gateThreshold"
        label="gate thr"
        lfoKnob="masterGateThreshold"
        midiTarget="fx:master.gateThreshold"
      />
      <MasterToggle field="bypass" label="bypass" midiTarget="fx:master.bypass" />
      </div>
      )}
    </div>
  );
}
