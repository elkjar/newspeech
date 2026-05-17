// User samples directory scanning. The Tauri app lets the user point at any
// folder on disk and have its `{drums,instruments,pads}/<kit>/manifest.json`
// files discovered at runtime — no rebuild required when new sample packs
// land. Web build can't do this (browsers can't enumerate disk paths), so
// this lives behind the Tauri-only invoke surface.
//
// Returns absolute paths so the frontend can `convertFileSrc` them into
// asset:// URLs that the WebView fetches the WAV / manifest content from
// (the asset-protocol scope is configured in capabilities to allow the
// chosen samples dir).

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
pub struct SampleKitEntry {
    pub kit_path: String,    // e.g. "instruments/my-pack"
    pub category: String,    // "drum" | "melodic"
    pub manifest_json: String, // raw JSON content; frontend parses
    pub absolute_dir: String, // filesystem path to the kit folder
}

const CATEGORIES: [(&str, &str); 3] = [
    ("drums", "drum"),
    ("instruments", "melodic"),
    ("pads", "melodic"),
];

#[tauri::command]
pub fn list_sample_kits(dir: String) -> Result<Vec<SampleKitEntry>, String> {
    let root = PathBuf::from(&dir);
    if !root.exists() {
        return Err(format!("samples dir does not exist: {}", dir));
    }
    if !root.is_dir() {
        return Err(format!("not a directory: {}", dir));
    }
    let mut entries: Vec<SampleKitEntry> = Vec::new();
    for (folder, category) in CATEGORIES {
        let category_dir = root.join(folder);
        if !category_dir.is_dir() {
            continue;
        }
        let read = match fs::read_dir(&category_dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let kit_dir = entry.path();
            if !kit_dir.is_dir() {
                continue;
            }
            let manifest_path = kit_dir.join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            let manifest_json = match fs::read_to_string(&manifest_path) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("skipping {}: {err}", manifest_path.display());
                    continue;
                }
            };
            let kit_name = match kit_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            entries.push(SampleKitEntry {
                kit_path: format!("{}/{}", folder, kit_name),
                category: category.to_string(),
                manifest_json,
                absolute_dir: kit_dir.to_string_lossy().to_string(),
            });
        }
    }
    entries.sort_by(|a, b| a.kit_path.cmp(&b.kit_path));
    Ok(entries)
}

// Default user samples directory. ~/Documents/Sequence/samples/. Created
// on first call so a fresh install has somewhere to drop folders.
#[tauri::command]
pub fn get_user_samples_dir(app: AppHandle) -> Result<String, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("document_dir: {e}"))?;
    let dir = docs.join("Sequence").join("samples");
    let _ = fs::create_dir_all(&dir);
    // Pre-seed the three category subdirs so the user has the right layout
    // visible the first time they open the folder in Finder.
    let _ = fs::create_dir_all(dir.join("drums"));
    let _ = fs::create_dir_all(dir.join("instruments"));
    let _ = fs::create_dir_all(dir.join("pads"));
    Ok(dir.to_string_lossy().to_string())
}

// Reads an audio file (WAV typically) and returns its bytes. The frontend
// feeds these straight to AudioContext.decodeAudioData. Path consent is
// implicit from the user-supplied samples-dir choice + the kit-scan that
// produced the absolute paths in the first place — same model as
// projectfs::save_text_file. Rust-side guard: refuse non-file targets.
#[tauri::command]
pub fn read_audio_file(path: String) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    fs::read(&p).map_err(|e| format!("read {path}: {e}"))
}
