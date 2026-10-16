// Files in Dropbox __RACK/<synth>/ — the same layout tools/rack/server.mjs writes,
// so backups made by either show up in both:
//   backups/<stamp>.syx + .json     whole-memory backups (.json only for pedals)
//   backups/slots/<name>.json/.syx  one slot, saved just before store overwrites it
//   library.json                    pedals that can't be read: edit's copy of each slot
// The __RACK folder is found per machine (Dropbox lives in different places); if it
// can't be, the editor asks once (rack_pick_root) and the answer is kept in the app's
// config dir.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const NO_ROOT: &str = "no rack folder — pick your Dropbox __RACK folder";
const CANDIDATES: &[&str] = &[
    "Library/CloudStorage/Dropbox-Personal/___MUSIC/___NEWSPEECH/__RACK",
    "Library/CloudStorage/Dropbox/___MUSIC/___NEWSPEECH/__RACK",
    "Dropbox/___MUSIC/___NEWSPEECH/__RACK",
    "Dropbox (Personal)/___MUSIC/___NEWSPEECH/__RACK",
];

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("rack-root.txt"))
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(saved) = config_file(app).and_then(|f| fs::read_to_string(f).ok()) {
        let p = PathBuf::from(saved.trim());
        if p.is_dir() {
            return Ok(p);
        }
    }
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| NO_ROOT.to_string())?);
    if let Some(p) = CANDIDATES.iter().map(|c| home.join(c)).find(|p| p.is_dir()) {
        return Ok(p);
    }
    // any other Dropbox account folder under CloudStorage (Dropbox-Business, …)
    if let Ok(entries) = fs::read_dir(home.join("Library/CloudStorage")) {
        for e in entries.flatten() {
            let p = e.path().join("___MUSIC/___NEWSPEECH/__RACK");
            if e.file_name().to_string_lossy().starts_with("Dropbox") && p.is_dir() {
                return Ok(p);
            }
        }
    }
    Err(NO_ROOT.to_string())
}

// same rule as server.mjs safe(): keep word chars, space . - ( ) + #
fn safe(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || " _.-()+#".contains(c) { c } else { '_' })
        .collect();
    let out: String = out.trim().chars().take(80).collect();
    if out.is_empty() { "untitled".into() } else { out }
}

fn synth_dir(app: &AppHandle, folder: &str, sub: &str) -> Result<PathBuf, String> {
    let mut d = root(app)?.join(safe(folder));
    if !sub.is_empty() {
        d = d.join(sub);
    }
    fs::create_dir_all(&d).map_err(|e| format!("can't create {}: {e}", d.display()))?;
    Ok(d)
}

fn syx_bytes(body: &Value) -> Vec<u8> {
    body.get("syx")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|b| b.as_u64()).map(|b| b as u8).collect())
        .unwrap_or_default()
}

// write via a temp file + rename so a crash (or Dropbox syncing mid-write) never
// leaves a half-written file behind
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp~");
    fs::write(&tmp, data).map_err(|e| format!("can't write {}: {e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("can't write {}: {e}", path.display()))
}

#[derive(Serialize)]
pub struct BackupList {
    dir: String,
    backups: Vec<Value>,
}

#[tauri::command]
pub fn rack_root(app: AppHandle) -> Option<String> {
    root(&app).ok().map(|p| p.display().to_string())
}

// async: a blocking file dialog must not run on the main thread
#[tauri::command]
pub async fn rack_pick_root(app: AppHandle) -> Result<bool, String> {
    let Some(picked) = app.dialog().file().set_title("Pick your Dropbox __RACK folder").blocking_pick_folder() else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let cfg = config_file(&app).ok_or("no config dir")?;
    if let Some(dir) = cfg.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&cfg, path.display().to_string()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn rack_list_backups(app: AppHandle, folder: String) -> Result<BackupList, String> {
    let dir = synth_dir(&app, &folder, "backups")?;
    let mut backups: Vec<Value> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.contains(".layout.") {
                return None;
            }
            let j: Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            let json_only = j.get("jsonOnly").and_then(|v| v.as_bool()).unwrap_or(false);
            Some(json!({
                "file": if json_only { name.clone() } else { name.trim_end_matches(".json").to_string() + ".syx" },
                "at": j.get("at").cloned().unwrap_or(Value::Null),
                "count": j.get("slots").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0),
                "failed": j.get("failed").cloned().unwrap_or(json!(0)),
            }))
        })
        .collect();
    backups.sort_by(|a, b| b["at"].as_str().unwrap_or("").cmp(a["at"].as_str().unwrap_or("")));
    Ok(BackupList { dir: dir.display().to_string(), backups })
}

#[tauri::command]
pub fn rack_save_backup(app: AppHandle, folder: String, device: String, body: Value) -> Result<String, String> {
    let dir = synth_dir(&app, &folder, "backups")?;
    let base = dir.join(safe(body.get("stamp").and_then(|v| v.as_str()).unwrap_or("backup")));
    let syx = syx_bytes(&body);
    let mut index = json!({ "device": device, "at": body["at"], "slots": body["slots"], "failed": body["failed"] });
    if syx.is_empty() {
        index["jsonOnly"] = json!(true); // pedals: edit's copies only, in the .json
    } else {
        write_atomic(&base.with_extension("syx"), &syx)?;
    }
    write_atomic(&base.with_extension("json"), serde_json::to_string_pretty(&index).unwrap().as_bytes())?;
    Ok(base.with_extension(if syx.is_empty() { "json" } else { "syx" }).display().to_string())
}

#[tauri::command]
pub fn rack_save_slot_backup(app: AppHandle, folder: String, name: String, body: Value) -> Result<String, String> {
    let base = synth_dir(&app, &folder, "backups/slots")?.join(safe(&name));
    let mut j = body.clone();
    j["backedUpAt"] = json!(now_iso());
    write_atomic(&base.with_extension("json"), serde_json::to_string_pretty(&j).unwrap().as_bytes())?;
    let syx = syx_bytes(&body);
    if !syx.is_empty() {
        write_atomic(&base.with_extension("syx"), &syx)?;
    }
    Ok(base.with_extension("json").display().to_string())
}

#[tauri::command]
pub fn rack_read_library(app: AppHandle, folder: String) -> Result<Option<String>, String> {
    let f = synth_dir(&app, &folder, "")?.join("library.json");
    Ok(fs::read_to_string(f).ok())
}

#[tauri::command]
pub fn rack_write_library(app: AppHandle, folder: String, json: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&json).map_err(|e| format!("library isn't valid JSON: {e}"))?;
    let f = synth_dir(&app, &folder, "")?.join("library.json");
    write_atomic(&f, json.as_bytes())
}

// UTC ISO-8601 like server.mjs's new Date().toISOString(), without a date crate
// (civil-from-days, Howard Hinnant's algorithm)
fn now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::safe;
    #[test]
    fn safe_matches_server_mjs() {
        assert_eq!(safe("OBNE Dark Star Stereo"), "OBNE Dark Star Stereo");
        assert_eq!(safe("2026-10-15 1042 slot A-002 Organ/I"), "2026-10-15 1042 slot A-002 Organ_I");
        assert_eq!(safe("  "), "untitled");
        assert_eq!(safe("a:b*c"), "a_b_c");
    }
    #[test]
    fn iso_date_shape() {
        let s = super::now_iso();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.starts_with("20") && s.ends_with('Z') && &s[10..11] == "T", "{s}");
    }
}
