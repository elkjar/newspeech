import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { sendMIDIClockPulse, sendMIDIStart, sendMIDIStop } from './midiOut';

// MIDI clock-out: Sequence is the rig clock master. It emits the 24-PPQN pulse
// stream + Start/Stop on a single configured output port; everything
// downstream (Mutant Brain → Pam's New Workout → the rack, plus the Bitbox
// over its own analog clock patch) follows.
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

function clockPort(): string | null {
  return useSequencerStore.getState().midiClockOutPort;
}

// Web path only — emit this step's share of the pulse stream, each pulse
// scheduled at the precise audio time the scheduler handed us. No-op on native
// (the Rust thread owns the stream) and when no port is configured.
export function emitClockForStep(when: number, stepDuration: number): void {
  if (TAURI) return;
  const port = clockPort();
  if (!port) return;
  for (let k = 0; k < PULSES_PER_STEP; k++) {
    sendMIDIClockPulse(port, when + (stepDuration * k) / PULSES_PER_STEP);
  }
}

// Play: announce transport to followers and (native) spin up the clock thread.
export function clockTransportStart(): void {
  const port = clockPort();
  if (!port) return;
  if (TAURI) {
    const bpm = useSequencerStore.getState().bpm;
    void invoke('midi_clock_start', { portName: port, bpm }).catch((e) =>
      console.warn('[midiClock] start failed:', e),
    );
  } else {
    // Start fires here; the pulse stream flows from emitClockForStep.
    sendMIDIStart(port);
  }
}

// Stop: tear down the clock thread (native) — which sends MIDI Stop itself — or
// send Stop directly on web.
export function clockTransportStop(): void {
  if (TAURI) {
    void invoke('midi_clock_stop').catch((e) =>
      console.warn('[midiClock] stop failed:', e),
    );
  } else {
    const port = clockPort();
    if (port) sendMIDIStop(port);
  }
}

// Push tempo changes to the running native clock thread. No-op on web (the
// per-step emit already tracks tempo via the scheduler's stepDuration) and
// when no clock-out port is configured.
export function setClockBpm(bpm: number): void {
  if (!TAURI || !clockPort()) return;
  void invoke('midi_clock_set_bpm', { bpm }).catch(() => {});
}
