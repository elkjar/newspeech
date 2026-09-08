// .seq project file I/O. The user picks a path via tauri-plugin-dialog on
// the JS side and passes it to these commands. We bypass tauri-plugin-fs's
// per-path scope system by reading/writing through std::fs — the dialog
// already constitutes user consent for the chosen path.

use std::fs;
use std::process::Command;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

// The "actually quit" escape hatch for the unsaved-changes prompt: exit(0)
// re-enters ExitRequested with code Some(0), which passes straight through
// the user-initiated-exit hold in lib.rs.
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

// Expand a list of dropped / launch-arg paths into the `.seq` files they
// contain. Directories are walked (a few levels deep — a set folder may
// group songs in subfolders), `.seq` files pass through, everything else is
// ignored. Sorted + deduped so a folder always yields the same order.
// Shared by BROADCAST's set loader; harmless in Sequence.
#[tauri::command]
pub fn list_seq_files(paths: Vec<String>) -> Result<Vec<String>, String> {
    fn walk(dir: &std::path::Path, depth: u32, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth > 0 {
                    walk(&path, depth - 1, out);
                }
                continue;
            }
            let is_seq = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("seq"))
                .unwrap_or(false);
            if is_seq {
                if let Some(s) = path.to_str() {
                    out.push(s.to_string());
                }
            }
        }
    }
    let mut out = Vec::new();
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.is_dir() {
            walk(path, 3, &mut out);
        } else if path.is_file() {
            let is_seq = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("seq"))
                .unwrap_or(false);
            if is_seq {
                out.push(p);
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

// Files directly inside one directory whose extension is in `exts`
// (case-insensitive), sorted. Missing / non-directory → empty, not an
// error — BROADCAST probes sibling folders (CARDS/, INTERSTITIALS/) that
// may simply not exist. Dotfiles skipped.
#[tauri::command]
pub fn list_dir_files(dir: String, exts: Vec<String>) -> Vec<String> {
    let path = std::path::Path::new(&dir);
    let Ok(rd) = fs::read_dir(path) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        let ok = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
            .unwrap_or(false);
        if ok {
            // Canonical so a folder probed under two spellings (INTERSTITIALS
            // / interstitials on a case-insensitive FS) yields one path.
            let real = fs::canonicalize(&p).unwrap_or(p);
            if let Some(s) = real.to_str() {
                out.push(s.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

// The process argv, for launch flags the frontend interprets (BROADCAST's
// `--set <path>` / `--samples <dir>` / `--device <name>`). macOS Finder opens
// arrive as Apple events, not argv — those go through PendingOpenFiles.
#[tauri::command]
pub fn launch_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

// Frontend → Rust log bridge. BROADCAST mirrors its console here so an
// unattended run leaves a trail in the process log (dev terminal / Console.app)
// — the webview console isn't reachable once the window is on a stream box.
#[tauri::command]
pub fn js_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[js] {message}"),
        "warn" => log::warn!("[js] {message}"),
        _ => log::info!("[js] {message}"),
    }
}
