import { useSequencerStore } from '../state/store';
import { Knob } from './Knob';

const MACRO_SIZE = 56;

export function MacroStrip() {
  const density = useSequencerStore((s) => s.density);
  const motion = useSequencerStore((s) => s.motion);
  const chaos = useSequencerStore((s) => s.chaos);
  const tension = useSequencerStore((s) => s.tension);
  const setDensity = useSequencerStore((s) => s.setDensity);
  const setMotion = useSequencerStore((s) => s.setMotion);
  const setChaos = useSequencerStore((s) => s.setChaos);
  const setTension = useSequencerStore((s) => s.setTension);

  return (
    <div className="flex items-center gap-6">
      <div className="flex items-center gap-3">
        <Knob
          value={density}
          onChange={setDensity}
          size={MACRO_SIZE}
          title={`density ${Math.round(density * 100)}%`}
        />
        <Knob
          value={motion}
          onChange={setMotion}
          size={MACRO_SIZE}
          title={`motion ${Math.round(motion * 100)}%`}
        />
      </div>
      <span className="w-px self-stretch bg-white/15" />
      <div className="flex items-center gap-3">
        <Knob
          value={chaos}
          onChange={setChaos}
          size={MACRO_SIZE}
          title={`chaos ${Math.round(chaos * 100)}%`}
        />
        <Knob
          value={tension}
          onChange={setTension}
          size={MACRO_SIZE}
          title={`tension ${Math.round(tension * 100)}%`}
        />
      </div>
    </div>
  );
}
