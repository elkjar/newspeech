// .seq project file I/O. The user picks a path via tauri-plugin-dialog on
// the JS side and passes it to these commands. We bypass tauri-plugin-fs's
// per-path scope system by reading/writing through std::fs — the dialog
// already constitutes user consent for the chosen path.

use std::fs;

#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("write {path}: {e}"))
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}
