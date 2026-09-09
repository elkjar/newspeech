// BROADCAST — the autonomous set player. A second binary over Sequence's
// engine crate: same audio engine, same command surface, no editor, no
// updater. The frontend entry is broadcast.html (src/broadcast/). See
// sequencer/docs/broadcast-set.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Which picture a display gets: (4, 3) below CRT_ASPECT_MAX (a 4:3 CRT is
// 1.33, 5:4 is 1.25), else (16, 9). A MacBook is 3:2 (1.54) and stays 16:9.
// Mirrors `formatFor` in src/broadcast/os/layout.ts — keep the threshold in
// step.
const CRT_ASPECT_MAX: f64 = 1.45;
fn aspect_class(mon: &tauri::Monitor) -> (u32, u32) {
  let s = mon.size();
  let r = s.width as f64 / s.height.max(1) as f64;
  if r < CRT_ASPECT_MAX { (4, 3) } else { (16, 9) }
}

// Size the window for a display: the format's full size (1920×1080 or
// 1440×1080) where it fits the work area, else the largest of that aspect
// inside it; centred in the work area (`center()` uses the whole screen and
// would tuck the bottom behind the Dock); content aspect locked so a drag
// keeps the picture.
fn fit_to_monitor(window: &tauri::WebviewWindow, mon: &tauri::Monitor) {
  let (ax_, ay_) = aspect_class(mon);
  let (aw_, ah_) = (ax_ as f64, ay_ as f64);
  let k = mon.scale_factor();
  let area = mon.work_area();
  // Work area = screen minus menu bar and Dock, in physical px.
  let (ax, ay) = (area.position.x as f64 / k, area.position.y as f64 / k);
  let (aw, ah) = (area.size.width as f64 / k, area.size.height as f64 / k);
  let (mut w, mut h) = (1080.0 * aw_ / ah_, 1080.0_f64);
  if aw - 24.0 < w || ah - 24.0 < h {
    w = (aw - 24.0).min((ah - 24.0) * aw_ / ah_).floor();
    h = (w * ah_ / aw_).floor();
  }
  let _ = window.set_size(tauri::LogicalSize::new(w, h));
  let _ = window.set_position(tauri::LogicalPosition::new(ax + ((aw - w) / 2.0).floor(), ay + ((ah - h) / 2.0).floor()));
  sequence_lib::lock_content_aspect(window, aw_, ah_);
  log::info!(
    "[window] monitor {}x{} @{k} work area {aw}x{ah} at {ax},{ay} → {ax_}:{ay_} {w}x{h}",
    mon.size().width as f64 / k,
    mon.size().height as f64 / k
  );
}

fn main() {
  use tauri::Manager;

  sequence_lib::shared_builder()
    .setup(|app| {
      #[cfg(target_os = "macos")]
      sequence_lib::set_dock_icon_bytes(include_bytes!("../icons/icon.png"));
      // Log always — an unattended box needs a trail. Dev: stdout (the
      // terminal). Release: ~/Library/Logs/com.newspeechsound.broadcast/
      // broadcast.log, rotated at 8 MB, old files kept.
      {
        use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
        let mut b = tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .max_file_size(8 * 1024 * 1024)
          .rotation_strategy(RotationStrategy::KeepAll)
          .clear_targets();
        b = if cfg!(debug_assertions) {
          b.target(Target::new(TargetKind::Stdout))
        } else {
          b.target(Target::new(TargetKind::LogDir { file_name: Some("broadcast".into()) }))
        };
        app.handle().plugin(b.build())?;
      }
      if let Some(window) = app.get_webview_window("main") {
        sequence_lib::install_media_permission(&window);
        // Frameless (no title bar — `decorations: false`), so the window IS
        // the picture: a clean frame for a windowed capture. Its aspect
        // follows the display it is on (Chris 2026-09-09: "the CRT thing
        // would just be swapping from 16:9 to 4:3 … the way sequence
        // detected the size of the external display would be great to
        // match"): a 16:9 / 3:2 / 16:10 screen → 16:9 at 1920×1080 where it
        // fits, else the largest 16:9 inside the work area; a 4:3 (or 5:4)
        // screen — the CRT in the analog chain — → 4:3 at 1440×1080 or the
        // largest 4:3 that fits. The frontend reads the window's aspect and
        // swaps its picture (layout.ts). Re-fitted when the window is
        // dragged onto a display of the other class. Our menubar is the drag
        // handle (data-tauri-drag-region).
        match window.current_monitor() {
          Ok(Some(mon)) => fit_to_monitor(&window, &mon),
          _ => {
            let _ = window.set_size(tauri::LogicalSize::new(1920.0, 1080.0));
            let _ = window.center();
            sequence_lib::lock_content_aspect(&window, 16.0, 9.0);
          }
        }
        // `d` in the frontend: hop to the next display and re-fit there —
        // a frameless window on a display with the menubar collapsed
        // (standby) has nothing to drag by, and the CRT is another display.
        {
          use tauri::Listener;
          let w3 = window.clone();
          window.listen("broadcast:cycle-display", move |_| {
            let w4 = w3.clone();
            let _ = w3.run_on_main_thread(move || {
              let Ok(monitors) = w4.available_monitors() else { return };
              if monitors.len() < 2 {
                return;
              }
              let cur = w4.current_monitor().ok().flatten();
              let idx = cur
                .as_ref()
                .and_then(|c| monitors.iter().position(|m| m.position() == c.position()))
                .unwrap_or(0);
              let next = &monitors[(idx + 1) % monitors.len()];
              if w4.is_fullscreen().unwrap_or(false) {
                let _ = w4.set_fullscreen(false);
              }
              log::info!("[window] next display → {}", next.name().map(|n| n.as_str()).unwrap_or("?"));
              fit_to_monitor(&w4, next);
            });
          });
        }
        let last = std::sync::Mutex::new(window.current_monitor().ok().flatten().map(|m| aspect_class(&m)));
        let w2 = window.clone();
        window.on_window_event(move |ev| {
          if let tauri::WindowEvent::Moved(_) = ev {
            if w2.is_fullscreen().unwrap_or(false) {
              return;
            }
            if let Ok(Some(mon)) = w2.current_monitor() {
              let class = aspect_class(&mon);
              let mut guard = last.lock().unwrap();
              if *guard != Some(class) {
                *guard = Some(class);
                fit_to_monitor(&w2, &mon);
              }
            }
          }
        });
      }
      sequence_lib::spawn_level_emitter(app.handle().clone());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building BROADCAST")
    .run(|app_handle, event| {
      // Finder open of a .seqset / folder → PendingOpenFiles → the frontend
      // drains it into the set loader.
      sequence_lib::buffer_opened_files(app_handle, &event);
      if let tauri::RunEvent::Exit = &event {
        // Fade to silence before the stream dies — no click on quit.
        sequence_lib::audio::audio_exit_cleanup();
        sequence_lib::midi_exit_cleanup(app_handle);
      }
    });
}
