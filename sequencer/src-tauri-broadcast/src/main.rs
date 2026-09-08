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
      if let Some(window) = app.get_webview_window("main") {
        sequence_lib::install_media_permission(&window);
        // Frameless (no title bar — `decorations: false`), so the window IS
        // the picture: 16:9 whatever size it's dragged to, exactly 1920×1080
        // at launch, and a windowed capture is a clean frame. Our menubar is
        // the drag handle (data-tauri-drag-region).
        let _ = window.set_size(tauri::LogicalSize::new(1920.0, 1080.0));
        sequence_lib::lock_content_aspect(&window, 16.0, 9.0);
      }
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
