// Native MIDI via midir (CoreMIDI on macOS). WKWebView ships without Web MIDI, so
// tools/rack/tauri.js wraps these four commands in a Web MIDI-shaped access object
// and the editor + drivers run unchanged. Adapted from sequencer/src-tauri/src/midi.rs,
// minus clock handling: edit never needs timing clock, so it's dropped at the source
// (a synth or pedal sending 24 PPQN would otherwise flood the IPC bridge).

use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const CLIENT_NAME: &str = "edit";

// CoreMIDI reports byte-identical names for two of the same device; midir's name
// is the only handle, so duplicates get " #2", " #3"… in enumeration order (same
// rule as Sequence, so a port reads the same in both apps).
fn dedup_names(names: Vec<String>) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    names
        .into_iter()
        .map(|n| {
            let c = counts.entry(n.clone()).or_insert(0);
            *c += 1;
            if *c == 1 { n } else { format!("{n} #{c}") }
        })
        .collect()
}

fn input_port(m_in: &MidiInput, target: &str) -> Option<midir::MidiInputPort> {
    let ports = m_in.ports();
    let names = dedup_names(ports.iter().map(|p| m_in.port_name(p).unwrap_or_default()).collect());
    names.iter().position(|n| n == target).map(|i| ports[i].clone())
}

fn output_port(m_out: &MidiOutput, target: &str) -> Option<midir::MidiOutputPort> {
    let ports = m_out.ports();
    let names = dedup_names(ports.iter().map(|p| m_out.port_name(p).unwrap_or_default()).collect());
    names.iter().position(|n| n == target).map(|i| ports[i].clone())
}

#[derive(Default)]
pub struct MidiRegistry {
    inputs: Mutex<HashMap<String, MidiInputConnection<()>>>,
    outputs: Mutex<HashMap<String, MidiOutputConnection>>,
}

#[derive(Serialize)]
pub struct MidiPorts {
    inputs: Vec<String>,
    outputs: Vec<String>,
}

#[derive(Serialize, Clone)]
struct MidiMessageEvent {
    port: String,
    bytes: Vec<u8>,
}

#[tauri::command]
pub fn midi_list_ports() -> Result<MidiPorts, String> {
    let m_in = MidiInput::new(CLIENT_NAME).map_err(|e| format!("MidiInput::new: {e}"))?;
    let inputs = dedup_names(m_in.ports().iter().map(|p| m_in.port_name(p).unwrap_or_default()).collect());
    let m_out = MidiOutput::new(CLIENT_NAME).map_err(|e| format!("MidiOutput::new: {e}"))?;
    let outputs = dedup_names(m_out.ports().iter().map(|p| m_out.port_name(p).unwrap_or_default()).collect());
    Ok(MidiPorts { inputs, outputs })
}

// Raw packets go to JS as-is (tauri.js reassembles SysEx and splits packed messages).
#[tauri::command]
pub fn midi_subscribe_input(app: AppHandle, state: State<MidiRegistry>, port_name: String) -> Result<(), String> {
    if state.inputs.lock().map_err(|e| format!("lock: {e}"))?.contains_key(&port_name) {
        return Ok(());
    }
    let mut m_in = MidiInput::new(CLIENT_NAME).map_err(|e| format!("MidiInput::new: {e}"))?;
    m_in.ignore(Ignore::TimeAndActiveSense);
    let port = input_port(&m_in, &port_name).ok_or_else(|| format!("input port not found: {port_name}"))?;
    let cb_port = port_name.clone();
    let conn = m_in
        .connect(
            &port,
            "edit input",
            move |_ts, msg, _| {
                // belt and braces: strip any clock bytes midir let through mid-packet
                let bytes: Vec<u8> = msg.iter().copied().filter(|&b| b != 0xF8 && b != 0xFE).collect();
                if !bytes.is_empty() {
                    let _ = app.emit("midi://message", MidiMessageEvent { port: cb_port.clone(), bytes });
                }
            },
            (),
        )
        .map_err(|e| format!("connect: {e}"))?;
    state.inputs.lock().map_err(|e| format!("lock: {e}"))?.insert(port_name, conn);
    Ok(())
}

#[tauri::command]
pub fn midi_unsubscribe_input(state: State<MidiRegistry>, port_name: String) -> Result<(), String> {
    state.inputs.lock().map_err(|e| format!("lock: {e}"))?.remove(&port_name);
    Ok(())
}

#[tauri::command]
pub fn midi_send(state: State<MidiRegistry>, port_name: String, bytes: Vec<u8>) -> Result<(), String> {
    let mut outputs = state.outputs.lock().map_err(|e| format!("lock: {e}"))?;
    if !outputs.contains_key(&port_name) {
        let m_out = MidiOutput::new(CLIENT_NAME).map_err(|e| format!("MidiOutput::new: {e}"))?;
        let port = output_port(&m_out, &port_name).ok_or_else(|| format!("output port not found: {port_name}"))?;
        let conn = m_out.connect(&port, "edit output").map_err(|e| format!("connect: {e}"))?;
        outputs.insert(port_name.clone(), conn);
    }
    let conn = outputs.get_mut(&port_name).unwrap();
    if let Err(e) = conn.send(&bytes) {
        // a replugged interface invalidates the cached connection: reopen next time
        outputs.remove(&port_name);
        return Err(format!("send: {e}"));
    }
    Ok(())
}
