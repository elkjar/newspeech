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

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::json;
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
            let kit_name = match kit_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let manifest_path = kit_dir.join("manifest.json");
            // Manifest resolution:
            //   1. If manifest.json exists → use it verbatim (full control).
            //   2. Else, attempt to synthesize from WAV filenames using the
            //      `<voice>-<note><octave>.wav` convention. Lets the user
            //      drop a raw sample folder without writing JSON. Drum kits
            //      with subfolder-per-voice layouts won't match this pattern;
            //      those still need a hand-written manifest.
            let manifest_json = if manifest_path.is_file() {
                match fs::read_to_string(&manifest_path) {
                    Ok(c) => c,
                    Err(err) => {
                        eprintln!("skipping {}: {err}", manifest_path.display());
                        continue;
                    }
                }
            } else {
                match synthesize_manifest_from_folder(&kit_dir, &kit_name) {
                    Some(json) => json,
                    None => continue, // no manifest, no recognizable WAV layout — skip silently
                }
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

// Parses `<anything>(-|_)<note><octave>.wav` (note ∈ C..B, optionally
// followed by `s` for sharp or `b` for flat; octave is decimal digits) and
// returns the resulting MIDI note number. Convention: C4 = 60 (middle C),
// so midi = (octave + 1) * 12 + noteIndex.
fn parse_root_from_filename(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    let trimmed = if let Some(t) = lower.strip_suffix(".wav") {
        // preserve the case of the original for indexing back
        &name[..t.len()]
    } else if let Some(t) = lower.strip_suffix(".aif") {
        &name[..t.len()]
    } else if let Some(t) = lower.strip_suffix(".aiff") {
        &name[..t.len()]
    } else {
        return None;
    };
    // The voice name itself can contain hyphens (e.g. `dark-omen-C1.wav`),
    // so we can't just split on the first separator. Walk back from the end
    // until we find a separator whose suffix parses as <note><octave>.
    let bytes = trimmed.as_bytes();
    let mut i = bytes.len();
    while i > 0 {
        let c = bytes[i - 1];
        if c == b'-' || c == b'_' {
            let candidate = &trimmed[i..];
            if let Some(midi) = parse_note_octave(candidate) {
                return Some(midi);
            }
        }
        i -= 1;
    }
    None
}

fn parse_note_octave(s: &str) -> Option<u8> {
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    // Letter is 1..2 chars; octave is the rest (must be digits).
    let (letter, rest) = if bytes.len() >= 2 && (bytes[1] == b's' || bytes[1] == b'b' || bytes[1] == b'S' || bytes[1] == b'B') {
        (&s[0..2], &s[2..])
    } else {
        (&s[0..1], &s[1..])
    };
    let note_idx: i32 = match letter.to_ascii_uppercase().as_str() {
        "C" => 0,
        "CS" | "DB" => 1,
        "D" => 2,
        "DS" | "EB" => 3,
        "E" => 4,
        "F" => 5,
        "FS" | "GB" => 6,
        "G" => 7,
        "GS" | "AB" => 8,
        "A" => 9,
        "AS" | "BB" => 10,
        "B" => 11,
        _ => return None,
    };
    let octave: i32 = rest.parse().ok()?;
    let midi: i32 = (octave + 1) * 12 + note_idx;
    if !(0..=127).contains(&midi) {
        return None;
    }
    Some(midi as u8)
}

fn synthesize_manifest_from_folder(kit_dir: &Path, kit_name: &str) -> Option<String> {
    let mut roots: BTreeMap<u8, Vec<String>> = BTreeMap::new();
    for entry in fs::read_dir(kit_dir).ok()?.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(midi) = parse_root_from_filename(&name) {
            roots.entry(midi).or_default().push(name);
        }
    }
    if roots.is_empty() {
        return None;
    }
    // Round-robin file lists sort deterministically so the playback order
    // doesn't shuffle between launches.
    for files in roots.values_mut() {
        files.sort();
    }
    let label = kit_name.replace(['-', '_'], " ");
    let roots_json: Vec<_> = roots
        .into_iter()
        .map(|(midi, files)| json!({ "midi": midi, "files": files }))
        .collect();
    let manifest = json!({
        "name": kit_name,
        "voices": {
            kit_name: {
                "label": label,
                "gain": 0.7,
                "roots": roots_json,
            }
        }
    });
    serde_json::to_string(&manifest).ok()
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
