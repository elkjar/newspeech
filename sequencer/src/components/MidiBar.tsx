import { useEffect, useRef, useState } from 'react';
import { useMidiMapStore } from '../midi/midiMapStore';
import { useSequencerStore } from '../state/store';
import { useMIDIOutputs } from '../hooks/useMIDIOutputs';
import { useMIDIInputs } from '../hooks/useMIDIInputs';
import { midiOutStatus } from '../audio/midiOut';
import { IconButton, DownloadIcon, ImportIcon } from './Transport';
import {
  getConnectedCount,
  getConnectedInputPorts,
  onLaunchpadConnectionChange,
} from '../midi/launchpad';
import { isTauri } from '@tauri-apps/api/core';
import {
  launchControlXL3Bindings,
  LAUNCH_CONTROL_XL3_PRESET_NAME,
} from '../midi/controllerPresets';
import {
  getClockPulseRate,
  getClockDebug,
  getFollowedBpm,
} from '../audio/clockFollow';

const NATIVE = isTauri();

const CREATE_NEW_ID = '__new__';
const CREATE_XL3_ID = '__xl3__';

function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Native <select> elements on macOS pick up extra UA chrome that makes
// them a few pixels taller than a plain button at the same padding.
// Pin every interactive control in the row to the same explicit height
// so nothing drifts.
const ROW_HEIGHT = 'h-[28px]';

function ExportButton() {
  const exportActiveMap = useMidiMapStore((s) => s.exportActiveMap);
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const disabled = !activeId;
  return (
    <IconButton
      title="export mapping (.midimap)"
      disabled={disabled}
      className={ROW_HEIGHT}
      onClick={() => {
        const out = exportActiveMap();
        if (!out) return;
        downloadFile(out.filename, out.json);
      }}
    >
      <DownloadIcon />
    </IconButton>
  );
}

function ImportButton() {
  const importMapFromJson = useMidiMapStore((s) => s.importMapFromJson);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        title="import mapping (.midimap)"
        className={ROW_HEIGHT}
        onClick={() => ref.current?.click()}
      >
        <ImportIcon />
      </IconButton>
      <input
        ref={ref}
        type="file"
        accept=".midimap,.json,application/json,text/plain"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const text = await file.text();
          const result = importMapFromJson(text);
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.warn('midimap import failed:', result.error);
          }
        }}
      />
    </>
  );
}

function RenameInput({ onDone }: { onDone: () => void }) {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const renameUserMap = useMidiMapStore((s) => s.renameUserMap);
  const active = activeId ? midiMaps[activeId] : null;
  const [value, setValue] = useState(active?.name ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = () => {
    const trimmed = value.trim();
    if (activeId && trimmed) renameUserMap(activeId, trimmed);
    onDone();
  };
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        }
      }}
      className={`bg-transparent border border-white/40 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none max-w-[150px] ${ROW_HEIGHT}`}
    />
  );
}

function RenameUserMapButton({ onClick }: { onClick: () => void }) {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const active = activeId ? midiMaps[activeId] : null;
  const canRename = !!active && active.source === 'user';
  return (
    <button
      onClick={() => {
        if (canRename) onClick();
      }}
      disabled={!canRename}
      title={canRename ? 'rename this mapping' : 'no mapping selected'}
      className={[
        'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center',
        ROW_HEIGHT,
        canRename
          ? 'border-white/15 text-white/60 hover:text-white hover:border-white'
          : 'border-white/10 text-white/20 cursor-not-allowed',
      ].join(' ')}
    >
      ✎
    </button>
  );
}

function DeleteUserMapButton() {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const deleteUserMap = useMidiMapStore((s) => s.deleteUserMap);
  const active = activeId ? midiMaps[activeId] : null;
  const canDelete = !!active && active.source === 'user';
  return (
    <button
      onClick={() => {
        if (!canDelete || !activeId || !active) return;
        if (confirm(`delete mapping "${active.name}"?`)) deleteUserMap(activeId);
      }}
      disabled={!canDelete}
      title={canDelete ? 'delete this mapping' : 'no mapping selected'}
      className={[
        'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center',
        ROW_HEIGHT,
        canDelete
          ? 'border-white/15 text-white/60 hover:text-white hover:border-white'
          : 'border-white/10 text-white/20 cursor-not-allowed',
      ].join(' ')}
    >
      ×
    </button>
  );
}

