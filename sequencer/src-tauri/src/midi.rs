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
    let inputs: Vec<String> = in_ports
        .iter()
        .filter_map(|p| m_in.port_name(p).ok())
        .collect();

    let m_out = MidiOutput::new(CLIENT_NAME).map_err(|e| format!("MidiOutput::new: {e}"))?;
    let out_ports = m_out.ports();
    let outputs: Vec<String> = out_ports
        .iter()
        .filter_map(|p| m_out.port_name(p).ok())
        .collect();
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
    let ports = m_in.ports();
    let port = ports
        .iter()
        .find(|p| m_in.port_name(p).map(|n| n == port_name).unwrap_or(false))
        .ok_or_else(|| format!("input port not found: {port_name}"))?;
    let cb_port = port_name.clone();
    let conn = m_in
        .connect(
            port,
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
        let ports = m_out.ports();
        let port = ports
            .iter()
            .find(|p| m_out.port_name(p).map(|n| n == port_name).unwrap_or(false))
            .ok_or_else(|| format!("output port not found: {port_name}"))?;
        let conn = m_out
            .connect(port, "Sequence output")
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
