// BROADCAST — the autonomous set player. A second binary over Sequence's
// engine crate: same audio engine, same command surface, no editor, no
// updater. The frontend entry is broadcast.html (src/broadcast/). See
// sequencer/docs/broadcast-set.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        // the picture: 16:9 whatever size it's dragged to, and a windowed
        // capture is a clean frame. Launch at 1920×1080 where it fits; on a
        // smaller screen (a laptop) the largest 16:9 inside the work area
        // (the frontend scales its fixed stage to the window). Our menubar
        // is the drag handle (data-tauri-drag-region).
        let (mut w, mut h) = (1920.0_f64, 1080.0_f64);
        match window.current_monitor() {
          Ok(Some(mon)) => {
            let k = mon.scale_factor();
            let area = mon.work_area();
            // Work area = screen minus menu bar and Dock, in physical px.
            let (ax, ay) = (area.position.x as f64 / k, area.position.y as f64 / k);
            let (aw, ah) = (area.size.width as f64 / k, area.size.height as f64 / k);
            if aw - 24.0 < w || ah - 24.0 < h {
              w = (aw - 24.0).min((ah - 24.0) * 16.0 / 9.0).floor();
              h = (w * 9.0 / 16.0).floor();
            }
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
            // Centre in the work area ourselves — `center()` uses the whole
            // screen and would tuck the bottom behind the Dock.
            let _ = window.set_position(tauri::LogicalPosition::new(ax + ((aw - w) / 2.0).floor(), ay + ((ah - h) / 2.0).floor()));
            log::info!(
              "[window] monitor {}x{} @{k} work area {aw}x{ah} at {ax},{ay} → {w}x{h}",
              mon.size().width as f64 / k,
              mon.size().height as f64 / k
            );
          }
          _ => {
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
            let _ = window.center();
          }
        }
        sequence_lib::lock_content_aspect(&window, 16.0, 9.0);
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
