// Streaming WAV writer for sequencer takes.
//
// JS spawns one writer per active take (combined / rhythm / melody) via
// `recording_start`, then ships int16 stereo interleaved PCM bytes through
// `recording_write_chunk` per ~250 ms batch. On `recording_finalize` the
// 44-byte WAV header is patched with the actual data length and the file is
// closed. State lives in a HashMap keyed by the JS-supplied filename so the
// stems case (multiple concurrent writers) Just Works without ID generation.

use std::collections::HashMap;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

pub struct RecordingHandle {
    path: PathBuf,
    file: std::io::BufWriter<std::fs::File>,
    data_bytes: u64,
    sample_rate: u32,
}

#[derive(Default)]
pub struct RecordingRegistry(pub Mutex<HashMap<String, RecordingHandle>>);

#[derive(Serialize)]
pub struct RecordingStartResult {
    pub path: String,
}

fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("document_dir: {e}"))?;
    Ok(docs.join("newspeech-recordings"))
}

fn write_placeholder_header<W: Write>(w: &mut W, sample_rate: u32) -> std::io::Result<()> {
    let num_channels: u16 = 2;
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * num_channels as u32 * bits_per_sample as u32 / 8;
    let block_align = num_channels * bits_per_sample / 8;

    // RIFF chunk descriptor — sizes are placeholders, patched on finalize.
    w.write_all(b"RIFF")?;
    w.write_all(&0u32.to_le_bytes())?;
    w.write_all(b"WAVE")?;

    // fmt sub-chunk
    w.write_all(b"fmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?; // PCM
    w.write_all(&num_channels.to_le_bytes())?;
    w.write_all(&sample_rate.to_le_bytes())?;
    w.write_all(&byte_rate.to_le_bytes())?;
    w.write_all(&block_align.to_le_bytes())?;
    w.write_all(&bits_per_sample.to_le_bytes())?;

    // data sub-chunk header — size patched on finalize.
    w.write_all(b"data")?;
    w.write_all(&0u32.to_le_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn recording_start(
    app: AppHandle,
    registry: State<RecordingRegistry>,
    filename: String,
    sample_rate: u32,
) -> Result<RecordingStartResult, String> {
    let dir = recordings_dir(&app)?;
    create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let path = dir.join(&filename);

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    write_placeholder_header(&mut writer, sample_rate)
        .map_err(|e| format!("write header: {e}"))?;

    let path_str = path.to_string_lossy().to_string();
    let handle = RecordingHandle {
        path,
        file: writer,
        data_bytes: 0,
        sample_rate,
    };

    let mut map = registry.0.lock().map_err(|e| format!("lock: {e}"))?;
    if map.contains_key(&filename) {
        return Err(format!("recording already active: {filename}"));
    }
    map.insert(filename, handle);
    Ok(RecordingStartResult { path: path_str })
}

#[tauri::command]
pub fn recording_write_chunk(
    registry: State<RecordingRegistry>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let mut map = registry.0.lock().map_err(|e| format!("lock: {e}"))?;
    let handle = map
        .get_mut(&filename)
        .ok_or_else(|| format!("no active recording: {filename}"))?;
    handle
        .file
        .write_all(&bytes)
        .map_err(|e| format!("write chunk: {e}"))?;
    handle.data_bytes += bytes.len() as u64;
    Ok(())
}

#[derive(Serialize)]
pub struct RecordingFinalizeResult {
    pub path: String,
    pub duration_s: f64,
    pub data_bytes: u64,
}

#[tauri::command]
pub fn recording_finalize(
    registry: State<RecordingRegistry>,
    filename: String,
) -> Result<RecordingFinalizeResult, String> {
    let mut map = registry.0.lock().map_err(|e| format!("lock: {e}"))?;
    let handle = map
        .remove(&filename)
        .ok_or_else(|| format!("no active recording: {filename}"))?;
    let RecordingHandle {
        path,
        mut file,
        data_bytes,
        sample_rate,
    } = handle;

    file.flush().map_err(|e| format!("flush: {e}"))?;
    let mut inner = file
        .into_inner()
        .map_err(|e| format!("unwrap BufWriter: {e}"))?;

    // RIFF size = 36 + data_bytes (header is 44 bytes total: 8 RIFF + 36 rest).
    let riff_size: u32 = (36 + data_bytes).min(u32::MAX as u64) as u32;
    let data_size: u32 = data_bytes.min(u32::MAX as u64) as u32;

    inner
        .seek(SeekFrom::Start(4))
        .map_err(|e| format!("seek riff size: {e}"))?;
    inner
        .write_all(&riff_size.to_le_bytes())
        .map_err(|e| format!("write riff size: {e}"))?;

    inner
        .seek(SeekFrom::Start(40))
        .map_err(|e| format!("seek data size: {e}"))?;
    inner
        .write_all(&data_size.to_le_bytes())
        .map_err(|e| format!("write data size: {e}"))?;

    inner.flush().map_err(|e| format!("final flush: {e}"))?;

    let frames = data_bytes / 4; // 2 channels * 2 bytes/sample
    let duration_s = frames as f64 / sample_rate as f64;
    Ok(RecordingFinalizeResult {
        path: path.to_string_lossy().to_string(),
        duration_s,
        data_bytes,
    })
}

#[tauri::command]
pub fn recording_cancel(
    registry: State<RecordingRegistry>,
    filename: String,
) -> Result<(), String> {
    let mut map = registry.0.lock().map_err(|e| format!("lock: {e}"))?;
    if let Some(handle) = map.remove(&filename) {
        // Drop the writer and remove the partial file.
        drop(handle.file);
        let _ = std::fs::remove_file(&handle.path);
    }
    Ok(())
}
