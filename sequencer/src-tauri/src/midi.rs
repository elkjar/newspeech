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
use std::sync::Mutex;
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
    // SysEx). Still drop timing + active-sense — those are noise for our use.
    m_in.ignore(Ignore::TimeAndActiveSense);
    let port = resolve_input_port(&m_in, &port_name)
        .ok_or_else(|| format!("input port not found: {port_name}"))?;
    let cb_port = port_name.clone();
    let conn = m_in
        .connect(
            &port,
            "Sequence input",
            move |_ts, msg, _| {
                let _ = app.emit(
                    "midi://message",
                    MidiMessageEvent {
                        port: cb_port.clone(),
                        bytes: msg.to_vec(),
                    },
                );
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

#[tauri::command]
pub fn midi_panic(state: State<MidiRegistry>) -> Result<(), String> {
    let mut outputs = state.outputs.lock().map_err(|e| format!("lock: {e}"))?;
    for conn in outputs.values_mut() {
        for ch in 0u8..16 {
            let _ = conn.send(&[0xB0 | ch, 123, 0]); // All Notes Off
        }
    }
    Ok(())
}
