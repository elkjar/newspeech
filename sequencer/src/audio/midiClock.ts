import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { sendMIDIClockPulse, sendMIDIStart, sendMIDIStop } from './midiOut';

// MIDI clock-out: Sequence drives the rig clock. It emits the 24-PPQN pulse
// stream + Start/Stop to one or more configured output ports; everything
// downstream (Mutant Brain → Pam's New Workout → the rack, plus the Bitbox
// over its own analog clock patch) follows. A second destination — the
// Bluebox — rides the same Start so a pre-armed REC captures on the downbeat.
//
// This runs in BOTH sync modes. As clock master (internal) it's driven by local
// transport at the local tempo. As a follower (external) Sequence RELAYS: the
// same clock-out is driven by the external master's transport at the tracked
// tempo (regenerated clean off the native thread), so the rig stays in time with
// e.g. a Pro Tools session feeding Sequence. The relay never targets the
// clock-IN port (that would echo clock back to the master) — see clockDestPorts.
//
// Two emission paths, picked by environment:
//   • Native (Tauri): a dedicated Rust thread (see src-tauri/src/midi.rs)
//     generates the pulses off a monotonic timer. JS only sets tempo +
//     start/stop. This is the real path for music work — the WebView's
//     setTimeout is too jittery for a 24-PPQN stream and Pam's reads that
//     jitter as an unstable tempo.
//   • Web: Web MIDI's out.send(bytes, timestamp) delivers at a precise time,
//     so the per-step emit below is accurate enough without a worker thread.

const TAURI = isTauri();

// Web-only: the scheduler ticks at 1/32-note (stepsPerBeat 8 in scheduler.ts);
// 24 PPQN / 8 = 3 pulses per step, spread across the step's exact duration.
const PULSES_PER_STEP = 3;

// Destinations for the clock stream, with the clock-IN port excluded so a relay
// never feeds the master's own clock back to it. (In internal mode there's no
// in-port, so this is just the configured out-ports.)
function clockDestPorts(): string[] {
  const s = useSequencerStore.getState();
  const inPort = s.midiClockInPort;
  return s.midiClockOutPorts.filter((p) => p !== inPort);
}

// Web path only — emit this step's share of the pulse stream to every
// destination, each pulse scheduled at the precise audio time the scheduler
// handed us. No-op on native (the Rust thread owns the stream) and when no
// port is configured.
export function emitClockForStep(when: number, stepDuration: number): void {
  if (TAURI) return;
  const ports = clockDestPorts();
  if (!ports.length) return;
  for (const port of ports) {
    for (let k = 0; k < PULSES_PER_STEP; k++) {
      sendMIDIClockPulse(port, when + (stepDuration * k) / PULSES_PER_STEP);
    }
  }
}

// Native only: spin up (or re-assert) the free-running pulse thread on the
// destination ports. The 0xF8 stream then flows CONTINUOUSLY, independent of
// transport — like a hardware modular master — so clocked rack gear keeps its
// time base even while the sequencer is stopped. Idempotent: a call with the
// same port set is a no-op on the running stream (no gap, no re-trigger).
// Internal master: driven by an App.tsx effect on the clock-out ports. Follow
// relay: driven by startFollowPlayback at the tracked tempo. No-op on web (the
// per-step emit owns the stream there) and when no clock-out port is set.
export function clockEngineStart(): Promise<void> {
  if (!TAURI) return Promise.resolve();
  const ports = clockDestPorts();
  if (!ports.length) return Promise.resolve();
  const bpm = useSequencerStore.getState().bpm;
  return invoke<void>('midi_clock_start', { portNames: ports, bpm }).catch((e) =>
    console.warn('[midiClock] engine start failed:', e),
  );
}

// Native only: tear down the pulse thread. `sendStop` (default) flushes a final
// MIDI Stop to the rig on the way out — for handing transport to an external
// master, clearing the clock-out target, or quitting. A normal transport stop
// does NOT call this (the stream stays alive); it uses clockTransportStop.
export function clockEngineStop(sendStop = true): void {
  if (!TAURI) return;
  void invoke('midi_clock_stop', { sendStop }).catch((e) =>
    console.warn('[midiClock] engine stop failed:', e),
  );
}

// Play: announce Start to followers. Native rides 0xFA over the top of the
// free-running pulse stream (engine already running); web sends Start directly
// and the pulse stream flows from emitClockForStep while the scheduler ticks.
export function clockTransportStart(): void {
  const ports = clockDestPorts();
  if (!ports.length) return;
  if (TAURI) {
    // Ensure the free-running stream is up, THEN ride Start over it. Awaiting
    // the (idempotent) start guarantees the thread exists before the transport
    // byte lands — otherwise a first-play-after-config race drops the 0xFA.
    void clockEngineStart().then(() =>
      invoke('midi_clock_transport', { byte: 0xfa }).catch((e) =>
        console.warn('[midiClock] transport start failed:', e),
      ),
    );
  } else {
    for (const port of ports) sendMIDIStart(port);
  }
}

// Stop: announce Stop to followers. Native rides 0xFC over the top — the pulse
// stream KEEPS running so clocked gear holds its time base. Web has no
// free-running engine, so Stop goes out directly and the per-step pulse emit
// stops with the scheduler.
export function clockTransportStop(): void {
  if (TAURI) {
    void invoke('midi_clock_transport', { byte: 0xfc }).catch((e) =>
      console.warn('[midiClock] transport stop failed:', e),
    );
  } else {
    for (const port of clockDestPorts()) sendMIDIStop(port);
  }
}

// Push tempo changes to the running native clock thread. No-op on web (the
// per-step emit already tracks tempo via the scheduler's stepDuration) and
// when no clock-out port is configured.
export function setClockBpm(bpm: number): void {
  if (!TAURI || !clockDestPorts().length) return;
  void invoke('midi_clock_set_bpm', { bpm }).catch(() => {});
}
