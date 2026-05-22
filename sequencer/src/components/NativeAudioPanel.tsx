// Phase 0 — exercises the native cpal audio engine.
// Device picker + channel/rate/buffer selection + per-channel test tones.
// No connection to the sequencer audio path yet; voices, FX, and routing
// move over in subsequent phases.

import { useEffect, useState } from 'react';
import {
  listOutputDevices,
  openOutputDevice,
  closeOutputDevice,
  setTestTone,
  getAudioStatus,
  type NativeDeviceInfo,
} from '../audio/nativeEngine';

const COMMON_BUFFER_SIZES = [64, 128, 256, 512, 1024];

export function NativeAudioPanel() {
  const [devices, setDevices] = useState<NativeDeviceInfo[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [channels, setChannels] = useState<number>(2);
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [bufferSize, setBufferSize] = useState<number>(0);
  const [isOpen, setIsOpen] = useState(false);
  const [statusText, setStatusText] = useState<string>('closed');
  const [activeToneChannel, setActiveToneChannel] = useState<number | null>(null);
  const [openedChannels, setOpenedChannels] = useState<number>(0);
  const [openedSampleRate, setOpenedSampleRate] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = async () => {
    setLoadingDevices(true);
    setError(null);
    try {
      const list = await listOutputDevices();
      setDevices(list);
      // Default selection: prefer the system default, else the first.
      if (!selectedDevice) {
        const def = list.find((d) => d.isDefault) ?? list[0];
        if (def) {
          setSelectedDevice(def.name);
          if (def.defaultSampleRate > 0) setSampleRate(def.defaultSampleRate);
          if (def.maxOutputChannels > 0) setChannels(Math.min(2, def.maxOutputChannels));
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    void refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = devices.find((d) => d.name === selectedDevice);

  // When the user picks a new device, re-clamp channel count + sample rate.
  useEffect(() => {
    if (!current) return;
    if (current.maxOutputChannels > 0 && channels > current.maxOutputChannels) {
      setChannels(current.maxOutputChannels);
    }
    if (current.supportedSampleRates.length > 0 && !current.supportedSampleRates.includes(sampleRate)) {
      setSampleRate(current.defaultSampleRate || current.supportedSampleRates[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice]);

  const handleOpen = async () => {
    setError(null);
    setStatusText('opening…');
    try {
      const info = await openOutputDevice({
        deviceName: selectedDevice,
        channels,
        sampleRate,
        bufferSize: bufferSize > 0 ? bufferSize : undefined,
      });
      setIsOpen(true);
      setOpenedChannels(info.channels);
      setOpenedSampleRate(info.sampleRate);
      setStatusText(
        `open · ${info.channels}ch · ${info.sampleRate} Hz · buf ${info.bufferSize || 'default'}`,
      );
    } catch (err) {
      setIsOpen(false);
      setError(String(err));
      setStatusText('failed');
    }
  };

  const handleClose = async () => {
    setError(null);
    try {
      await closeOutputDevice();
    } catch (err) {
      setError(String(err));
    }
    setIsOpen(false);
    setActiveToneChannel(null);
    setOpenedChannels(0);
    setOpenedSampleRate(0);
    setStatusText('closed');
  };

  const handleToneToggle = async (ch: number) => {
    try {
      if (activeToneChannel === ch) {
        await setTestTone(null);
        setActiveToneChannel(null);
      } else {
        await setTestTone(ch, 440);
        setActiveToneChannel(ch);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const refreshStatus = async () => {
    try {
      const s = await getAudioStatus();
      setOpenedChannels(s.channels);
      setOpenedSampleRate(s.sampleRate);
      setStatusText(
        s.channels > 0
          ? `open · ${s.channels}ch · ${s.sampleRate} Hz`
          : 'closed',
      );
      setIsOpen(s.channels > 0);
    } catch (err) {
      setError(String(err));
    }
  };

  const activeChannels = openedChannels > 0 ? openedChannels : channels;

  return (
    <div className="flex flex-col gap-3 normal-case tracking-normal text-[12px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] uppercase tracking-widest text-white/55">device</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={refreshDevices}
            disabled={loadingDevices}
            className={
              loadingDevices
                ? 'px-2 py-0.5 text-[10px] uppercase tracking-widest border border-white/10 text-white/20'
                : 'px-2 py-0.5 text-[10px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
            }
          >
            {loadingDevices ? 'loading…' : 'rescan'}
          </button>
        </div>
      </div>
      <select
        value={selectedDevice}
        onChange={(e) => setSelectedDevice(e.target.value)}
        className="w-full bg-transparent border border-white/15 text-white/90 text-[12px] px-2 py-1"
      >
        {devices.length === 0 && <option value="">— no devices —</option>}
        {devices.map((d) => (
          <option key={d.name} value={d.name}>
            {d.isDefault ? `★ ${d.name}` : d.name} — {d.maxOutputChannels}ch
            {d.defaultSampleRate ? ` · ${d.defaultSampleRate} Hz` : ''}
          </option>
        ))}
      </select>

      <div className="grid grid-cols-3 gap-3 mt-2">
        <Field label="channels">
          <input
            type="number"
            min={1}
            max={current?.maxOutputChannels ?? 32}
            value={channels}
            onChange={(e) => setChannels(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-full bg-transparent border border-white/15 text-white/90 text-[12px] px-2 py-1"
          />
          {current && (
            <div className="text-[10px] text-white/40">max {current.maxOutputChannels}</div>
          )}
        </Field>
        <Field label="sample rate">
          <select
            value={sampleRate}
            onChange={(e) => setSampleRate(parseInt(e.target.value, 10))}
            className="w-full bg-transparent border border-white/15 text-white/90 text-[12px] px-2 py-1"
          >
            {(current?.supportedSampleRates ?? [44100, 48000, 96000]).map((sr) => (
              <option key={sr} value={sr}>
                {sr} Hz
              </option>
            ))}
          </select>
        </Field>
        <Field label="buffer">
          <select
            value={bufferSize}
            onChange={(e) => setBufferSize(parseInt(e.target.value, 10))}
            className="w-full bg-transparent border border-white/15 text-white/90 text-[12px] px-2 py-1"
          >
            <option value={0}>default</option>
            {COMMON_BUFFER_SIZES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          {current?.minBufferSize !== null && current?.maxBufferSize !== null && current && (
            <div className="text-[10px] text-white/40">
              dev range {current.minBufferSize}–{current.maxBufferSize}
            </div>
          )}
        </Field>
      </div>

      <div className="flex items-center gap-2 mt-2">
        {!isOpen ? (
          <button
            type="button"
            onClick={handleOpen}
            disabled={!selectedDevice}
            className={
              !selectedDevice
                ? 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/10 text-white/20 cursor-not-allowed'
                : 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
            }
          >
            open
          </button>
        ) : (
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
          >
            close
          </button>
        )}
        <button
          type="button"
          onClick={refreshStatus}
          className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
        >
          status
        </button>
        <span className="text-[11px] text-white/60 font-mono">{statusText}</span>
      </div>

      {error && <div className="text-[11px] text-red-400 font-mono">{error}</div>}

      <div className="flex flex-col gap-1 mt-2">
        <div className="text-[10px] uppercase tracking-widest text-white/55">test tone (440 hz)</div>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: activeChannels }).map((_, i) => {
            const active = activeToneChannel === i;
            return (
              <button
                key={i}
                type="button"
                disabled={!isOpen}
                onClick={() => handleToneToggle(i)}
                className={
                  !isOpen
                    ? 'min-w-[36px] px-2 py-1 text-[11px] uppercase tracking-widest border border-white/10 text-white/20'
                    : active
                      ? 'min-w-[36px] px-2 py-1 text-[11px] uppercase tracking-widest border border-white text-white bg-white/10'
                      : 'min-w-[36px] px-2 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
                }
                title={`channel ${i + 1}`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        {openedSampleRate > 0 && (
          <div className="text-[10px] text-white/40 font-mono">
            running at {openedSampleRate} Hz · {openedChannels}ch
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-white/55">{label}</span>
      {children}
    </div>
  );
}
