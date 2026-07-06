import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Instrument, InstrumentRole } from '../instruments/library';
import {
  generateInstrumentId,
  useUserInstrumentsStore,
} from '../instruments/userInstrumentsStore';
import {
  resolveDeviceId,
  sendMIDINote,
  sendPatchSelect,
} from '../audio/midiOut';
import { engineNow } from '../audio/engineClock';
import { useMIDIOutputs } from '../hooks/useMIDIOutputs';

// Form modal for creating a new user MIDI instrument. Visually matches
// ConfirmDialog (portal-to-body, same backdrop + panel chrome) but wider
// for form rows. Closes on Esc; Cmd/Ctrl+Enter saves.

type NewInstrumentDialogProps = {
  open: boolean;
  defaultRole: InstrumentRole;
  // When provided, dialog opens in edit mode: pre-fills the form, save
  // updates the existing record by id instead of creating a new one.
  existing?: Instrument | null;
  onCancel: () => void;
  onCreated: (saved: Instrument) => void;
};

function parseOptInt(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(127, Math.round(n))) : null;
}

export function NewInstrumentDialog({
  open,
  defaultRole,
  existing,
  onCancel,
  onCreated,
}: NewInstrumentDialogProps) {
  const userInstruments = useUserInstrumentsStore((s) => s.userInstruments);
  const addInstrument = useUserInstrumentsStore((s) => s.addInstrument);
  const updateInstrument = useUserInstrumentsStore((s) => s.updateInstrument);
  const editing = existing ?? null;

  const [name, setName] = useState('');
  const [role, setRole] = useState<InstrumentRole>(defaultRole);
  const [portName, setPortName] = useState('');
  const [channelOneBased, setChannelOneBased] = useState('1');
  const [bankMSB, setBankMSB] = useState('');
  const [bankLSB, setBankLSB] = useState('');
  const [program, setProgram] = useState('');
  const [fixedNote, setFixedNote] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.label);
      setRole(editing.role);
      setPortName(editing.portName ?? '');
      setChannelOneBased(String((editing.channel | 0) + 1));
      setBankMSB(editing.bankMSB === null ? '' : String(editing.bankMSB));
      setBankLSB(editing.bankLSB === null ? '' : String(editing.bankLSB));
      setProgram(editing.program === null ? '' : String(editing.program));
      setFixedNote(editing.fixedNote === null ? '' : String(editing.fixedNote));
    } else {
      // defaultRole flows from the row the user opened it from so it lands
      // sensibly without an extra click.
      setName('');
      setRole(defaultRole);
      setPortName('');
      setChannelOneBased(defaultRole === 'drum' ? '10' : '1');
      setBankMSB('');
      setBankLSB('');
      setProgram('');
      setFixedNote('');
    }
  }, [open, defaultRole, editing]);

  const trimmedName = name.trim();
  const canSave = useMemo(() => trimmedName.length > 0, [trimmedName]);

  const handleSend = () => {
    const ch = Math.max(0, Math.min(15, (parseOptInt(channelOneBased) ?? 1) - 1));
    const port = portName.trim() || null;
    const programVal = parseOptInt(program);
    const msb = parseOptInt(bankMSB);
    const lsb = parseOptInt(bankLSB);
    const noteVal = parseOptInt(fixedNote);
    const deviceId = resolveDeviceId(port, null);
    if (!deviceId) {
      console.warn('[instrument] send: no matching output for', port);
      return;
    }
    if (programVal !== null || msb !== null || lsb !== null) {
      sendPatchSelect(deviceId, ch, msb, lsb, programVal);
    }
    if (role === 'drum' && noteVal !== null) {
      sendMIDINote(deviceId, ch, noteVal, 0.8, engineNow() + 0.005, 0.15);
    }
  };

  const handleSave = () => {
    if (!canSave) return;
    const channel0 = Math.max(0, Math.min(15, (parseOptInt(channelOneBased) ?? 1) - 1));
    if (editing) {
      const patch: Partial<Instrument> = {
        label: trimmedName,
        role,
        channel: channel0,
        portName: portName.trim() ? portName.trim() : null,
        program: parseOptInt(program),
        bankMSB: parseOptInt(bankMSB),
        bankLSB: parseOptInt(bankLSB),
        fixedNote: role === 'drum' ? parseOptInt(fixedNote) : null,
      };
      updateInstrument(editing.id, patch);
      onCreated({ ...editing, ...patch } as Instrument);
      return;
    }
    const id = generateInstrumentId(trimmedName, userInstruments);
    const inst: Instrument = {
      id,
      label: trimmedName,
      role,
      channel: channel0,
      portName: portName.trim() ? portName.trim() : null,
      program: parseOptInt(program),
      bankMSB: parseOptInt(bankMSB),
      bankLSB: parseOptInt(bankLSB),
      fixedNote: role === 'drum' ? parseOptInt(fixedNote) : null,
    };
    addInstrument(inst);
    onCreated(inst);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.stopPropagation();
        handleSave();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // handleSave closes over current form state — recompute listener each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[540px] p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs uppercase tracking-widest"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white text-sm mb-4">
          {editing ? 'edit midi instrument' : 'new midi instrument'}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 normal-case tracking-normal text-[12px]">
          <Field
            label="name"
            placeholder="e.g. ms-2000 lead"
            value={name}
            onChange={setName}
            full
            autoFocus
          />

          <RoleField value={role} onChange={setRole} />

          <PortField value={portName} onChange={setPortName} />

          <ChannelField value={channelOneBased} onChange={setChannelOneBased} />

          <NumberField label="bank msb" placeholder="0–127" value={bankMSB} onChange={setBankMSB} />
          <NumberField label="bank lsb" placeholder="0–127" value={bankLSB} onChange={setBankLSB} />

          <NumberField label="program" placeholder="0–127" value={program} onChange={setProgram} />
          {role === 'drum' ? (
            <NumberField
              label="fixed note"
              placeholder="0–127"
              value={fixedNote}
              onChange={setFixedNote}
            />
          ) : (
            <div />
          )}
        </div>

        <div className="flex items-center justify-between mt-5">
          <button
            type="button"
            onClick={handleSend}
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
            title="resend bank-select + program change (drum: also fires a test note on the fixed note)"
          >
            send
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className={
                canSave
                  ? 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white text-white hover:bg-white/10 transition-colors'
                  : 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/10 text-white/20 cursor-not-allowed'
              }
            >
              save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
  full,
  autoFocus,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  full?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className={full ? 'col-span-2 flex flex-col gap-1' : 'flex flex-col gap-1'}>
      <span className="text-[10px] uppercase tracking-widest text-white/55">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent border border-white/15 px-2 py-1 focus:outline-none focus:border-white"
      />
    </label>
  );
}

