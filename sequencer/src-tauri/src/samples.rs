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

// Category folders the scanner recognizes. The second field is the
// VoiceCategory the frontend uses to gate which TRACK SECTION the voice
// can land on (drum-section rows only see drum voices; melodic rows see
// the rest). The frontend's PICKER groups by the FOLDER NAME itself
// (`instruments` / `pads` / `textures` / `bass`) — that subcategory is
// inferred from the kit path on the JS side.
const CATEGORIES: [(&str, &str); 5] = [
    ("drums", "drum"),
    ("instruments", "melodic"),
    ("pads", "melodic"),
    ("bass", "melodic"),
    ("textures", "melodic"),
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

// Audio file extensions we recognize. Lowercased comparison.
const AUDIO_EXTS: [&str; 3] = [".wav", ".aif", ".aiff"];

// MIDI numbers below this threshold won't be interpreted from bare-number
// suffixes like `kick-1.wav`. Below A0 (21) is implausibly low for a
// musical root, and small numbers are almost always round-robin indices.
const MIDI_NUMBER_FLOOR: u8 = 21;

fn audio_extension_len(name_lower: &str) -> Option<usize> {
    for ext in AUDIO_EXTS {
        if name_lower.ends_with(ext) {
            return Some(name_lower.len() - ext.len());
        }
    }
    None
}

// Parses the filename suffix as a MIDI root note. Accepts:
//   * `<name>(-|_)<letter>[s|b|#]<octave>.<ext>` — note letter style, e.g.
//     `dreams-C2.wav`, `dreams-Cs2.wav`, `dreams-C#2.wav`, `dreams-Db2.wav`,
//     `dreams_c2.wav` (case-insensitive).
//   * `<name>(-|_)<midi>.<ext>` — bare MIDI number ≥ MIDI_NUMBER_FLOOR,
//     e.g. `bass-60.wav`.
// Returns None if no recognizable suffix is present (caller treats this
// as either "ignore" or "flat voice candidate" depending on context).
fn parse_root_from_filename(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    let stem_end = audio_extension_len(&lower)?;
    let trimmed = &name[..stem_end];
    // Voice names can contain hyphens (`dark-omen-C1.wav`); walk back from
    // the end until we find a separator whose suffix parses as a root.
    let bytes = trimmed.as_bytes();
    let mut i = bytes.len();
    while i > 0 {
        let c = bytes[i - 1];
        if c == b'-' || c == b'_' {
            let candidate = &trimmed[i..];
            if let Some(midi) = parse_note_suffix(candidate) {
                return Some(midi);
            }
        }
        i -= 1;
    }
    None
}

fn parse_note_suffix(s: &str) -> Option<u8> {
    if s.is_empty() {
        return None;
    }
    // Try bare MIDI number first — short-circuits if the suffix is all
    // digits. Only accepts values >= MIDI_NUMBER_FLOOR so round-robin
    // indices like `-1.wav` / `-9.wav` aren't misinterpreted as roots.
    if let Ok(n) = s.parse::<i32>() {
        if (MIDI_NUMBER_FLOOR as i32..=127).contains(&n) {
            return Some(n as u8);
        }
        return None;
    }
    // Note letter + optional accidental + octave.
    let bytes = s.as_bytes();
    let first = bytes[0].to_ascii_uppercase();
    // Letter is 1..2 chars; check whether byte[1] is an accidental marker
    // (s/S for sharp, b/B for flat, # for sharp).
    let (letter, rest) = if bytes.len() >= 2 {
        let second = bytes[1];
        let is_accidental = matches!(second, b's' | b'S' | b'b' | b'B' | b'#');
        if is_accidental {
            (
                {
                    // Normalize accidental marker: '#' and 's' both → 's'
                    let mut buf = [0u8; 2];
                    buf[0] = first;
                    buf[1] = match second {
                        b'#' | b's' | b'S' => b'S',
                        b'b' | b'B' => b'B',
                        _ => second,
                    };
                    std::str::from_utf8(&buf).ok().map(str::to_string).unwrap_or_default()
                },
                &s[2..],
            )
        } else {
            (
                std::str::from_utf8(&[first]).ok().map(str::to_string).unwrap_or_default(),
                &s[1..],
            )
        }
    } else {
        (
            std::str::from_utf8(&[first]).ok().map(str::to_string).unwrap_or_default(),
            "",
        )
    };
    let note_idx: i32 = match letter.as_str() {
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
    // Two-pass scan: collect every audio file, plus the subset that parses
    // as a rooted sample.
    //   * Any rooted files present → multi-sampled voice with roots (any
    //     remaining unrooted files are dropped, treated as noise).
    //   * No rooted files but at least one audio file → flat voice with all
    //     files as round-robin layers (no pitch shifting on trigger).
    //   * Empty / no audio → None (skip the folder).
    let mut audio_files: Vec<String> = Vec::new();
    let mut roots: BTreeMap<u8, Vec<String>> = BTreeMap::new();
    for entry in fs::read_dir(kit_dir).ok()?.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if audio_extension_len(&lower).is_none() {
            continue;
        }
        audio_files.push(name.clone());
        if let Some(midi) = parse_root_from_filename(&name) {
            roots.entry(midi).or_default().push(name);
        }
    }
    if audio_files.is_empty() {
        return None;
    }
    audio_files.sort();
    let label = kit_name.replace(['-', '_'], " ");
    let voice_body = if !roots.is_empty() {
        // Sort each root's round-robin file list for deterministic order.
        for files in roots.values_mut() {
            files.sort();
        }
        let roots_json: Vec<_> = roots
            .into_iter()
            .map(|(midi, files)| json!({ "midi": midi, "files": files }))
            .collect();
        json!({
            "label": label,
            "gain": 0.7,
            "roots": roots_json,
        })
    } else {
        // Flat voice: no root → samplePlayer skips pitch-shift, just plays
        // the file at original rate. Use the existing `files` field
        // (rather than `roots`) to opt into the rootless code path.
        json!({
            "label": label,
            "gain": 0.7,
            "files": audio_files,
        })
    };
    let manifest = json!({
        "name": kit_name,
        "voices": { kit_name: voice_body }
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
    // Pre-seed the category subdirs so the user has the right layout
    // visible the first time they open the folder in Finder. Mirrors
    // the CATEGORIES list above — keep in sync.
    for (folder, _) in CATEGORIES {
        let _ = fs::create_dir_all(dir.join(folder));
    }
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

// Moves a user-sample-kit directory to the Trash (not permanent delete).
// Uses AppleScript via osascript so the kit lands in Finder's Trash with
// undo available — important guard against accidental loss of bespoke
// sample packs. macOS-only for now; Linux/Windows fallbacks are out of
// scope until those platforms ship.
//
// Caller is responsible for restricting this to *user* kit paths — the
// command itself doesn't enforce a scope.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn trash_sample_kit(path: String) -> Result<(), String> {
    use std::process::Command;
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    // POSIX-file form of the path so Finder accepts it; quoting via the
    // AppleScript literal-string form. Single quotes in the path itself
    // would break this — sample-pack folder names shouldn't contain them.
    if path.contains('"') {
        return Err("path contains a quote character; refusing".to_string());
    }
    let script = format!(
        "tell application \"Finder\" to delete (POSIX file \"{}\")",
        path
    );
    let status = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status()
        .map_err(|e| format!("osascript: {e}"))?;
    if !status.success() {
        return Err(format!("osascript exited with status {}", status));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn trash_sample_kit(_path: String) -> Result<(), String> {
    Err("trash_sample_kit not implemented on this platform".to_string())
}
