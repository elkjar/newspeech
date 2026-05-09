import { useSequencerStore } from '../state/store';
import { MacroKnob } from './MacroKnob';

const MACRO_SIZE = 56;

function FreezeButton() {
  const freeze = useSequencerStore((s) => s.freeze);
  const toggleFreeze = useSequencerStore((s) => s.toggleFreeze);
  const dotSize = MACRO_SIZE * 0.36;
  return (
    <button
      onClick={toggleFreeze}
      aria-pressed={freeze}
      aria-label="freeze"
      title={freeze ? 'freeze · held' : 'freeze · live'}
      style={{ width: MACRO_SIZE, height: MACRO_SIZE }}
      className="flex items-center justify-center bg-transparent cursor-pointer group"
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
      <MacroKnob
        knob="density"
        value={density}
        onChange={setDensity}
        size={MACRO_SIZE}
        label="density"
        bipolar
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
        />
        <MacroKnob
          knob="drift"
          value={drift}
          onChange={setDrift}
          size={MACRO_SIZE}
          label="drift"
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
        />
        <MacroKnob
          knob="tension"
          value={tension}
          onChange={setTension}
          size={MACRO_SIZE}
          label="tension"
        />
      </div>
    </div>
  );
}
