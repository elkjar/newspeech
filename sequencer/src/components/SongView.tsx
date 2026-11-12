import { createContext, useContext, useRef, useState } from 'react';
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

// Where the song is and what comes next, for following along while playing an
// instrument. Read off the audible step, so it tracks what's heard.
//   row  — the row that's sounding          bar/bars — position inside it
//   next — the row it goes to (null = the song ends after this row)
//   count — 4·3·2·1 through the row's last bar (null before that); the next
//           row lands on the beat after "1"
const STEPS_PER_BAR = 32;
type SongCue = { row: number; bar: number; bars: number; next: number | null; count: number | null };
type CueState = ReturnType<typeof useSequencerStore.getState>;
function songCue(s: CueState): SongCue | null {
  const arr = s.arrangement;
  if (!arr.active || !s.playing || arr.rows.length === 0) return null;
  const row = arr.displayCursor;
  const cur = arr.rows[row];
  if (!cur) return null;
  const bars = Math.max(1, Math.floor(cur.bars));
  // The engine cursor moves a bar early, when the next row is queued: from
  // then until the swap lands, the sounding row is in its last bar.
  const queued = arr.cursor !== row || s.globalStep < arr.cursorStartStep;
  const elapsed = Math.floor((s.globalStep - arr.cursorStartStep) / STEPS_PER_BAR);
  const bar = queued ? bars : Math.min(bars, Math.max(1, elapsed + 1));
  let next: number | null;
  if (queued) {
    next = arr.cursor;
  } else {
    const r = s.arrangementRange;
    if (r && r.end !== null && row === r.end && r.start <= r.end) next = r.start;
    else if (row + 1 < arr.rows.length) next = row + 1;
    else next = arr.loop ? 0 : null;
  }
  const beat = Math.floor((((s.globalStep % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR) / 8);
  const count = bar === bars ? 4 - beat : null;
  return { row, bar, bars, next, count };
}
// One primitive per subscriber, so a component re-renders only when its own
// piece of the cue changes (the store ticks every step).
const cueKey = (s: CueState) => {
  const c = songCue(s);
  return c ? `${c.row}|${c.bar}|${c.bars}|${c.next ?? ''}|${c.count ?? ''}` : '';
};
function useSongCue(): SongCue | null {
  const key = useSequencerStore(cueKey);
  if (!key) return null;
  const [row, bar, bars, next, count] = key.split('|');
  return {
    row: Number(row),
    bar: Number(bar),
    bars: Number(bars),
    next: next === '' ? null : Number(next),
    count: count === '' ? null : Number(count),
  };
}

// Header readout: the sounding pattern, bar position, the pattern coming next,
// and four dots that fill one per beat through the last bar.
function CueReadout() {
  const cue = useSongCue();
  const rows = useSequencerStore((s) => s.arrangement.rows);
  if (!cue) return null;
  const name = (i: number) => {
    const r = rows[i];
    return r ? `${sceneLetter(r.scene)}${r.bank + 1}` : '';
  };
  const last = cue.count !== null;
  return (
    <div className="flex items-center gap-3 text-sm tracking-widest text-white">
      <span>{name(cue.row)}</span>
      <span className={last ? 'text-white' : 'text-white/60'}>
        bar {cue.bar}/{cue.bars}
      </span>
      <span className={last ? 'text-white' : 'text-white/60'}>
        {cue.next === null ? 'ends' : `next ${name(cue.next)}`}
      </span>
      <span className="flex items-center gap-1" title="counts 4·3·2·1 through the last bar">
        {[4, 3, 2, 1].map((n) => (
          <span
            key={n}
            className={[
              'w-3 h-3 border',
              last && cue.count! <= n ? 'bg-white border-white' : 'border-white/30',
            ].join(' ')}
          />
        ))}
      </span>
    </div>
  );
}

// Dragging a box onto another row copies that track's pattern into the other
// row's bank. `over` = the row under the pointer (null when off the rows).
type CellDrag = { fromRow: number; trackId: string; over: number | null };
const CellDragCtx = createContext<{
  drag: CellDrag | null;
  setDrag: (d: CellDrag | null) => void;
}>({ drag: null, setDrag: () => {} });
// Pointer travel before a press on a box becomes a drag rather than a click.
const DRAG_THRESHOLD_PX = 5;

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
  const copyTrack = useSequencerStore((s) => s.copyArrangementTrack);
  const { drag, setDrag } = useContext(CellDragCtx);
  // Press origin for the box under the pointer; `dragged` swallows the click
  // that follows a drag so a drop doesn't also toggle the source's mute.
  const press = useRef<{ x: number; y: number; trackId: string; dragged: boolean } | null>(null);
  const rowAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-song-row]');
    return el ? Number(el.getAttribute('data-song-row')) : null;
  };

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
        title={`${label} — ${empty ? 'empty' : muted ? 'muted' : 'live'}${
          empty ? '' : ' · drag to another row to copy this pattern into its bank'
        }`}
        onClick={() => {
          if (press.current?.dragged) {
            press.current = null;
            return;
          }
          toggle(rowIdx, t.id);
        }}
        onPointerDown={(e) => {
          // An empty channel has no pattern to carry.
          if (empty || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          press.current = { x: e.clientX, y: e.clientY, trackId: t.id, dragged: false };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (!p || p.trackId !== t.id || !(e.buttons & 1)) return;
          if (
            !p.dragged &&
            Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX
          )
            return;
          p.dragged = true;
          const over = rowAt(e.clientX, e.clientY);
          if (!drag || drag.over !== over) setDrag({ fromRow: rowIdx, trackId: t.id, over });
        }}
        onPointerUp={(e) => {
          const p = press.current;
          if (!p?.dragged) {
            press.current = null;
            return;
          }
          const over = rowAt(e.clientX, e.clientY);
          setDrag(null);
          if (over !== null && over !== rowIdx) copyTrack(rowIdx, over, t.id);
        }}
        onPointerCancel={() => {
          press.current = null;
          setDrag(null);
        }}
        className={[
          'flex-1 h-7 transition-colors touch-none',
          empty ? 'bg-white/5' : muted ? 'bg-white/30' : 'bg-white',
          // Drop target: this track's box on the row under the pointer.
          drag && drag.trackId === t.id && drag.over === rowIdx && drag.fromRow !== rowIdx
            ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0a0a0a]'
            : '',
          drag && drag.trackId === t.id && drag.fromRow === rowIdx ? 'opacity-50' : '',
        ].join(' ')}
      />
    );
  };
  return (
    <div className="flex-1 flex items-center gap-[2px]">
      {drums.map((t) => cell(t))}
      {drums.length > 0 && melodic.length > 0 && (
        <span className="w-px h-7 bg-white/20 mx-3" />
      )}
      {melodic.map((t) => cell(t))}
    </div>
  );
}

