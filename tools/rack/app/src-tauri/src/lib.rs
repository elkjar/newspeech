// edit.app: the rack editor (tools/rack) in a window, with native MIDI (midi.rs)
// and its files in Dropbox __RACK (rack.rs). The page itself is the same one the
// website serves; tools/rack/tauri.js switches it to these commands.

mod midi;
mod rack;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

// Releases ride a rolling "edit-latest" GitHub prerelease (Sequence owns
// releases/latest). Ask before installing; a failed check just stays quiet.
fn check_for_update(app: tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        let Ok(Some(update)) = updater.check().await else { return };
        let (tx, rx) = std::sync::mpsc::channel();
        app.dialog()
            .message(format!("edit {} is out (this is {}). Install it and restart?", update.version, update.current_version))
            .title("update")
            .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
            .show(move |ok| {
                let _ = tx.send(ok);
            });
        let ok = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false)).await.unwrap_or(false);
        if ok && update.download_and_install(|_, _| {}, || {}).await.is_ok() {
            app.restart();
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(midi::MidiRegistry::default())
        .invoke_handler(tauri::generate_handler![
            midi::midi_list_ports,
            midi::midi_subscribe_input,
            midi::midi_unsubscribe_input,
            midi::midi_send,
            rack::rack_root,
            rack::rack_pick_root,
            rack::rack_list_backups,
            rack::rack_save_backup,
            rack::rack_save_slot_backup,
            rack::rack_read_library,
            rack::rack_write_library,
        ])
        .setup(|app| {
            check_for_update(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running edit");
}