function LearnButton() {
  const learnMode = useMidiMapStore((s) => s.learnMode);
  const learnTarget = useMidiMapStore((s) => s.learnTarget);
  const setLearnMode = useMidiMapStore((s) => s.setLearnMode);

  return (
    <button
      onClick={() => setLearnMode(!learnMode)}
      title={
        learnMode
          ? learnTarget
            ? `learning ${learnTarget} — twist a knob or tap a pad`
            : 'learn mode — click a knob or pad'
          : 'enter learn mode'
      }
      className={[
        'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center',
        ROW_HEIGHT,
        learnMode
          ? 'bg-white text-ink border-white'
          : 'border-white/15 text-white/60 hover:text-white hover:border-white',
      ].join(' ')}
    >
      L
    </button>
  );
}

function MidiInSelector() {
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const setActiveMap = useMidiMapStore((s) => s.setActiveMap);
  const createUserMap = useMidiMapStore((s) => s.createUserMap);

  const entries = Object.values(midiMaps);

  return (
    <select
      value={activeId ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v === CREATE_NEW_ID) {
          createUserMap(`Untitled ${entries.length + 1}`);
          return;
        }
        if (v === CREATE_XL3_ID) {
          // One-shot: build the whole XL3 surface as a fresh user map and
          // make it active. Columns default to the melodic/lead tracks (8..15).
          createUserMap(LAUNCH_CONTROL_XL3_PRESET_NAME, launchControlXL3Bindings());
          return;
        }
        setActiveMap(v || null);
      }}
      className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[150px] ${ROW_HEIGHT}`}
      title="midi input mapping"
    >
      <option value="" className="bg-[#050505]">
        none
      </option>
      {entries.map((m) => (
        <option key={m.id} value={m.id} className="bg-[#050505]">
          {m.name}
        </option>
      ))}
      <option value={CREATE_NEW_ID} className="bg-[#050505]">
        + new mapping
      </option>
      <option value={CREATE_XL3_ID} className="bg-[#050505]">
        + Launch Control XL3
      </option>
    </select>
  );
}

function MidiInDeviceSelector() {
  const inputs = useMIDIInputs();
  const recPort = useSequencerStore((s) => s.midiRecInputPort);
  const setRecPort = useSequencerStore((s) => s.setMidiRecInputPort);
  const empty = inputs.length === 0;
  // CC mappings still auto-route from every connected input. This picker
  // gates ONE thing only: which device's note-on messages feed the
  // record-arm path (so a Launchpad pad press doesn't land in the
  // armed track when both are connected).
  // The selected port name is stored even if the device isn't currently
  // connected — re-plugging restores recording without re-picking.
  const showStale = recPort && !inputs.includes(recPort);
  return (
    <select
      value={recPort ?? ''}
      onChange={(e) => setRecPort(e.target.value || null)}
      className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[180px] ${ROW_HEIGHT}`}
      title={
        empty
          ? 'no midi inputs detected'
          : recPort
            ? `recording from ${recPort}${showStale ? ' (disconnected)' : ''}`
            : 'pick a device to record from (note-on writes to the armed track)'
      }
    >
      <option value="" className="bg-[#050505]">
        {empty ? 'no inputs' : 'none'}
      </option>
      {inputs.map((name) => (
        <option key={name} value={name} className="bg-[#050505]">
          {name}
        </option>
      ))}
      {showStale && (
        <option value={recPort} className="bg-[#050505]">
          {recPort} (disconnected)
        </option>
      )}
    </select>
  );
}