function NumberField({
  label,
  placeholder,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-white/55">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent border border-white/15 px-2 py-1 focus:outline-none focus:border-white tabular-nums"
      />
    </label>
  );
}

function PortField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const outputs = useMIDIOutputs();
  // Stable id — multiple dialogs in tree share the same datalist; that's
  // fine since datalist is read-only.
  const listId = 'midi-output-ports';
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-white/55">port substring</span>
      <input
        type="text"
        list={listId}
        value={value}
        placeholder="type or pick"
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent border border-white/15 px-2 py-1 focus:outline-none focus:border-white"
      />
      <datalist id={listId}>
        {outputs.map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>
    </label>
  );
}

function ChannelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-white/55">channel</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="select-chevron bg-transparent border border-white/15 px-2 py-1 focus:outline-none focus:border-white tabular-nums"
      >
        {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={String(n)} className="bg-[#050505]">
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

function RoleField({
  value,
  onChange,
}: {
  value: InstrumentRole;
  onChange: (v: InstrumentRole) => void;
}) {
  const opts: InstrumentRole[] = ['lead', 'bass', 'pad', 'texture', 'drum'];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-white/55">role</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {opts.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            className={
              value === r
                ? 'px-2 py-1 text-[11px] uppercase tracking-widest border bg-white text-ink border-white'
                : 'px-2 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
            }
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}
