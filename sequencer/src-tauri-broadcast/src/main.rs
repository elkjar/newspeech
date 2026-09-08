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
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
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
        sequence_lib::midi_exit_cleanup(app_handle);
      }
    });
}
