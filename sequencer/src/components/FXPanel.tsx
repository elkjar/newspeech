import { useEffect, useState } from 'react';
import { useSequencerStore } from '../state/store';
import { Knob } from './Knob';
import { findRouted, GLOBAL_TRACK_ID, type LFODestKnobGlobal } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget } from '../midi/midiMap';
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
} from '../audio/master';

const KNOB_SIZE = 44;

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

  const lfos = useSequencerStore((s) => s.lfos);
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);
  const learn = useMidiLearn(midiTarget);

  const routed = lfoKnob ? findRouted(lfos, GLOBAL_TRACK_ID, lfoKnob) : [];
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

export function FXPanel() {
  const tape = useSequencerStore((s) => s.tape);
  const setTape = useSequencerStore((s) => s.setTape);
  const glitch = useSequencerStore((s) => s.glitch);
  const setGlitch = useSequencerStore((s) => s.setGlitch);
  const reverb = useSequencerStore((s) => s.reverb);
  const setReverb = useSequencerStore((s) => s.setReverb);
  const saturation = useSequencerStore((s) => s.saturation);
  const setSaturation = useSequencerStore((s) => s.setSaturation);
  const master = useSequencerStore((s) => s.master);
  const setMaster = useSequencerStore((s) => s.setMaster);
  const setMasterPreset = useSequencerStore((s) => s.setMasterPreset);

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
      <LabeledKnob
        label="drive"
        value={saturation.preDrive}
        onChange={(v) => setSaturation({ preDrive: v })}
        lfoKnob="preSaturationDrive"
        midiTarget="fx:saturation.preDrive"
      />
      <StageDivider label="tape" />
      <LabeledKnob
        label="position"
        value={tape.position}
        onChange={(v) => setTape({ position: v })}
        lfoKnob="tapePosition"
        midiTarget="fx:tape.position"
      />
      <LabeledKnob
        label="length"
        value={tape.length}
        onChange={(v) => setTape({ length: v })}
        lfoKnob="tapeLength"
        midiTarget="fx:tape.length"
      />
      <ToggleButton
        label="reverse"
        active={tape.reverse}
        onToggle={() => setTape({ reverse: !tape.reverse })}
      />
      <ToggleButton
        label="hold"
        active={tape.hold}
        onToggle={() => setTape({ hold: !tape.hold })}
        midiTarget="fx:tape.hold"
      />
      <LabeledKnob
        label="grain rate"
        value={tape.grainRate}
        onChange={(v) => setTape({ grainRate: v })}
        lfoKnob="tapeGrainRate"
        midiTarget="fx:tape.grainRate"
      />
      <LabeledKnob
        label="grain mix"
        value={tape.grainMix}
        onChange={(v) => setTape({ grainMix: v })}
        lfoKnob="tapeGrainMix"
        midiTarget="fx:tape.grainMix"
      />
      <LabeledKnob
        label="mix"
        value={tape.mix}
        onChange={(v) => setTape({ mix: v })}
        lfoKnob="tapeMix"
        midiTarget="fx:tape.mix"
      />
      <StageDivider label="glitch" />
      <LabeledKnob
        label="chance"
        value={glitch.chance}
        onChange={(v) => setGlitch({ chance: v })}
        lfoKnob="glitchChance"
        midiTarget="fx:glitch.chance"
      />
      <LabeledKnob
        label="mix"
        value={glitch.mix}
        onChange={(v) => setGlitch({ mix: v })}
        lfoKnob="glitchMix"
        midiTarget="fx:glitch.mix"
      />
      <StageDivider label="reverb" />
      <LabeledKnob
        label="size"
        value={reverb.size}
        onChange={(v) => setReverb({ size: v })}
        lfoKnob="reverbSize"
        midiTarget="fx:reverb.size"
      />
      <LabeledKnob
        label="mix"
        value={reverb.mix}
        onChange={(v) => setReverb({ mix: v })}
        lfoKnob="reverbMix"
        midiTarget="fx:reverb.mix"
      />
        <div className="flex flex-col items-stretch gap-2 self-center text-xs uppercase tracking-widest opacity-70">
          <select
            value={findActivePreset(master) ?? ''}
            onChange={(e) => {
              const name = e.target.value;
              if (name) setMasterPreset(name);
            }}
            className="select-chevron bg-transparent border border-white/15 pl-2 py-1 focus:outline-none focus:border-white text-white"
            title="Load a master-section preset"
          >
            {findActivePreset(master) === null && (
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
      <LabeledKnob
        label="input"
        value={master.input}
        onChange={(v) => setMaster({ input: v })}
        lfoKnob="masterInput"
        midiTarget="fx:master.input"
      />
      <CycleButton
        label="lo-cut"
        value={master.loCut}
        count={LO_CUT_POSITIONS}
        format={loCutLabel}
        onChange={(v) => setMaster({ loCut: v })}
        midiTarget="fx:master.loCut"
      />
      <LabeledKnob
        label="comp"
        value={master.comp}
        onChange={(v) => setMaster({ comp: v })}
        lfoKnob="masterComp"
        midiTarget="fx:master.comp"
      />
      <CycleButton
        label="atk"
        value={master.compAttack}
        count={COMP_ATTACK_COUNT}
        format={compAttackLabel}
        onChange={(v) => setMaster({ compAttack: v })}
        midiTarget="fx:master.compAttack"
      />
      <CycleButton
        label="rel"
        value={master.compRelease}
        count={COMP_RELEASE_COUNT}
        format={compReleaseLabel}
        onChange={(v) => setMaster({ compRelease: v })}
        midiTarget="fx:master.compRelease"
      />
      <CycleButton
        label="mode"
        value={master.mode}
        count={MODE_COUNT}
        format={modeLabel}
        onChange={(v) => setMaster({ mode: v })}
        midiTarget="fx:master.mode"
      />
      <LabeledKnob
        label="drive"
        value={master.drive}
        onChange={(v) => setMaster({ drive: v })}
        lfoKnob="masterDrive"
        midiTarget="fx:master.drive"
      />
      <LabeledKnob
        label="bias"
        value={master.bias / 0.2}
        onChange={(v) => setMaster({ bias: v * 0.2 })}
        lfoKnob="masterBias"
        midiTarget="fx:master.bias"
      />
      <LabeledKnob
        label="mix"
        value={master.mix}
        onChange={(v) => setMaster({ mix: v })}
        lfoKnob="masterMix"
        midiTarget="fx:master.mix"
      />
      <LabeledKnob
        label="hi-cut"
        value={master.hiCut}
        onChange={(v) => setMaster({ hiCut: v })}
        lfoKnob="masterHiCut"
        midiTarget="fx:master.hiCut"
      />
      <LabeledKnob
        label="trim"
        value={master.trim}
        onChange={(v) => setMaster({ trim: v })}
        lfoKnob="masterTrim"
        midiTarget="fx:master.trim"
      />
      <ToggleButton
        label="gate"
        active={master.gateEnabled}
        onToggle={() => setMaster({ gateEnabled: !master.gateEnabled })}
        midiTarget="fx:master.gateEnabled"
      />
      <LabeledKnob
        label="gate thr"
        value={master.gateThreshold}
        onChange={(v) => setMaster({ gateThreshold: v })}
        lfoKnob="masterGateThreshold"
        midiTarget="fx:master.gateThreshold"
      />
      <ToggleButton
        label="bypass"
        active={master.bypass}
        onToggle={() => setMaster({ bypass: !master.bypass })}
        midiTarget="fx:master.bypass"
      />
      </div>
      )}
    </div>
  );
}
