// Replug check for the native MIDI path, mirroring midi.rs + tauri.js: the output
// connection is cached and only reopened when a send errors; the input is dropped
// when its port leaves the 2 s port poll and reconnected when it comes back. With
// a loopback cable on the port, a ping goes out every 250 ms — unplug and replug
// the interface's USB mid-run and watch whether pings come back afterwards.
// Run: cargo run --example replug -- "micro lite Port 5" 60
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

fn has_port(name: &str) -> bool {
    let m = MidiInput::new("edit-replug-list").unwrap();
    m.ports().iter().any(|p| m.port_name(p).ok().as_deref() == Some(name))
}

fn open_in(name: &str, got: Arc<AtomicU32>) -> Option<MidiInputConnection<()>> {
    let mut m = MidiInput::new("edit-replug").ok()?;
    m.ignore(Ignore::TimeAndActiveSense);
    let p = m.ports().into_iter().find(|p| m.port_name(p).ok().as_deref() == Some(name))?;
    m.connect(&p, "in", move |_, msg, _| { if msg.len() == 3 && msg[0] == 0xB1 { got.store(msg[2] as u32 + 1, Ordering::SeqCst); } }, ()).ok()
}

fn open_out(name: &str) -> Option<MidiOutputConnection> {
    let m = MidiOutput::new("edit-replug").ok()?;
    let p = m.ports().into_iter().find(|p| m.port_name(p).ok().as_deref() == Some(name))?;
    m.connect(&p, "out").ok()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let name = args.get(1).cloned().unwrap_or("micro lite Port 5".into());
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    let got = Arc::new(AtomicU32::new(0));
    let mut input = open_in(&name, got.clone());
    let mut output: Option<MidiOutputConnection> = None;
    let t0 = Instant::now();
    let mut last_poll = Instant::now();
    let (mut seq, mut ok, mut lost) = (0u8, 0u32, 0u32);
    let mut was_ok = true;
    println!("{:>6} start (input {})", 0, if input.is_some() { "open" } else { "missing" });
    while t0.elapsed() < Duration::from_secs(secs) {
        let t = t0.elapsed().as_millis();
        if last_poll.elapsed() >= Duration::from_secs(2) {
            last_poll = Instant::now();
            let present = has_port(&name);
            if !present && input.is_some() { input = None; println!("{t:>6} port gone → input dropped"); }
            if present && input.is_none() { input = open_in(&name, got.clone()); println!("{t:>6} port back → input {}", if input.is_some() { "reopened" } else { "reopen FAILED" }); }
        }
        seq = (seq + 1) % 100;
        got.store(0, Ordering::SeqCst);
        if output.is_none() { output = open_out(&name); if output.is_some() && t > 0 { println!("{t:>6} output (re)opened"); } }
        if let Some(c) = output.as_mut() {
            if let Err(e) = c.send(&[0xB1, 21, seq]) { println!("{t:>6} send error: {e} → drop cached output"); output = None; }
        }
        sleep(Duration::from_millis(250));
        let back = got.load(Ordering::SeqCst) == seq as u32 + 1;
        if back { ok += 1 } else { lost += 1 }
        if back != was_ok { println!("{:>6} pings {}", t0.elapsed().as_millis(), if back { "RETURNING" } else { "not returning" }); was_ok = back; }
    }
    println!("done: {ok} returned, {lost} lost; ending state: {}", if was_ok { "WORKING" } else { "BROKEN" });
}
