// Native MIDI I/O via midir (CoreMIDI on macOS, ALSA/Jack on Linux, WinMM
// on Windows). The JS side branches on isTauri() and routes through these
// commands instead of navigator.requestMIDIAccess — WKWebView ships without
// Web MIDI exposed, so the in-Tauri webview can't use the browser API.
//
// Surface mirrors the Web MIDI shape so the existing midiIn / midiOut
// modules can swap implementations behind their stable exports.

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const CLIENT_NAME: &str = "Sequence";

// macOS CoreMIDI hands back byte-identical display names when two of the same
// device are connected (e.g. two Launchpad X units both report "Launchpad X
// LPX MIDI Out"). midir's port_name() is our only stable handle — it doesn't
// expose the CoreMIDI UID — so without disambiguation every find()-by-name
// resolves to the FIRST matching endpoint and the second device is
// unreachable. We append " #2", " #3", … to duplicates, in enumeration order,
// so each physical endpoint gets a unique key. The numbering is deterministic
// for a given port ordering, so list/subscribe/send all agree as long as they
// dedup the same ordered Vec — which they do, since midir returns ports in a
// consistent order within a process.
fn dedup_names(names: Vec<String>) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    names
        .into_iter()
        .map(|n| {
            let c = counts.entry(n.clone()).or_insert(0);
            *c += 1;
            if *c == 1 {
                n
            } else {
                format!("{n} #{c}")
            }
        })
        .collect()
}

// Resolve a (possibly deduped) input port name back to its midir port handle.
// Rebuilds the same deduped name list over the current port ordering and
// matches by exact name, so a "Foo #2" target lands on the second "Foo".
fn resolve_input_port(m_in: &MidiInput, target: &str) -> Option<midir::MidiInputPort> {
    let ports = m_in.ports();
    let raw: Vec<String> = ports
        .iter()
        .map(|p| m_in.port_name(p).unwrap_or_default())
        .collect();
    dedup_names(raw)
        .iter()
        .position(|n| n == target)
        .map(|i| ports[i].clone())
}

fn resolve_output_port(m_out: &MidiOutput, target: &str) -> Option<midir::MidiOutputPort> {
    let ports = m_out.ports();
    let raw: Vec<String> = ports
        .iter()
        .map(|p| m_out.port_name(p).unwrap_or_default())
        .collect();
    dedup_names(raw)
        .iter()
        .position(|n| n == target)
        .map(|i| ports[i].clone())
}

#[derive(Default)]
pub struct MidiRegistry {
    pub inputs: Mutex<HashMap<String, MidiInputConnection<()>>>,
    pub outputs: Mutex<HashMap<String, MidiOutputConnection>>,
}