function MidiOutSelector() {
  const outputs = useMIDIOutputs();
  const deviceId = useSequencerStore((s) => s.midiOutDeviceId);
  const setDeviceId = useSequencerStore((s) => s.setMidiOutDeviceId);
  const status = midiOutStatus();
  const noOutputs = outputs.length === 0;

  return (
    <select
      value={deviceId ?? ''}
      onChange={(e) => setDeviceId(e.target.value || null)}
      disabled={status !== 'ready' || noOutputs}
      className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[150px] ${ROW_HEIGHT}`}
      title={
        status === 'unsupported'
          ? 'web midi not supported in this browser'
          : status === 'denied'
            ? 'midi access denied'
            : noOutputs
              ? 'no midi outputs detected'
              : 'midi output device'
      }
    >
      <option value="" className="bg-[#050505]">
        {status === 'unsupported'
          ? 'unsupported'
          : status === 'denied'
            ? 'denied'
            : noOutputs
              ? 'no outputs'
              : 'none'}
      </option>
      {outputs.map((o) => (
        <option key={o.id} value={o.id} className="bg-[#050505]">
          {o.name}
        </option>
      ))}
    </select>
  );
}

// Sequence is the rig clock master — this picks which output ports receive the
// 24-PPQN clock + Start/Stop. Clock is port-level (channel-less realtime
// messages broadcast on the whole port), so each is a destination, not a
// channel. One dropdown per destination + a "+ add output" to layer a second:
// the rack follows via the Mutant Brain while the Bluebox arms record-sync off
// the same Start. Independent of the note/CC output above. Nothing = clock off.
function MidiClockOutSelector() {
  const outputs = useMIDIOutputs();
  const ports = useSequencerStore((s) => s.midiClockOutPorts);
  const setPorts = useSequencerStore((s) => s.setMidiClockOutPorts);
  const status = midiOutStatus();
  // Transient empty slot for picking the next destination (not yet committed).
  const [adding, setAdding] = useState(false);

  if (status !== 'ready') {
    return (
      <span
        className={`inline-flex items-center px-2 text-[11px] uppercase tracking-widest text-white/30 ${ROW_HEIGHT}`}
      >
        {status === 'unsupported' ? 'unsupported' : 'denied'}
      </span>
    );
  }

  const known = (id: string) => outputs.some((o) => o.id === id);

  // Set the destination at `idx` (append when idx is past the end); empty value
  // removes that slot. De-dupes defensively so a port can't land twice.
  const setSlot = (idx: number, value: string) => {
    const next = ports.slice();
    if (!value) next.splice(idx, 1);
    else if (idx >= next.length) next.push(value);
    else next[idx] = value;
    setPorts(next.filter((p, i) => next.indexOf(p) === i));
    setAdding(false);
  };

  const renderSelect = (idx: number, current: string) => {
    const stale = !!current && !known(current);
    // Offer outputs not already taken by another slot (plus this slot's own).
    const taken = new Set(ports.filter((_, i) => i !== idx));
    const opts = outputs.filter((o) => !taken.has(o.id));
    return (
      <select
        key={`${idx}:${current}`}
        value={current}
        onChange={(e) => setSlot(idx, e.target.value)}
        className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[180px] ${ROW_HEIGHT}`}
        title={
          current
            ? `24-PPQN clock + start/stop → ${current}${stale ? ' (disconnected)' : ''}`
            : 'send midi clock out (sequence as clock master)'
        }
      >
        <option value="" className="bg-[#050505]">
          {current ? '— remove —' : 'off'}
        </option>
        {opts.map((o) => (
          <option key={o.id} value={o.id} className="bg-[#050505]">
            {o.name}
          </option>
        ))}
        {stale && (
          <option value={current} className="bg-[#050505]">
            {current} (disconnected)
          </option>
        )}
      </select>
    );
  };

  const canAddMore = ports.length < outputs.length;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {ports.length === 0
        ? renderSelect(0, '')
        : ports.map((p, i) => renderSelect(i, p))}
      {ports.length > 0 && adding && renderSelect(ports.length, '')}
      {ports.length > 0 && !adding && canAddMore && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`inline-flex items-center px-2 text-[11px] uppercase tracking-widest text-white/45 hover:text-white transition-colors focus:outline-none ${ROW_HEIGHT}`}
          title="add a second clock destination (e.g. bluebox record-sync)"
        >
          + add output
        </button>
      )}
    </div>
  );
}

