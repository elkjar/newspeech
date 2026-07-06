// .seq project file I/O. The user picks a path via tauri-plugin-dialog on
// the JS side and passes it to these commands. We bypass tauri-plugin-fs's
// per-path scope system by reading/writing through std::fs — the dialog
// already constitutes user consent for the chosen path.

use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

// Mirror of the frontend's docDirty flag. RunEvent::ExitRequested must decide
// synchronously whether to hold a Cmd+Q for the unsaved-changes prompt — it
// can't await the webview — so the frontend pushes every dirty transition
// here via set_doc_dirty.
#[derive(Default)]
pub struct DocDirty(pub AtomicBool);

#[tauri::command]
pub fn set_doc_dirty(dirty: bool, state: tauri::State<'_, DocDirty>) {
    state.0.store(dirty, Ordering::Relaxed);
}

// The "actually quit" escape hatch for the unsaved-changes prompt: exit(0)
// re-enters ExitRequested with code Some(0), which bypasses the dirty check.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// Files macOS asked the app to open (.seq double-click / drop on the dock
// icon), delivered as RunEvent::Opened in lib.rs — possibly BEFORE the
// frontend has any listeners (cold launch: the open event races webview
// boot). lib.rs buffers the paths here and pings "open-files-pending"; the
// frontend drains via take_pending_open_files at boot and on every ping, so
// neither ordering drops or double-loads a file.
#[derive(Default)]
pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

#[tauri::command]
pub fn take_pending_open_files(
    state: tauri::State<'_, PendingOpenFiles>,
) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("write {path}: {e}"))
}


#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

// Absolute paths behind the most recent OS drag (macOS only). The window
// runs with `dragDropEnabled: false` so in-page pad-reorder DnD keeps
// working — file drops therefore arrive as HTML5 events, and HTML5 File
// objects never expose a filesystem path. The AppKit drag pasteboard still
// holds the dragged file URLs at drop time, so the JS drop handler calls
// this to learn where the dropped .seq lives and bind Cmd+S to it.
#[tauri::command]
pub fn drag_pasteboard_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL};
        use objc2_foundation::NSURL;

        let mut out = Vec::new();
        unsafe {
            let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
            if let Some(items) = pb.pasteboardItems() {
                for item in items.iter() {
                    let Some(s) = item.stringForType(NSPasteboardTypeFileURL) else {
                        continue;
                    };
                    let Some(url) = NSURL::URLWithString(&s) else {
                        continue;
                    };
                    if let Some(p) = url.path() {
                        out.push(p.to_string());
                    }
                }
            }
        }
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
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
