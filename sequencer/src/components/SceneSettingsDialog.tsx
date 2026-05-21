import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  useSequencerStore,
  BANK_SLOT_COUNT,
  SCENE_SHAPES,
  type SceneShape,
} from '../state/store';
import { sampleShape } from '../ghost/shape';

// Centered modal scene config — owns all per-scene ghost behavior knobs
// that don't belong on the always-visible top bar. The top bar (GhostDebug)
// stays read-only; this dialog is where you author scene-level intent.
//
// Sections:
//   - shape (entropy curve type: sustain / build / arc / wave / decay)
//   - scene length (phaseLength in bars — drives shape phase + auto-advance)
//   - bank order mode (entropy: shape curve picks; sequence: slot order walk)
//   - per-bank dwell overrides (lock specific banks to specific bar counts)

type SceneSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
};

// Small inline curve preview used by the shape dropdown options.
function ShapePreviewSVG({
  shape,
  size = 36,
}: {
  shape: SceneShape;
  size?: number;
}) {
  const W = size;
  const H = 12;
  const samples = sampleShape(shape, 0, 1, 24);
  const points = samples
    .map((v, i) => {
      const x = (i / (samples.length - 1)) * (W - 2) + 1;
      const y = H - 1 - v * (H - 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg width={W} height={H} className="opacity-70 shrink-0">
      <polyline
        points={points}
        fill="none"
        stroke="white"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function SceneSettingsDialog({ open, onClose }: SceneSettingsDialogProps) {
  const sceneGraph = useSequencerStore((s) => s.sceneGraph);
  const banks = useSequencerStore((s) => s.banks);
  const setSceneGraphShape = useSequencerStore((s) => s.setSceneGraphShape);
  const setSceneGraphPhaseLength = useSequencerStore(
    (s) => s.setSceneGraphPhaseLength,
  );
  const setSceneGraphBankOrderMode = useSequencerStore(
    (s) => s.setSceneGraphBankOrderMode,
  );
  const setBankDwell = useSequencerStore((s) => s.setBankDwell);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  // All 16 slots regardless of fill/kind — granular control per-slot.
  // Empty slots show a disabled input (no slot to write to).
  const slots = Array.from({ length: BANK_SLOT_COUNT }, (_, i) => ({
    slot: i,
    bank: banks[i],
  }));

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[520px] max-h-[80vh] overflow-auto p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs uppercase tracking-widest"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white text-sm mb-5">scene settings</div>

        {/* SHAPE */}
        <div className="mb-5">
          <div className="text-white/55 mb-2 text-[10px]">shape</div>
          <div className="flex items-center gap-3">
            <select
              value={sceneGraph.shape}
              onChange={(e) => setSceneGraphShape(e.target.value as SceneShape)}
              className="select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white h-[28px]"
            >
              {SCENE_SHAPES.map((s) => (
                <option key={s} value={s} className="bg-[#050505]">
                  {s}
                </option>
              ))}
            </select>
            <ShapePreviewSVG shape={sceneGraph.shape} size={48} />
            <span className="text-white/40 text-[10px] normal-case tracking-normal">
              {sceneGraph.shape === 'sustain'
                ? 'no curve — banks chosen by zig-zag from current entropy'
                : sceneGraph.shape === 'build'
                  ? 'low → high entropy, holds at peak'
                  : sceneGraph.shape === 'arc'
                    ? 'low → high → low (one full arc per scene)'
                    : sceneGraph.shape === 'wave'
                      ? 'sinusoidal oscillation, repeats every phaseLength'
                      : 'high → low entropy, holds at floor'}
            </span>
          </div>
        </div>

        {/* SCENE LENGTH */}
        <div className="mb-5">
          <div className="text-white/55 mb-2 text-[10px]">scene length</div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              max={1024}
              value={sceneGraph.phaseLength}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setSceneGraphPhaseLength(n);
              }}
              className="w-20 bg-transparent border border-white/15 px-2 text-[11px] uppercase tracking-widest text-white tabular-nums focus:outline-none focus:border-white h-[28px]"
            />
            <button
              type="button"
              onClick={() => {
                const total = banks.reduce(
                  (acc, b) => acc + (b?.dwellBars ?? 0),
                  0,
                );
                if (total >= 1) setSceneGraphPhaseLength(total);
              }}
              title="set scene length = sum of per-bank dwell overrides"
              className="px-2 text-[10px] uppercase tracking-widest border border-white/15 text-white/70 hover:text-white hover:border-white transition-colors h-[28px]"
            >
              calc
            </button>
            <span className="text-white/55 text-[10px] normal-case tracking-normal">
              bars — drives shape phase + scene auto-advance trigger
            </span>
          </div>
        </div>

        {/* BANK ORDER MODE */}
        <div className="mb-5">
          <div className="text-white/55 mb-2 text-[10px]">bank order</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSceneGraphBankOrderMode('entropy')}
              className={[
                'px-3 py-1 text-[11px] uppercase tracking-widest border transition-colors',
                sceneGraph.bankOrderMode === 'entropy'
                  ? 'border-white text-white bg-white/10'
                  : 'border-white/15 text-white/55 hover:text-white hover:border-white',
              ].join(' ')}
            >
              entropy
            </button>
            <button
              type="button"
              onClick={() => setSceneGraphBankOrderMode('sequence')}
              className={[
                'px-3 py-1 text-[11px] uppercase tracking-widest border transition-colors',
                sceneGraph.bankOrderMode === 'sequence'
                  ? 'border-white text-white bg-white/10'
                  : 'border-white/15 text-white/55 hover:text-white hover:border-white',
              ].join(' ')}
            >
              sequence
            </button>
            <span className="text-white/40 text-[10px] normal-case tracking-normal ml-2">
              {sceneGraph.bankOrderMode === 'sequence'
                ? 'walk banks in slot order, wrap at end'
                : 'pick via shape curve + entropy delta + slot bias'}
            </span>
          </div>
        </div>

        {/* PER-BANK DWELL OVERRIDES */}
        <div>
          <div className="text-white/55 mb-2 text-[10px]">
            per-bank dwell overrides
          </div>
          <div
            className="grid grid-cols-2 gap-x-6 gap-y-1"
            style={{ gridAutoFlow: 'column', gridTemplateRows: 'repeat(8, auto)' }}
          >
            {slots.map(({ slot, bank }) => {
              const filled = !!bank;
              return (
                <div
                  key={slot}
                  className="flex items-center gap-2 text-[10px] uppercase tracking-widest"
                >
                  <span
                    className={[
                      'w-6 tabular-nums',
                      filled ? 'text-white/70' : 'text-white/25',
                    ].join(' ')}
                  >
                    {(slot + 1).toString().padStart(2, '0')}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={1024}
                    placeholder={filled ? 'auto' : '—'}
                    disabled={!filled}
                    value={bank?.dwellBars ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === '') {
                        setBankDwell(slot, null);
                        return;
                      }
                      const n = Number(raw);
                      if (Number.isFinite(n)) setBankDwell(slot, n);
                    }}
                    className={[
                      'w-16 bg-transparent border px-2 text-[10px] uppercase tracking-widest tabular-nums focus:outline-none h-[22px]',
                      filled
                        ? 'border-white/15 text-white focus:border-white'
                        : 'border-white/5 text-white/25 cursor-not-allowed',
                    ].join(' ')}
                  />
                  <span
                    className={[
                      'text-[10px] normal-case tracking-normal',
                      filled ? 'text-white/40' : 'text-white/15',
                    ].join(' ')}
                  >
                    bars
                  </span>
                </div>
              );
            })}
          </div>
          <div className="text-white/30 text-[10px] normal-case tracking-normal mt-3 leading-relaxed">
            blank = automatic (scene length ÷ filled bank count, ±15% jitter).
            number = pin this bank to exactly that many bars when ghost picks it.
            empty slots are disabled until you author them.
          </div>
        </div>

        <div className="flex items-center justify-end mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white text-white hover:bg-white/10 transition-colors"
          >
            close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