// The MIDI output the XL3 mixer page emits Bluebox mixer CC to. One device =
// one port, so this is a plain single-select (unlike clock-out, which fans to
// several followers). Independent of the note/CC + clock destinations above.
function BlueboxPortSelector() {
  const outputs = useMIDIOutputs();
  const port = useSequencerStore((s) => s.blueboxPort);
  const setPort = useSequencerStore((s) => s.setBlueboxPort);
  const status = midiOutStatus();
  const noOutputs = outputs.length === 0;
  const showStale = !!port && !outputs.some((o) => o.id === port);

  return (
    <select
      value={port ?? ''}
      onChange={(e) => setPort(e.target.value || null)}
      disabled={status !== 'ready' || (noOutputs && !port)}
      className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[180px] ${ROW_HEIGHT}`}
      title={
        status === 'unsupported'
          ? 'web midi not supported in this browser'
          : status === 'denied'
            ? 'midi access denied'
            : port
              ? `xl3 mixer page → bluebox cc → ${port}${showStale ? ' (disconnected)' : ''}`
              : 'midi port the xl3 mixer page sends bluebox cc to'
      }
    >
      <option value="" className="bg-[#050505]">
        {status === 'unsupported' ? 'unsupported' : status === 'denied' ? 'denied' : 'off'}
      </option>
      {outputs.map((o) => (
        <option key={o.id} value={o.id} className="bg-[#050505]">
          {o.name}
        </option>
      ))}
      {showStale && (
        <option value={port} className="bg-[#050505]">
          {port} (disconnected)
        </option>
      )}
    </select>
  );
}

function MidiInputCluster() {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const [renaming, setRenaming] = useState(false);
  // Cancel rename mode when the active map changes (selector switches
  // out from under us, or the map is deleted).
  useEffect(() => {
    setRenaming(false);
  }, [activeId]);
  return (
    <div className="flex items-center gap-2">
      {renaming ? (
        <RenameInput onDone={() => setRenaming(false)} />
      ) : (
        <MidiInSelector />
      )}
      <LearnButton />
      <ExportButton />
      <ImportButton />
      <RenameUserMapButton onClick={() => setRenaming(true)} />
      <DeleteUserMapButton />
    </div>
  );
}

function LaunchpadStatus() {
  const [count, setCount] = useState(getConnectedCount());
  const [ports, setPorts] = useState<string[]>(getConnectedInputPorts());
  useEffect(() => {
    return onLaunchpadConnectionChange(() => {
      setCount(getConnectedCount());
      setPorts(getConnectedInputPorts());
    });
  }, []);
  if (!NATIVE) return null;
  const connected = count > 0;
  // Two dots = the left/right pair; each lights as its device connects. With
  // one pad it acts as the left half (steps 1–8).
  const title = connected
    ? `launchpad ×${count} ready · ${ports.join(' · ')}`
    : 'launchpad not detected';
  return (
    <div
      className={[
        'inline-flex items-center gap-2 px-2 text-[11px] uppercase tracking-widest border transition-colors',
        ROW_HEIGHT,
        connected ? 'border-white/40 text-white' : 'border-white/10 text-white/30',
      ].join(' ')}
      title={title}
    >
      <span className="inline-flex gap-0.5">
        <span className={count >= 1 ? 'text-white' : 'text-white/30'}>●</span>
        <span className={count >= 2 ? 'text-white' : 'text-white/30'}>●</span>
      </span>
      <span>launchpad</span>
    </div>
  );
}

// internal = Sequence is the clock master (emits clock-out). external = slave
// to a master on the clock-in port. Two-segment monochrome selector; fill marks
// the active mode (no accent color — sequencer convention).
function SyncSourceToggle() {
  const syncSource = useSequencerStore((s) => s.syncSource);
  const setSyncSource = useSequencerStore((s) => s.setSyncSource);
  const seg = (mode: 'internal' | 'external', label: string) => {
    const active = syncSource === mode;
    return (
      <button
        type="button"
        onClick={() => setSyncSource(mode)}
        className={[
          'px-2 text-[11px] uppercase tracking-widest transition-colors focus:outline-none',
          ROW_HEIGHT,
          active ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70',
        ].join(' ')}
        title={
          mode === 'internal'
            ? 'sequence is the clock master (sends clock out)'
            : 'follow an external midi clock master (tempo + transport)'
        }
      >
        {label}
      </button>
    );
  };
  return (
    <div className={`inline-flex border border-white/15 ${ROW_HEIGHT}`}>
      {seg('internal', 'master')}
      {seg('external', 'follow')}
    </div>
  );
}

// Single input port whose system-realtime stream drives the follow. Only a
// master sends clock, so this is single-select (mirrors the record-input
// picker). The chosen name is stored even when disconnected so a re-plug
// restores sync without re-picking.
function MidiClockInSelector() {
  const inputs = useMIDIInputs();
  const clockIn = useSequencerStore((s) => s.midiClockInPort);
  const setClockIn = useSequencerStore((s) => s.setMidiClockInPort);
  const empty = inputs.length === 0;
  const showStale = clockIn && !inputs.includes(clockIn);
  return (
    <select
      value={clockIn ?? ''}
      onChange={(e) => setClockIn(e.target.value || null)}
      className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[180px] ${ROW_HEIGHT}`}
      title={
        empty
          ? 'no midi inputs detected'
          : clockIn
            ? `following clock from ${clockIn}${showStale ? ' (disconnected)' : ''}`
            : 'pick the device sending midi clock (master)'
      }
    >
      <option value="" className="bg-[#050505]">
        {empty ? 'no inputs' : 'none'}
      </option>
      {inputs.map((name) => (
        <option key={name} value={name} className="bg-[#050505]">
          {name}
        </option>
      ))}
      {showStale && (
        <option value={clockIn} className="bg-[#050505]">
          {clockIn} (disconnected)
        </option>
      )}
    </select>
  );
}

