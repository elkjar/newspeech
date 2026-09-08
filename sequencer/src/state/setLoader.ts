// Set loading shared by BROADCAST (src/broadcast/setlist.ts) and, later, the
// PerformanceDialog "load folder…" path. File IO goes through the Rust
// commands; parsing stays in persist.ts.
import { invoke } from '@tauri-apps/api/core';
import type { Song } from './store';
import {
  parseSeqset,
  parseSongFromSeq,
  resolveRelativePath,
  songNameFromFilename,
  dirOf,
} from './persist';

export interface SetEntry {
  path: string;
  name: string;
}

// Expand dropped / launch paths (folders, .seq files, .seqset files) into an
// ordered list of .seq entries. A .seqset contributes its referenced songs in
// slot order (absolute path first, then relative to the set's folder).
// Folders are walked by the Rust side (a few levels deep), sorted.
export async function expandSetPaths(paths: string[]): Promise<SetEntry[]> {
  const out: SetEntry[] = [];
  const seen = new Set<string>();
  const push = (path: string, name?: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, name: name ?? songNameFromFilename(path) });
  };
  const plain: string[] = [];
  for (const p of paths) {
    if (/\.seqset$/i.test(p)) {
      try {
        const text = await invoke<string>('read_text_file', { path: p });
        const parsed = parseSeqset(text);
        if (parsed?.kind === 'refs') {
          const setDir = dirOf(p);
          for (const ref of parsed.refs) {
            if (!ref) continue;
            // Prefer the absolute path if it still exists; fall back to rel.
            let resolved = ref.path;
            try {
              await invoke<string>('read_text_file', { path: resolved });
            } catch {
              if (ref.rel) resolved = resolveRelativePath(setDir, ref.rel);
            }
            push(resolved, ref.name);
          }
        }
      } catch (err) {
        console.warn('[setLoader] seqset read failed:', p, err);
      }
      continue;
    }
    plain.push(p);
  }
  if (plain.length) {
    const files = await invoke<string[]>('list_seq_files', { paths: plain });
    for (const f of files) push(f);
  }
  return out;
}

// Read + parse one song. Null when the file is missing or not a .seq.
export async function readSongFile(entry: SetEntry): Promise<Song | null> {
  let text: string;
  try {
    text = await invoke<string>('read_text_file', { path: entry.path });
  } catch (err) {
    console.warn('[setLoader] read failed:', entry.path, err);
    return null;
  }
  const song = parseSongFromSeq(text);
  if (!song) return null;
  return { ...song, name: entry.name || song.name };
}

// Every voice id a song can trigger: live tracks, every bank, every scene's
// tracks and banks. Used to preload a staged song ahead of its swap and to
// skip songs that have no sample voices at all (external-MIDI-only songs are
// silent through the runner).
export function songVoiceIds(song: Song): string[] {
  const ids = new Set<string>();
  const take = (tracks: { source: { kind: string; id?: string } }[] | undefined) => {
    for (const t of tracks ?? []) {
      if (t.source.kind === 'voice' && typeof t.source.id === 'string') ids.add(t.source.id);
    }
  };
  take(song.tracks);
  for (const b of song.banks) if (b) take(b.tracks);
  for (const sc of song.scenes) {
    if (!sc) continue;
    take(sc.tracks);
    for (const b of sc.banks) if (b) take(b.tracks);
  }
  return [...ids];
}
