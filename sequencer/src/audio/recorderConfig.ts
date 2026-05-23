// Recorder configuration helpers. Pure localStorage I/O — no WebAudio
// imports, so SettingsDialog can read/write the recordings dir without
// pulling the recorder's worklet code into the bundle. Lives apart
// from `recorder.ts` (web audio path) so the Tauri build can drop the
// worklet code via tree-shaking even when the Settings UI is loaded.

const LS_RECORDINGS_DIR = 'newspeech.sequencer.recordingsDir';

export function getConfiguredRecordingsDir(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(LS_RECORDINGS_DIR);
  return v && v.trim() ? v : null;
}

export function setConfiguredRecordingsDir(dir: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (dir && dir.trim()) localStorage.setItem(LS_RECORDINGS_DIR, dir);
  else localStorage.removeItem(LS_RECORDINGS_DIR);
}
