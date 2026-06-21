import { useEffect } from 'react';
import { useSequencerStore, type ScreenMode } from '../state/store';
import { LFOPanel } from './LFOPanel';
import { FXPanel } from './FXPanel';
import { StepInspector } from './StepInspector';
import { PianoRoll } from './PianoRoll';
import { InstrumentEditor } from './InstrumentEditor';

// The top multi-mode "screen" — ROLL / LFO / FX / MASTER / PARAMS / AUTOMATION.
// The mode tabs (`ScreenModeTabs`) live in the app title row beside the logo;
// `ChannelScreen` is just the body. PARAMS + AUTOMATION are the focused voice's
// instrument editor (the two halves of the old modal). UI-only — no Launchpad /
// hardware wiring.

const MODES: { id: ScreenMode; label: string }[] = [
  { id: 'params', label: 'params' },
  { id: 'automation', label: 'automation' },
  { id: 'roll', label: 'roll' },
  { id: 'lfo', label: 'lfo' },
  { id: 'fx', label: 'fx' },
  { id: 'master', label: 'master' },
];

// Mode tabs + backtick cycle. Rendered on the title line, not above the screen,
// so they don't take their own row.
export function ScreenModeTabs() {
  const screenMode = useSequencerStore((s) => s.screenMode);
  const setScreenMode = useSequencerStore((s) => s.setScreenMode);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '`') return;
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      const { screenMode: cur, setScreenMode: set } = useSequencerStore.getState();
      const i = MODES.findIndex((m) => m.id === cur);
      set(MODES[(i + 1) % MODES.length].id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex gap-1.5 text-[10px] uppercase tracking-widest">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => setScreenMode(m.id)}
          className={[
            'px-2.5 py-1 border transition-colors',
            screenMode === m.id
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function ChannelScreen() {
  const screenMode = useSequencerStore((s) => s.screenMode);

  return (
      // w-0 min-w-full (not w-full): preferred width 0 so the box never feeds
      // its content's max-content up to the shrink-to-fit app wrapper — WebKit
      // otherwise leaks a wide child (e.g. the automation tab's 5-column grid)
      // through the percentage width and grows the whole window. min-w-full
      // fills the available width at layout; overflow-auto scrolls internally.
      <div className="border border-white/15 w-0 min-w-full h-[280px] overflow-auto">
        {screenMode === 'roll' && (
          <div className="h-full flex items-start gap-3 p-3">
            <div className="flex-1 self-stretch border border-white/10">
              <PianoRoll />
            </div>
            <StepInspector />
          </div>
        )}
        {screenMode === 'lfo' && (
          <div className="h-full p-2">
            <LFOPanel />
          </div>
        )}
        {screenMode === 'fx' && (
          <div className="h-full flex items-center justify-center">
            <FXPanel section="fx" />
          </div>
        )}
        {screenMode === 'master' && (
          <div className="h-full flex items-center justify-center">
            <FXPanel section="master" />
          </div>
        )}
        {/* PARAMS + AUTOMATION share one mounted editor (so a held preview
            survives switching between the two halves); the `view` prop selects
            which half renders. */}
        {(screenMode === 'params' || screenMode === 'automation') && (
          <InstrumentEditor view={screenMode} />
        )}
      </div>
  );
}
