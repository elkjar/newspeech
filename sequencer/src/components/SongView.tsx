import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useSequencerStore,
  COMPOSITION_SLOT_COUNT,
  BANK_SLOT_COUNT,
  type ArrangementRow,
  type Track,
} from '../state/store';
import { sourceLabel } from '../instruments/library';

// Song mode — an authored linear arrangement that overrides the autonomous
// scene/bank advancement. Each row addresses a fully-qualified pattern as
// scene-letter + bank-number ("B3"), holds for `bars`, and carries a
// non-destructive per-track mute overlay. See [[project_song_mode]].

const sceneLetter = (i: number) => String.fromCharCode(65 + i); // 0 → A

function MuteGrid({
  rowIdx,
  scene,
  bank,
  mutes,
}: {
  rowIdx: number;
  scene: number;
  bank: number;
  mutes: string[];
}) {
  // Select the stable tracks reference directly and map in the render body —
  // mapping inside the selector returns fresh objects every call, which
  // defeats useShallow (Object.is on new objects always fails) and spins an
  // infinite render loop. Identity is stable until tracks actually change.
  const tracks = useSequencerStore((s) => s.tracks);
  const banks = useSequencerStore((s) => s.banks);
  const activeBank = useSequencerStore((s) => s.activeBank);
  const activeScene = useSequencerStore((s) => s.composition.activeScene);
  const scenes = useSequencerStore((s) => s.composition.scenes);
  const toggle = useSequencerStore((s) => s.toggleArrangementRowMute);

  // Resolve the track list whose step content this row addresses, so an empty
  // channel (no active steps in that pattern) reads differently from a muted-
  // but-populated one. A saved scene snapshot carries its own bank palette;
  // otherwise (active scene, or no composition loaded — activeScene is null
  // when working straight off banks) read the live banks palette, with the
  // active bank authored live in `tracks`.
  const savedScene = scene !== activeScene ? scenes[scene] : null;
  const sourceTracks = savedScene
    ? savedScene.banks[bank]?.tracks ?? null
    : bank === activeBank
      ? tracks
      : banks[bank]?.tracks ?? null;
  const hasContent = (id: string) => {
    const t = sourceTracks?.find((x) => x.id === id);
    // No matching populated track (unauthored bank, or id absent from this
    // band) → empty. Mirrors the sequencer's authored-on check (slice to length).
    return !!t && t.steps.slice(0, t.length).some((s) => s.on);
  };

  const drums = tracks.filter((t) => t.section === 'drum');
  const melodic = tracks.filter((t) => t.section === 'melodic');
  const cell = (t: Track) => {
    // Three states, borderless — same white-on-dark fill vocabulary as the
    // step grid (bg-white/5 = off, bg-white = on). Empty wins: a silent
    // channel has nothing to mute.
    const empty = !hasContent(t.id);
    const muted = mutes.includes(t.id);
    // Hover shows the instrument name, not the opaque track id (t11); fall
    // back to the id only when the channel has no assigned voice.
    const name = sourceLabel(t.source);
    const label = name === '—' ? t.id : name;
    return (
      <button
        key={t.id}
        type="button"
        title={`${label} — ${empty ? 'empty' : muted ? 'muted' : 'live'}`}
        onClick={() => toggle(rowIdx, t.id)}
        className={[
          'flex-1 h-7 transition-colors',
          empty ? 'bg-white/5' : muted ? 'bg-white/30' : 'bg-white',
        ].join(' ')}
      />
    );
  };
  return (
    <div className="flex-1 flex items-center gap-[2px]">
      {drums.map((t) => cell(t))}
      {drums.length > 0 && melodic.length > 0 && (
        <span className="w-px h-7 bg-white/20 mx-1" />
      )}
      {melodic.map((t) => cell(t))}
    </div>
  );
}