#[derive(Serialize)]
pub struct MidiPorts {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct MidiMessageEvent {
    pub port: String,
    pub bytes: Vec<u8>,
}

// MIDI clock (0xF8) arrives at ~48/sec per port. Emitting each pulse as its own
// `midi://message` event saturates the Tauri IPC channel and roughly half are
// dropped under main-thread load — fatal for tempo timing. Instead we count
// pulses on the Rust side and emit a throttled `midi://clock` tick carrying the
// cumulative count + the hardware timestamp. The JS follower derives tempo from
// (Δcount / Δtime), so dropped ticks don't corrupt the estimate (the count
// accounts for every pulse that elapsed), and the hardware timestamp avoids
// WebView receipt jitter. Transport bytes (start/stop/continue) are rare and
// still flow through `midi://message`.
#[derive(Serialize, Clone)]
pub struct ClockTickEvent {
    pub port: String,
    pub count: u64,
    // Hardware timestamp in microseconds (midir's callback timestamp). Only
    // deltas are meaningful — the epoch is platform-dependent.
    pub micros: u64,
}

// Emit one tick per N pulses (N=6 → ~8/sec at 120 BPM): low enough that IPC
// never sheds it, dense enough to lock within a beat. 6 divides 24 (PPQN) so
// ticks land on clean 16th-note boundaries.
const CLOCK_EMIT_EVERY: u64 = 6;

#[tauri::command]
pub fn midi_list_ports() -> Result<MidiPorts, String> {
    let m_in = MidiInput::new(CLIENT_NAME).map_err(|e| format!("MidiInput::new: {e}"))?;
    let in_ports = m_in.ports();
    // unwrap_or_default (not filter_map) keeps the Vec index-aligned with
    // ports() so resolve_input_port's dedup reproduces the same numbering.
    let inputs = dedup_names(
        in_ports
            .iter()
            .map(|p| m_in.port_name(p).unwrap_or_default())
            .collect(),
    );

    let m_out = MidiOutput::new(CLIENT_NAME).map_err(|e| format!("MidiOutput::new: {e}"))?;
    let out_ports = m_out.ports();
    let outputs = dedup_names(
        out_ports
            .iter()
            .map(|p| m_out.port_name(p).unwrap_or_default())
            .collect(),
    );
    Ok(MidiPorts { inputs, outputs })
}

#[tauri::command]
pub fn midi_subscribe_input(
    app: AppHandle,
    state: State<MidiRegistry>,
    port_name: String,
) -> Result<(), String> {
    {
        let inputs = state.inputs.lock().map_err(|e| format!("lock: {e}"))?;
        if inputs.contains_key(&port_name) {
            return Ok(());
        }
    }
    let mut m_in =
        MidiInput::new(CLIENT_NAME).map_err(|e| format!("MidiInput::new: {e}"))?;
    // Allow SysEx through (Launchpad X may respond to layout/state queries via
    // SysEx) and timing clock through (external-clock follow — clockFollow.ts
    // reads 0xF8/0xFA/0xFB/0xFC). Still drop active-sense — pure noise for us.
    m_in.ignore(Ignore::ActiveSense);
    let port = resolve_input_port(&m_in, &port_name)
        .ok_or_else(|| format!("input port not found: {port_name}"))?;
    let cb_port = port_name.clone();
    // Per-connection clock-pulse counter — the connect callback is FnMut, so it
    // owns this across invocations without any shared state. Survives dropped
    // IPC ticks because JS reads cumulative count deltas, not per-tick presence.
    let mut clock_count: u64 = 0;
    // Stamp ticks from a Rust-owned monotonic clock, not midir's callback
    // timestamp: that timestamp's units are platform-dependent (raw mach ticks
    // on Apple Silicon, not microseconds), which corrupts the JS tempo math.
    // Instant elapsed is unambiguous microseconds.
    let clock_start = Instant::now();
    let conn = m_in
        .connect(
            &port,
            "Sequence input",
            move |_ts, msg, _| {
                // CoreMIDI packs several MIDI messages into one packet and
                // midir hands the whole buffer here, so a single callback can
                // carry MANY 0xF8 clock bytes (and clock can be interleaved
                // inside other messages). Count every clock byte — not just
                // single-byte packets — or most pulses go missing at speed.
                let clock_pulses = msg.iter().filter(|&&b| b == 0xF8).count() as u64;
                if clock_pulses > 0 {
                    let prev = clock_count;
                    clock_count = clock_count.wrapping_add(clock_pulses);
                    // Emit once if this buffer crossed a throttle boundary, so
                    // the tick rate stays ~CLOCK_EMIT_EVERY-spaced regardless of
                    // how the pulses clump per packet.
                    if clock_count / CLOCK_EMIT_EVERY != prev / CLOCK_EMIT_EVERY {
                        let _ = app.emit(
                            "midi://clock",
                            ClockTickEvent {
                                port: cb_port.clone(),
                                count: clock_count,
                                micros: clock_start.elapsed().as_micros() as u64,
                            },
                        );
                    }
                }
                // Forward the non-clock remainder (stripping 0xF8 is correct —
                // realtime bytes may interrupt a running message). Skip the emit
                // entirely when the buffer was clock-only.
                let rest: Vec<u8> = msg.iter().copied().filter(|&b| b != 0xF8).collect();
                if !rest.is_empty() {
                    let _ = app.emit(
                        "midi://message",
                        MidiMessageEvent {
                            port: cb_port.clone(),
                            bytes: rest,
                        },
                    );
                }
            },
            (),
        )
        .map_err(|e| format!("connect: {e}"))?;
    state
        .inputs
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .insert(port_name, conn);
    Ok(())
}

#[tauri::command]
pub fn midi_unsubscribe_all_inputs(state: State<MidiRegistry>) -> Result<(), String> {
    let mut inputs = state.inputs.lock().map_err(|e| format!("lock: {e}"))?;
    inputs.clear();
    Ok(())
}

#[tauri::command]
pub fn midi_unsubscribe_input(
    state: State<MidiRegistry>,
    port_name: String,
) -> Result<(), String> {
    // Drop a single cached input connection. Called by the JS-side port poll
    // when a previously-subscribed port disappears from the system list —
    // without this, `midi_subscribe_input`'s `contains_key` early-return
    // would block re-subscription on replug.
    let mut inputs = state.inputs.lock().map_err(|e| format!("lock: {e}"))?;
    inputs.remove(&port_name);
    Ok(())
}

#[tauri::command]
pub fn midi_send(
    state: State<MidiRegistry>,
    port_name: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let mut outputs = state.outputs.lock().map_err(|e| format!("lock: {e}"))?;
    if !outputs.contains_key(&port_name) {
        let m_out =
            MidiOutput::new(CLIENT_NAME).map_err(|e| format!("MidiOutput::new: {e}"))?;
        let port = resolve_output_port(&m_out, &port_name)
            .ok_or_else(|| format!("output port not found: {port_name}"))?;
        let conn = m_out
            .connect(&port, "Sequence output")
            .map_err(|e| format!("connect: {e}"))?;
        outputs.insert(port_name.clone(), conn);
    }
    let conn = outputs.get_mut(&port_name).unwrap();
    if let Err(e) = conn.send(&bytes) {
        // Drop cached connection on send failure so the next call reopens.
        outputs.remove(&port_name);
        return Err(format!("send: {e}"));
    }
    Ok(())
}

// Send All Notes Off (CC 123) on all 16 channels to every open output. Best-
// effort + infallible so it can run both from the `midi_panic` command (panic
// button / transport stop) and from the app-quit hook in lib.rs, which flushes
// this before CoreMIDI tears down so notes left on external gear don't hang.
pub fn panic_all(registry: &MidiRegistry) {
    let Ok(mut outputs) = registry.outputs.lock() else {
        return;
    };
    for conn in outputs.values_mut() {
        for ch in 0u8..16 {
            let _ = conn.send(&[0xB0 | ch, 123, 0]); // All Notes Off
        }
    }
}

#[tauri::command]
pub fn midi_panic(state: State<MidiRegistry>) -> Result<(), String> {
    panic_all(state.inner());
    Ok(())
}

// ---------------------------------------------------------------------------
// MIDI clock master
//
// Sequence is the rig clock master. The clock pulse stream (24 PPQN) lives on
// a dedicated native thread rather than being scheduled from JS, because the
// WebView's setTimeout is far too coarse/jittery for a 24-PPQN stream — Pam's
// New Workout (and any PLL) reads that jitter as an unstable tempo. The thread
// owns its OWN output connection to the target port (independent of the
// per-note connections in MidiRegistry — CoreMIDI allows multiple senders to
// one destination), so note traffic and clock never contend.
//
// JS only sets tempo + start/stop; the thread does the timing, anchoring each
// tick to a monotonic Instant and busy-spinning the final stretch so spacing
// stays sub-millisecond regardless of event-loop load.

const PPQN: f64 = 24.0;

pub struct ClockState {
    running: Arc<AtomicBool>,
    // bpm × 1000, so tempo updates are a lock-free atomic store the thread
    // re-reads every tick (mid-stream tempo changes apply going forward).
    bpm_milli: Arc<AtomicU32>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl Default for ClockState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            bpm_milli: Arc::new(AtomicU32::new(120_000)),
            handle: Mutex::new(None),
        }
    }
}