// Drag state for reordering: the row being dragged and the gap it would drop
// into (0 = above the first row, rows.length = below the last).
type RowDrag = { from: number; to: number };

function Row({
  idx,
  row,
  count,
  drag,
  setDrag,
}: {
  idx: number;
  row: ArrangementRow;
  count: number;
  drag: RowDrag | null;
  setDrag: (d: RowDrag | null) => void;
}) {
  const setRow = useSequencerStore((s) => s.setArrangementRow);
  const moveRow = useSequencerStore((s) => s.moveArrangementRow);
  // Drag the grip to reorder. Pointer events (captured on the grip) rather
  // than HTML5 drag-and-drop, which the Tauri webview can swallow. The drop
  // gap is found from the sibling rows' midpoints.
  const gapAt = (grip: HTMLElement, y: number) => {
    const list = grip.closest('[data-song-rows]');
    if (!list) return idx;
    let gap = 0;
    for (const el of Array.from(list.children)) {
      const r = el.getBoundingClientRect();
      if (y > r.top + r.height / 2) gap++;
    }
    return gap;
  };
  const dragging = drag?.from === idx;
  // A drop into the gap directly above or below the dragged row moves nothing.
  const moves = !!drag && drag.to !== drag.from && drag.to !== drag.from + 1;
  const dropAbove = moves && drag!.to === idx;
  const dropBelow = moves && drag!.to === count && idx === count - 1;
  const removeRow = useSequencerStore((s) => s.removeArrangementRow);
  const isPlayhead = useSequencerStore(
    (s) => s.arrangement.active && s.playing && s.arrangement.displayCursor === idx,
  );
  // 0 = not next, 1 = the row coming next, 2 = next and the count is running.
  const nextState = useSequencerStore((s) => {
    const c = songCue(s);
    return c && c.next === idx && c.row !== idx ? (c.count !== null ? 2 : 1) : 0;
  });
  // Bar position inside this row while it sounds ('' otherwise).
  const barPos = useSequencerStore((s) => {
    const c = songCue(s);
    return c && c.row === idx ? `${c.bar}/${c.bars}` : '';
  });
  // Section loop: click a row number to start playback there, shift-click a
  // row to close the loop on it, click the start row again to clear.
  const range = useSequencerStore((s) => s.arrangementRange);
  const setRange = useSequencerStore((s) => s.setArrangementRange);
  const isStart = range?.start === idx;
  const inRange =
    !!range && (range.end === null ? isStart : idx >= range.start && idx <= range.end);
  const onNumber = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      const a = range ? range.start : idx;
      setRange({ start: Math.min(a, idx), end: Math.max(a, idx) });
    } else if (isStart) {
      setRange(null);
    } else {
      setRange({ start: idx, end: null });
    }
  };
  return (
    <div
      data-song-row={idx}
      className={[
        'flex items-center gap-2 py-1 border-b border-white/5',
        isPlayhead ? 'bg-white/10' : nextState === 2 ? 'bg-white/5' : '',
        dragging ? 'opacity-40' : '',
      ].join(' ')}
      style={{
        boxShadow: dropAbove
          ? 'inset 0 2px 0 0 #fff'
          : dropBelow
            ? 'inset 0 -2px 0 0 #fff'
            : undefined,
      }}
    >
      <button
        type="button"
        onClick={onNumber}
        title={
          isStart
            ? 'play starts here — click to clear, shift-click a row to loop to it'
            : 'click: start play here · shift-click: loop to this row'
        }
        className={[
          'w-9 h-7 pl-3 pr-1 text-[10px] text-right border-l-2 transition-colors',
          inRange
            ? 'border-white text-white'
            : 'border-transparent text-white/40 hover:text-white',
        ].join(' ')}
      >
        {isPlayhead ? '▶' : nextState ? '▷' : idx + 1}
      </button>
      <button
        type="button"
        title="drag to move"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ from: idx, to: idx });
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const to = gapAt(e.currentTarget, e.clientY);
          if (to !== drag!.to) setDrag({ from: idx, to });
        }}
        onPointerUp={() => {
          if (!dragging) return;
          // Gap index → final row index once the dragged row is lifted out.
          const dest = drag!.to > idx ? drag!.to - 1 : drag!.to;
          setDrag(null);
          if (dest !== idx) moveRow(idx, dest - idx);
        }}
        onPointerCancel={() => setDrag(null)}
        className="px-1 h-7 text-[13px] leading-none text-white/40 hover:text-white cursor-grab active:cursor-grabbing touch-none"
      >
        ≡
      </button>
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
        {/* Fixed width so the playing row's "5 /" doesn't shift the grid. */}
        <span className={['w-8 text-right', barPos ? 'text-white' : ''].join(' ')}>
          {barPos ? `${barPos.split('/')[0]} /` : 'bars'}
        </span>
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
          onClick={() => removeRow(idx)}
          title="delete row"
          className="px-1 h-7 text-[11px] text-white/40 hover:text-white"
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
  const range = useSequencerStore((s) => s.arrangementRange);
  const setRange = useSequencerStore((s) => s.setArrangementRange);

  const [drag, setDrag] = useState<RowDrag | null>(null);
  const [cellDrag, setCellDrag] = useState<CellDrag | null>(null);

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
          {range && (
            <button
              type="button"
              onClick={() => setRange(null)}
              title="clear — play the whole song from row 1"
              className="text-[11px] uppercase tracking-widest text-white/70 hover:text-white"
            >
              {range.end === null
                ? `● from ${range.start + 1}`
                : range.end === range.start
                  ? `● loop ${range.start + 1}`
                  : `● loop ${range.start + 1}–${range.end + 1}`}
            </button>
          )}
          <div className="flex-1 flex justify-center">
            <CueReadout />
          </div>
          <button
            type="button"
            onClick={() => addRow()}
            className="px-2 h-[24px] text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
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
        <div className="overflow-auto" data-song-rows={rows.length > 0 ? '' : undefined}>
          {rows.length === 0 ? (
            <p className="text-[11px] text-white/40 py-6 text-center normal-case tracking-normal">
              No rows yet. Add a row to start building a song — each row is a
              scene + bank (e.g. B3) held for some bars, with per-track mutes.
            </p>
          ) : (
            <CellDragCtx.Provider value={{ drag: cellDrag, setDrag: setCellDrag }}>
              {rows.map((row, i) => (
                <Row key={i} idx={i} row={row} count={rows.length} drag={drag} setDrag={setDrag} />
              ))}
            </CellDragCtx.Provider>
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