// Lock indicator for follow mode: solid when the tempo tracker has locked onto
// the incoming clock, dim while waiting for it (or on a dropout). Also shows
// the raw pulse rate (~49/s at 123 BPM) — a low rate means pulses are being
// dropped before they reach the tracker, distinct from a tempo-math problem.
function ClockLockDot() {
  // Lock state is reactive from the store (HMR-proof). Rate is a module-level
  // diagnostic, polled on a timer for display.
  const locked = useSequencerStore((s) => s.clockFollowLocked);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setRate(getClockPulseRate()), 250);
    return () => window.clearInterval(id);
  }, []);
  const bpm = getFollowedBpm();
  const dbg = getClockDebug();
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 text-[11px] uppercase tracking-widest tabular-nums',
        ROW_HEIGHT,
        locked ? 'text-white' : 'text-white/30',
      ].join(' ')}
      title={
        (locked
          ? `locked to external clock${bpm ? ` · ${bpm} bpm` : ''} · ${rate} pulses/s`
          : `waiting for clock… · ${rate} pulses/s`) +
        ` · last tick Δ${dbg.dCount} pulses / ${dbg.dMicros}µs`
      }
    >
      <span>{locked ? '●' : '○'}</span>
      <span>{locked ? 'locked' : 'no lock'}</span>
      <span className="text-white/40">{rate}/s</span>
    </span>
  );
}

// As master, the row just picks clock-out destinations. As follower it ALSO
// picks the clock-in source (+ lock state) — clock-out stays editable because
// follow mode RELAYS the master's clock to those same destinations (the rig),
// so the in/out labels disambiguate the two pickers.
function ClockRow() {
  const following = useSequencerStore((s) => s.syncSource === 'external');
  const subLabel = 'text-[11px] uppercase tracking-widest opacity-40';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <SyncSourceToggle />
      {following && (
        <>
          <span className={subLabel}>in</span>
          <MidiClockInSelector />
          <ClockLockDot />
          <span className={subLabel}>out</span>
        </>
      )}
      <MidiClockOutSelector />
    </div>
  );
}

export function MidiBar() {
  const labelCls = 'text-[11px] uppercase tracking-widest opacity-55 w-[64px] shrink-0';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={labelCls}>in</span>
        <MidiInDeviceSelector />
        <LaunchpadStatus />
      </div>
      <div className="flex items-center gap-2">
        <span className={labelCls}>out</span>
        <MidiOutSelector />
      </div>
      <div className="flex items-center gap-2">
        <span className={labelCls}>clock</span>
        <ClockRow />
      </div>
      <div className="flex items-center gap-2">
        <span className={labelCls}>bluebox</span>
        <BlueboxPortSelector />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={labelCls}>mapping</span>
        <MidiInputCluster />
      </div>
    </div>
  );
}