function Row({ idx, row }: { idx: number; row: ArrangementRow }) {
  const setRow = useSequencerStore((s) => s.setArrangementRow);
  const moveRow = useSequencerStore((s) => s.moveArrangementRow);
  const removeRow = useSequencerStore((s) => s.removeArrangementRow);
  const isPlayhead = useSequencerStore(
    (s) => s.arrangement.active && s.playing && s.arrangement.displayCursor === idx,
  );
  return (
    <div
      className={[
        'flex items-center gap-2 py-1 border-b border-white/5',
        isPlayhead ? 'bg-white/10' : '',
      ].join(' ')}
    >
      <span className="w-4 text-[10px] text-white/40 text-right">
        {isPlayhead ? '▶' : idx + 1}
      </span>
      <select
        value={row.scene}
        onChange={(e) => setRow(idx, { scene: Number(e.target.value) })}
        title="scene"
        className="select-chevron bg-transparent border border-white/15 pl-1 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white h-[24px]"
      >
        {Array.from({ length: COMPOSITION_SLOT_COUNT }, (_, i) => (
          <option key={i} value={i} className="bg-[#050505]">
            {sceneLetter(i)}
          </option>
        ))}
      </select>
      <select
        value={row.bank}
        onChange={(e) => setRow(idx, { bank: Number(e.target.value) })}
        title="bank / pattern"
        className="select-chevron bg-transparent border border-white/15 pl-1 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white h-[24px]"
      >
        {Array.from({ length: BANK_SLOT_COUNT }, (_, i) => (
          <option key={i} value={i} className="bg-[#050505]">
            {i + 1}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-[10px] text-white/40 uppercase tracking-widest">
        bars
        <input
          type="number"
          min={1}
          value={row.bars}
          onChange={(e) => setRow(idx, { bars: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
          className="w-12 bg-transparent border border-white/15 px-1 text-[11px] text-white focus:outline-none focus:border-white h-[24px]"
        />
      </label>
      <MuteGrid rowIdx={idx} scene={row.scene} bank={row.bank} mutes={row.mutes} />
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => moveRow(idx, -1)}
          title="move up"
          className="px-1 h-[22px] text-[11px] border border-white/15 text-white/50 hover:text-white hover:border-white"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => moveRow(idx, 1)}
          title="move down"
          className="px-1 h-[22px] text-[11px] border border-white/15 text-white/50 hover:text-white hover:border-white"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() => removeRow(idx)}
          title="delete row"
          className="px-1 h-[22px] text-[11px] border border-white/15 text-white/50 hover:text-white hover:border-white"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function SongDialog({ onClose }: { onClose: () => void }) {
  const rows = useSequencerStore((s) => s.arrangement.rows);
  const active = useSequencerStore((s) => s.arrangement.active);
  const loop = useSequencerStore((s) => s.arrangement.loop);
  const setActive = useSequencerStore((s) => s.setArrangementActive);
  const setLoop = useSequencerStore((s) => s.setArrangementLoop);
  const addRow = useSequencerStore((s) => s.addArrangementRow);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[860px] max-h-[85vh] flex flex-col p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs uppercase tracking-widest"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 mb-4">
          <span className="text-sm tracking-[0.3em]">song</span>
          <button
            type="button"
            onClick={() => setActive(!active)}
            title="engage song mode — the arrangement drives advancement"
            className="text-[11px] uppercase tracking-widest text-white/70 hover:text-white"
          >
            {active ? '● engaged' : '○ engaged'}
          </button>
          <button
            type="button"
            onClick={() => setLoop(!loop)}
            title="loop back to the first row after the last"
            className="text-[11px] uppercase tracking-widest text-white/70 hover:text-white"
          >
            {loop ? '● loop' : '○ loop'}
          </button>
          <button
            type="button"
            onClick={() => addRow()}
            className="ml-auto px-2 h-[24px] text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
          >
            + row
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="px-2 h-[24px] text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="overflow-auto">
          {rows.length === 0 ? (
            <p className="text-[11px] text-white/40 py-6 text-center normal-case tracking-normal">
              No rows yet. Add a row to start building a song — each row is a
              scene + bank (e.g. B3) held for some bars, with per-track mutes.
            </p>
          ) : (
            rows.map((row, i) => <Row key={i} idx={i} row={row} />)
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SongView() {
  const [open, setOpen] = useState(false);
  const active = useSequencerStore((s) => s.arrangement.active);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="song mode — authored linear arrangement"
        className={[
          'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center h-[28px]',
          active
            ? 'border-white text-white'
            : 'border-white/15 text-white/60 hover:text-white hover:border-white',
        ].join(' ')}
      >
        song
      </button>
      {open && <SongDialog onClose={() => setOpen(false)} />}
    </>
  );
}
