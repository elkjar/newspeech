import { useEffect } from 'react';
import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';

export function TrackGrid() {
  const steps = useSequencerStore((s) => s.steps);
  const currentStep = useSequencerStore((s) => s.currentStep);
  const playing = useSequencerStore((s) => s.playing);
  const toggleStep = useSequencerStore((s) => s.toggleStep);
  const setCurrentStep = useSequencerStore((s) => s.setCurrentStep);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (scheduler.isPlaying()) {
        const audible = scheduler.getAudibleStep();
        if (audible !== null) setCurrentStep(audible);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentStep]);

  return (
    <div className="flex items-center gap-4">
      <span className="w-16 text-xs uppercase tracking-widest opacity-60">kick</span>
      <div className="grid grid-cols-16 gap-1.5">
        {steps.map((step, i) => {
          const isCurrent = playing && currentStep === i;
          const isBeat = i % 4 === 0;
          return (
            <button
              key={i}
              onClick={() => toggleStep(i)}
              aria-label={`step ${i + 1}`}
              className={[
                'aspect-square w-12 transition-colors',
                step.on ? 'bg-bone hover:bg-bone/80' : 'bg-bone/5 hover:bg-bone/15',
                isCurrent ? 'ring-2 ring-bone ring-offset-2 ring-offset-ink' : '',
                isBeat ? 'border-l-2 border-bone/40' : '',
              ].join(' ')}
            />
          );
        })}
      </div>
    </div>
  );
}
