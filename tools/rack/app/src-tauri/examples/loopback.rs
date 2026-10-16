// Hardware loopback check for the native MIDI path (midi.rs): a DIN cable from an
// interface's OUT back into its own IN. Sends long SysEx, paced CCs, packed
// messages and realtime bytes, and records every input callback exactly as midir
// hands it over — tools/rack/app/loopback-check.mjs replays that through tauri.js's
// parser. Run: cargo run --example loopback -- "micro lite Port 5" out.json
use midir::{Ignore, MidiInput, MidiOutput};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

fn sysex(n: usize, seed: u8) -> Vec<u8> {
    let mut v = vec![0xF0];
    v.extend((0..n - 2).map(|i| ((i * 7 + seed as usize) & 0x7F) as u8));
    v.push(0xF7);
    v
}

// DIN runs at 3125 bytes/s; give each message its wire time plus slack
fn wire(n: usize) -> Duration { Duration::from_millis((n as u64 * 1000) / 3125 + 150) }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = args.get(1).cloned().unwrap_or("micro lite Port 5".into());
    let out_path = args.get(2).cloned().unwrap_or("loopback.json".into());

    let mut m_in = MidiInput::new("edit-loopback").unwrap();
    // same as midi.rs unless a 3rd arg asks otherwise ("none" = let everything through)
    let mode = args.get(3).cloned().unwrap_or_default();
    m_in.ignore(if mode == "none" { Ignore::None } else { Ignore::TimeAndActiveSense });
    let only_rt = args.get(4).map(|s| s == "rt").unwrap_or(false);
    let ip = m_in.ports().into_iter().find(|p| m_in.port_name(p).ok().as_deref() == Some(port.as_str())).expect("input port");
    let m_out = MidiOutput::new("edit-loopback").unwrap();
    let op = m_out.ports().into_iter().find(|p| m_out.port_name(p).ok().as_deref() == Some(port.as_str())).expect("output port");

    let t0 = Instant::now();
    let recv: Arc<Mutex<Vec<(u128, Vec<u8>)>>> = Arc::new(Mutex::new(vec![]));
    let r = recv.clone();
    let _in = m_in
        .connect(&ip, "in", move |_, msg, _| {
            // same filter as midi.rs, so the replay sees what the app's JS would
            let bytes: Vec<u8> = msg.iter().copied().filter(|&b| b != 0xF8 && b != 0xFE).collect();
            if !bytes.is_empty() { r.lock().unwrap().push((t0.elapsed().as_micros(), bytes)); }
        }, ())
        .unwrap();
    let mut out = m_out.connect(&op, "out").unwrap();

    let mut sent: Vec<(String, u128, Vec<u8>)> = vec![];
    let mut send = |label: &str, b: Vec<u8>, sent: &mut Vec<(String, u128, Vec<u8>)>| {
        let at = t0.elapsed().as_micros();
        if let Err(e) = out.send(&b) { eprintln!("{label}: send failed: {e}"); }
        sent.push((label.into(), at, b));
    };

    if !only_rt {
    // 1 long SysEx, PRO-800 patch size up to big bulk dumps
    for (i, n) in [193usize, 1024, 4096, 8192, 16384].iter().enumerate() {
        send(&format!("sysex{n}"), sysex(*n, i as u8), &mut sent);
        sleep(wire(*n));
    }
    // 2 paced CCs at 20 ms (the slow-synth gap), checked for order + spacing
    for i in 0..40u8 {
        send("paced", vec![0xB1, 20, i], &mut sent);
        sleep(Duration::from_millis(20));
    }
    sleep(Duration::from_millis(200));
    // 3 a burst with no gaps: SysEx, CC, SysEx, PC, running-status-free CCs
    send("burst", sysex(300, 9), &mut sent);
    send("burst", vec![0xB1, 7, 100], &mut sent);
    send("burst", sysex(300, 10), &mut sent);
    send("burst", vec![0xC1, 5], &mut sent);
    for i in 0..10u8 { send("burst", vec![0xB1, 74, i], &mut sent); }
    sleep(wire(700));
    }
    // 4 realtime bytes: alone, and inside a SysEx (legal on the wire)
    send("clock", vec![0xF8], &mut sent);
    send("sense", vec![0xFE], &mut sent);
    send("start", vec![0xFA], &mut sent);
    let mut rt = sysex(200, 11);
    rt.insert(100, 0xF8);
    send("sysex-rt", rt, &mut sent);
    sleep(wire(400));
    let mut fe = sysex(200, 12);
    fe.insert(50, 0xFE);
    send("sysex-fe", fe, &mut sent);
    sleep(wire(400));
    let mut fa = sysex(200, 13);
    fa.insert(150, 0xFA);
    send("sysex-fa", fa, &mut sent);
    sleep(wire(400));
    sleep(Duration::from_millis(500));

    let recv = recv.lock().unwrap();
    let j = serde_json::json!({
        "port": port,
        "sent": sent.iter().map(|(l, t, b)| serde_json::json!({"label": l, "t": t, "bytes": b})).collect::<Vec<_>>(),
        "recv": recv.iter().map(|(t, b)| serde_json::json!({"t": t, "bytes": b})).collect::<Vec<_>>(),
    });
    std::fs::write(&out_path, serde_json::to_string(&j).unwrap()).unwrap();
    let total: usize = recv.iter().map(|(_, b)| b.len()).sum();
    println!("{} callbacks, {} bytes → {out_path}", recv.len(), total);
}