fn pulse_interval(bpm_milli: u32) -> Duration {
    let bpm = (bpm_milli as f64 / 1000.0).max(1.0);
    Duration::from_secs_f64(60.0 / bpm / PPQN)
}

// Wait until `target`: sleep most of the way (cheap), then busy-spin the last
// ~1ms (tight). The spin burns a sliver of one core per pulse but keeps the
// pulse landing within tens of microseconds of its target — which is the whole
// point of moving the clock off the JS timer.
fn precise_wait_until(target: Instant) {
    loop {
        let now = Instant::now();
        if now >= target {
            return;
        }
        let remaining = target - now;
        if remaining > Duration::from_micros(1500) {
            thread::sleep(remaining - Duration::from_micros(1000));
        } else {
            std::hint::spin_loop();
        }
    }
}

// Stop a running clock thread (send Stop + join). Shared by the stop command
// and the app-quit hook. Safe to call when nothing is running.
pub fn clock_stop_blocking(clock: &ClockState) {
    clock.running.store(false, Ordering::Relaxed);
    if let Ok(mut h) = clock.handle.lock() {
        if let Some(handle) = h.take() {
            let _ = handle.join();
        }
    }
}

#[tauri::command]
pub fn midi_clock_start(
    clock: State<ClockState>,
    port_names: Vec<String>,
    bpm: f64,
) -> Result<(), String> {
    clock
        .bpm_milli
        .store((bpm.max(1.0) * 1000.0) as u32, Ordering::Relaxed);
    // Restart cleanly if already running (e.g. ports changed mid-session).
    clock_stop_blocking(clock.inner());

    let running = clock.running.clone();
    let bpm_milli = clock.bpm_milli.clone();
    running.store(true, Ordering::Relaxed);

    let handle = thread::Builder::new()
        .name("midi-clock".into())
        .spawn(move || {
            // One connection per destination — the same pulse stream is
            // broadcast to all (e.g. Mutant Brain + Bluebox). midir's connect()
            // consumes the MidiOutput, so each port needs its own MidiOutput.
            let mut conns = Vec::new();
            for name in &port_names {
                let Ok(m_out) = MidiOutput::new(CLIENT_NAME) else {
                    continue;
                };
                let Some(port) = resolve_output_port(&m_out, name) else {
                    continue;
                };
                if let Ok(c) = m_out.connect(&port, "Sequence clock") {
                    conns.push(c);
                }
            }
            // No destination resolved (all unplugged / busy) — nothing to drive.
            if conns.is_empty() {
                running.store(false, Ordering::Relaxed);
                return;
            }
            // Start: followers reset to bar 1, then the pulse stream begins.
            for c in &mut conns {
                let _ = c.send(&[0xFA]);
            }
            let mut next = Instant::now() + pulse_interval(bpm_milli.load(Ordering::Relaxed));
            while running.load(Ordering::Relaxed) {
                precise_wait_until(next);
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                for c in &mut conns {
                    let _ = c.send(&[0xF8]);
                }
                let iv = pulse_interval(bpm_milli.load(Ordering::Relaxed));
                next += iv;
                // If we fell behind (system stall / huge tempo drop), resync to
                // now rather than firing a burst to "catch up".
                let now = Instant::now();
                if next < now {
                    next = now + iv;
                }
            }
            // Stop: followers freeze their playhead.
            for c in &mut conns {
                let _ = c.send(&[0xFC]);
            }
        })
        .map_err(|e| format!("clock thread spawn: {e}"))?;

    if let Ok(mut h) = clock.handle.lock() {
        *h = Some(handle);
    }
    Ok(())
}

#[tauri::command]
pub fn midi_clock_set_bpm(clock: State<ClockState>, bpm: f64) -> Result<(), String> {
    clock
        .bpm_milli
        .store((bpm.max(1.0) * 1000.0) as u32, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn midi_clock_stop(clock: State<ClockState>) -> Result<(), String> {
    clock_stop_blocking(clock.inner());
    Ok(())
}
