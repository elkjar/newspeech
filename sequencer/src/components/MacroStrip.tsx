import { useSequencerStore } from '../state/store';
import { MacroKnob } from './MacroKnob';

const MACRO_SIZE = 56;

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
      <MacroKnob
        knob="density"
        value={density}
        onChange={setDensity}
        size={MACRO_SIZE}
        label="density"
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
