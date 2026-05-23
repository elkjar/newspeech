// Native audio settings — device picker + per-channel test tones.
// The cpal device auto-opens on app launch from persisted settings
// (see initNativeAudio in nativeEngine.ts), so this panel is purely
// for "change device", "tweak buffer/SR", or "verify channel routing".
// Every selector change immediately re-applies the device config and
// persists it.

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  listOutputDevices,
  applyOutputDeviceConfig,
  setTestTone,
  readPersistedNativeAudioSettings,
  getReportedChannelCount,
  subscribeReportedChannelCount,
  type NativeDeviceInfo,
} from '../audio/nativeEngine';
import { useSequencerStore, type TrackOutput } from '../state/store';

const COMMON_BUFFER_SIZES = [64, 128, 256, 512, 1024];

export function NativeAudioPanel() {
  const [devices, setDevices] = useState<NativeDeviceInfo[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [channels, setChannels] = useState<number>(2);
  const [sampleRate, setSampleRate] = useState<number>(48000);
  const [bufferSize, setBufferSize] = useState<number>(0);
  const [activeToneChannel, setActiveToneChannel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reportedChannels = useSyncExternalStore(
    subscribeReportedChannelCount,
    getReportedChannelCount,
  );

  const refreshDevices = async () => {
    setLoadingDevices(true);
    setError(null);
    try {
      const list = await listOutputDevices();
      setDevices(list);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingDevices(false);
    }
  };

  // On mount, fetch device list + read whatever the auto-open chose
  // (or fallback to persisted / system default) so the controls show
  // the live state instead of stale UI defaults.
  useEffect(() => {
    void refreshDevices();
    const persisted = readPersistedNativeAudioSettings();
    if (persisted.deviceName) setSelectedDevice(persisted.deviceName);
    if (persisted.channels) setChannels(persisted.channels);
    if (persisted.sampleRate) setSampleRate(persisted.sampleRate);
    if (persisted.bufferSize !== undefined) setBufferSize(persisted.bufferSize);
  }, []);

  const current = devices.find((d) => d.name === selectedDevice);

  // Apply + persist whenever the user changes a selector. Wrapped so
  // every onChange handler can fire-and-forget.
  const apply = (overrides: {
    deviceName?: string;
    channels?: number;
    sampleRate?: number;
    bufferSize?: number;
  }) => {
    const config = {
      deviceName: overrides.deviceName ?? selectedDevice,
      channels: overrides.channels ?? channels,
      sampleRate: overrides.sampleRate ?? sampleRate,
      bufferSize: overrides.bufferSize ?? bufferSize,
    };
    if (!config.deviceName) return;
    setError(null);
    void applyOutputDeviceConfig({
      deviceName: config.deviceName,
      channels: config.channels,
      sampleRate: config.sampleRate,
      bufferSize: config.bufferSize > 0 ? config.bufferSize : undefined,
    }).catch((err) => {
      setError(String(err));
    });
  };

  const onPickDevice = (name: string) => {
    setSelectedDevice(name);
    // When switching device, snap channels + SR to the new device's
    // capabilities so we don't try to open an unsupported config.
    const dev = devices.find((d) => d.name === name);
    let newChannels = channels;
    let newSampleRate = sampleRate;
    if (dev) {
      if (channels > dev.maxOutputChannels) {
        newChannels = dev.maxOutputChannels;
        setChannels(newChannels);
      }
      if (
        dev.supportedSampleRates.length > 0 &&
        !dev.supportedSampleRates.includes(sampleRate)
      ) {
        newSampleRate = dev.defaultSampleRate || dev.supportedSampleRates[0];
        setSampleRate(newSampleRate);
      }
    }
    apply({ deviceName: name, channels: newChannels, sampleRate: newSampleRate });
  };

  const onChannels = (n: number) => {
    const clamped = Math.max(1, Math.min(current?.maxOutputChannels ?? 32, n));
    setChannels(clamped);
    apply({ channels: clamped });
  };
  const onSampleRate = (sr: number) => {
    setSampleRate(sr);
    apply({ sampleRate: sr });
  };
  const onBufferSize = (bs: number) => {
    setBufferSize(bs);
    apply({ bufferSize: bs });
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

  const isOpen = reportedChannels > 0;
  const activeChannels = isOpen ? reportedChannels : channels;

  return (
    <div className="flex flex-col gap-3 normal-case tracking-normal text-[12px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] uppercase tracking-widest text-white/55">device</span>
        <button
          type="button"
          onClick={() => void refreshDevices()}
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
      <select
        value={selectedDevice}
        onChange={(e) => onPickDevice(e.target.value)}
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
            onChange={(e) => onChannels(parseInt(e.target.value, 10) || 1)}
            className="w-full bg-transparent border border-white/15 text-white/90 text-[12px] px-2 py-1"
          />
          {current && (
            <div className="text-[10px] text-white/40">max {current.maxOutputChannels}</div>
          )}
        </Field>
        <Field label="sample rate">
          <select
            value={sampleRate}
            onChange={(e) => onSampleRate(parseInt(e.target.value, 10))}
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
            onChange={(e) => onBufferSize(parseInt(e.target.value, 10))}
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

      <div className="text-[11px] text-white/60 font-mono mt-1">
        {isOpen
          ? `running · ${reportedChannels}ch`
          : 'device not open'}
      </div>

      {error && <div className="text-[11px] text-red-400 font-mono">{error}</div>}

      <MixRoutingSection nativeChannels={activeChannels} isOpen={isOpen} />

      <div className="flex flex-col gap-1 mt-3 pt-3 border-t border-white/10">
        <div className="text-[10px] uppercase tracking-widest text-white/55">test tone (440 hz)</div>
        <div className="text-[10px] text-white/40">click a channel number to fire a sine on it — verifies the physical routing on a new interface.</div>
        <div className="flex flex-wrap gap-1 mt-1">
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

// Mix routing — multi-out + FX bus output + FX bypass. Multi-out OFF
// is the default headphone-monitor mode where everything (per-track
// outputs + FX bus) folds to channels 1-2. Multi-out ON honors per-
// track output assignments and routes the FX wet bus to a dedicated
// channel pair (or mono channel) for stem capture / FOH split.
function MixRoutingSection({
  nativeChannels,
  isOpen,
}: {
  nativeChannels: number;
  isOpen: boolean;
}) {
  const mix = useSequencerStore((s) => s.nativeMix);
  const setNativeMix = useSequencerStore((s) => s.setNativeMix);
  return (
    <div className="flex flex-col gap-2 mt-3 pt-3 border-t border-white/10">
      <div className="text-[10px] uppercase tracking-widest text-white/55">mix routing</div>
      <div className="text-[10px] text-white/40">
        multi-out OFF folds everything to 1-2. ON honors per-track outputs (in the row settings) + the FX bus channel below.
      </div>
      <div className="flex items-center gap-3 mt-1">
        <button
          type="button"
          onClick={() => setNativeMix({ multiOut: !mix.multiOut })}
          className={
            mix.multiOut
              ? 'px-3 py-1 text-[10px] uppercase tracking-widest border border-white text-white bg-white/10'
              : 'px-3 py-1 text-[10px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
          }
        >
          multi-out {mix.multiOut ? '● on' : '○ off'}
        </button>
        <button
          type="button"
          onClick={() => setNativeMix({ fxBypass: !mix.fxBypass })}
          // Pedal-style bypass: default state is dim/dark (FX bus on),
          // engaging the toggle brightens it to indicate the bypass is
          // active (FX bus off). The label changes to explicitly read
          // BYPASSED so it doesn't visually conflict with multi-out's
          // bright=on semantics — both buttons are bright but the
          // labels make their meanings unambiguous.
          className={
            mix.fxBypass
              ? 'px-3 py-1 text-[10px] uppercase tracking-widest border border-white text-white bg-white/10'
              : 'px-3 py-1 text-[10px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
          }
          title="bypass the FX bus (currently just reverb). When bypassed, voices' wet contributions drop to zero and dry passes through at full level."
        >
          {mix.fxBypass ? '● fx bus bypassed' : '○ fx bus'}
        </button>
      </div>
      <div className="flex flex-col gap-1 mt-2">
        <span className="text-[10px] uppercase tracking-widest text-white/55">fx output</span>
        <select
          value={`${mix.fxOutput.stereo ? 's' : 'm'}${mix.fxOutput.firstChannel}`}
          onChange={(e) => {
            const v = e.target.value;
            const stereo = v.startsWith('s');
            const firstChannel = parseInt(v.slice(1), 10);
            if (!Number.isFinite(firstChannel)) return;
            setNativeMix({ fxOutput: { firstChannel, stereo } });
          }}
          disabled={!isOpen || !mix.multiOut}
          className="w-full bg-transparent border border-white/15 text-white/90 text-[12px] px-2 py-1 disabled:text-white/30"
          title={
            !mix.multiOut
              ? 'multi-out is OFF — FX bus folds to 1-2 regardless of this setting.'
              : 'where the reverb wet bus lands when multi-out is ON.'
          }
        >
          {outputOptions(nativeChannels, mix.fxOutput).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Mirrors the helper in RowPanel.tsx — stereo pairs first, mono
// channels after, with the saved value pinned at the top if it falls
// outside the active device's channel count.
function outputOptions(
  channels: number,
  current: TrackOutput,
): Array<{ value: string; label: string }> {
  const opts: Array<{ value: string; label: string }> = [];
  for (let i = 0; i + 1 < channels; i += 2) {
    opts.push({ value: `s${i}`, label: `${i + 1}-${i + 2}` });
  }
  for (let i = 0; i < channels; i++) {
    opts.push({ value: `m${i}`, label: `${i + 1}` });
  }
  const currentValue = `${current.stereo ? 's' : 'm'}${current.firstChannel}`;
  if (!opts.some((o) => o.value === currentValue)) {
    opts.unshift({
      value: currentValue,
      label: current.stereo
        ? `${current.firstChannel + 1}-${current.firstChannel + 2}`
        : `${current.firstChannel + 1}`,
    });
  }
  return opts;
}
