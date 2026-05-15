// .seq project file I/O. The user picks a path via tauri-plugin-dialog on
// the JS side and passes it to these commands. We bypass tauri-plugin-fs's
// per-path scope system by reading/writing through std::fs — the dialog
// already constitutes user consent for the chosen path.

use std::fs;
use std::process::Command;

use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("write {path}: {e}"))
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

#[tauri::command]
pub fn get_recordings_dir(app: AppHandle) -> Result<String, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("document_dir: {e}"))?;
    let dir = docs.join("newspeech-recordings");
    // Best-effort create — harmless if it already exists.
    let _ = fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    // macOS: `open <path>` reveals the directory in Finder. Same shell
    // spawn on Linux (xdg-open) / Windows (explorer) is straightforward
    // to add later; we're Tauri-on-macOS-only for now.
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open {path}: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("reveal_in_finder not implemented on this platform".to_string())
    }
}
