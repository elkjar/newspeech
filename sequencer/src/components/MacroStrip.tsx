import { useSequencerStore } from '../state/store';
import { MacroKnob } from './MacroKnob';
import { useMidiLearn } from '../hooks/useMidiLearn';

const MACRO_SIZE = 56;

function FreezeButton() {
  const freeze = useSequencerStore((s) => s.freeze);
  const toggleFreeze = useSequencerStore((s) => s.toggleFreeze);
  const learn = useMidiLearn('transport:freeze');
  const dotSize = MACRO_SIZE * 0.36;
  const handleClick = () => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    toggleFreeze();
  };
  const titleSuffix =
    learn.learning && learn.bindingLabel ? ` · ${learn.bindingLabel}` : '';
  return (
    <button
      onClick={handleClick}
      aria-pressed={freeze}
      aria-label="freeze"
      title={
        learn.isLearnTarget
          ? 'freeze — learning…'
          : `${freeze ? 'freeze · held' : 'freeze · live'}${titleSuffix}`
      }
      style={{ width: MACRO_SIZE, height: MACRO_SIZE }}
      className="relative flex items-center justify-center bg-transparent cursor-pointer group"
    >
      <span
        style={{ width: dotSize, height: dotSize }}
        className={[
          'block rounded-full border transition-colors',
          freeze
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
  );
}

function DwellReadout() {
  const enabled = useSequencerStore((s) => s.sceneGraph.enabled);
  const playing = useSequencerStore((s) => s.playing);
  const remaining = useSequencerStore((s) => s.conductorBarsRemaining);
  const target = useSequencerStore((s) => s.conductorTargetBars);
  if (!enabled) return null;
  // Pre-play OR pre-first-tick state: no dwell rolled yet, show em-dash so
  // the user sees the conductor is enabled but waiting for transport.
  const text =
    target <= 0
      ? '—'
      : !playing
        ? `${target}b`
        : remaining > 0
          ? `${remaining}b`
          : '…';
  return (
    <span
      className="absolute -bottom-3 left-1/2 -translate-x-1/2 text-[9px] tracking-widest opacity-55 tabular-nums pointer-events-none"
      style={{ whiteSpace: 'nowrap' }}
    >
      {text}
    </span>
  );
}

function AutoButton() {
  const enabled = useSequencerStore((s) => s.sceneGraph.enabled);
  const setSceneGraphEnabled = useSequencerStore((s) => s.setSceneGraphEnabled);
  const learn = useMidiLearn('transport:conductor');
  const dotSize = MACRO_SIZE * 0.36;
  const handleClick = () => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    setSceneGraphEnabled(!enabled);
  };
  const titleSuffix =
    learn.learning && learn.bindingLabel ? ` · ${learn.bindingLabel}` : '';
  return (
    <button
      onClick={handleClick}
      aria-pressed={enabled}
      aria-label="auto"
      title={
        learn.isLearnTarget
          ? 'auto — learning…'
          : `${enabled ? 'auto · conductor walking' : 'auto · manual'}${titleSuffix}`
      }
      style={{ width: MACRO_SIZE, height: MACRO_SIZE }}
      className="relative flex items-center justify-center bg-transparent cursor-pointer group"
    >
      <span
        style={{ width: dotSize, height: dotSize }}
        className={[
          'block rounded-full border transition-colors',
          enabled
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
      <DwellReadout />
    </button>
  );
}

export function MacroStrip() {
  const density = useSequencerStore((s) => s.density);
  const motion = useSequencerStore((s) => s.motion);
  const drift = useSequencerStore((s) => s.drift);
  const chaos = useSequencerStore((s) => s.chaos);
  const tension = useSequencerStore((s) => s.tension);
  const setDensity = useSequencerStore((s) => s.setDensity);
  const setMotion = useSequencerStore((s) => s.setMotion);
  const setDrift = useSequencerStore((s) => s.setDrift);
  const setChaos = useSequencerStore((s) => s.setChaos);
  const setTension = useSequencerStore((s) => s.setTension);

  return (
    <div className="flex items-center gap-6">
      <FreezeButton />
      <AutoButton />
      <MacroKnob
        knob="density"
        value={density}
        onChange={setDensity}
        size={MACRO_SIZE}
        label="density"
        bipolar
        learnTarget="macro:density"
      />
      <span className="w-px self-stretch bg-white/15" />
      <div className="flex items-center gap-3">
        <MacroKnob
          knob="motion"
          value={motion}
          onChange={setMotion}
          size={MACRO_SIZE}
          label="motion"
          bipolar
          learnTarget="macro:motion"
        />
        <MacroKnob
          knob="drift"
          value={drift}
          onChange={setDrift}
          size={MACRO_SIZE}
          label="drift"
          learnTarget="macro:drift"
        />
      </div>
      <span className="w-px self-stretch bg-white/15" />
      <div className="flex items-center gap-3">
        <MacroKnob
          knob="chaos"
          value={chaos}
          onChange={setChaos}
          size={MACRO_SIZE}
          label="chaos"
          learnTarget="macro:chaos"
        />
        <MacroKnob
          knob="tension"
          value={tension}
          onChange={setTension}
          size={MACRO_SIZE}
          label="tension"
          learnTarget="macro:tension"
        />
      </div>
    </div>
  );
}
