// Offline song MIDI export — runs the note engine (engine/tick.ts runTick)
// through the whole song-mode arrangement without the clock or the audio
// engine, and writes one .mid per track. For getting a part into a DAW without
// recording a real-time stems take.
//
// What it plays: every arrangement row in order, held for its bar count, with
// its mutes; each row's scene + bank pattern; chord-master harmony and the
// tracks that follow it; ties, ratchets, micro-timing, arps; mutation,
// probability and harmonic-motion dice at the current knob values — so each
// export is one possible performance, the same way each playback is.
//
// What it can't include, because these only exist while the transport runs:
// Ghost's moves, LFO sweeps (LFOs run on wall-clock time), perform punches,
// live playing, and CC / program changes. The stems take (midiCapture.ts)
// records those.
//
// The transport must be stopped: the engine's cross-step counters (pad drift,
// lead branch walk, accumulators) are module singletons shared with playback.
// The export resets them where playback would (a pattern swap) and once more
// when it finishes; play-start resets them again anyway.

import { invoke } from '@tauri-apps/api/core';
import {
  useSequencerStore,
  composeLiveActiveScene,
  banksWithLiveActiveBank,
  type Track,
  type BankSlot,
} from '../state/store';
import { runTick } from '../engine/tick';
import { sourceLabel } from '../instruments/library';
import { getConfiguredRecordingsDir } from './recorderConfig';
import { smfFromNotes, type SampleNote } from './midiCapture';
import { makeHarmonicMotionState, tickHarmonicMotion } from './harmonicMotion';
import { getChordContext } from './chordContext';
import { octaveDegrees } from './scale';
import { tickPadDrift, resetPadDrift } from './padState';
import { consumeBranchLeaf, resetBranchWalk } from './treeState';
import {
  consumeStepAccRung,
  consumeAutoMutationRung,
  resetStepAccumulators,
} from './accumulator';

const STEPS_PER_BAR = 32; // 32nd-note ticks, same as the dispatcher
// Unpitched sample hits land on C1, as in a stems take.
const UNPITCHED_NOTE = 36;

export type SongMidiExportResult =
  | { ok: true; dir: string; files: number; bars: number }
  | { ok: false; reason: string };

function resetEngineCounters(): void {
  resetPadDrift();
  resetBranchWalk();
  resetStepAccumulators();
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

interface TrackFile {
  base: string;
  channel: number;
  notes: SampleNote[];
}

export async function exportSongMidi(): Promise<SongMidiExportResult> {
  const s = useSequencerStore.getState();
  if (s.playing) return { ok: false, reason: 'stop the transport first' };
  const rows = s.arrangement.rows;
  if (rows.length === 0) return { ok: false, reason: 'the song has no rows' };

  // Scenes with the active one read from the live working state, so unsaved
  // edits on screen are what gets exported.
  const scenes = composeLiveActiveScene(s);
  const liveBanks = banksWithLiveActiveBank(s);

  // Track files, keyed by trackId, named like a stems take's files
  // (`r01_kick`, `m02_pad`) from the first pattern each track appears in.
  const files = new Map<string, TrackFile>();
  const nameTracks = (tracks: Track[]) => {
    let r = 0;
    let m = 0;
    for (const t of tracks) {
      const isRhythm = t.section === 'drum';
      const nn = String(isRhythm ? ++r : ++m).padStart(2, '0');
      if (files.has(t.id) || t.source.kind === 'empty') continue;
      const label = slug(sourceLabel(t.source));
      let base = `${isRhythm ? 'r' : 'm'}${nn}${label ? `_${label}` : ''}`;
      while ([...files.values()].some((f) => f.base === base)) base += '_';
      files.set(t.id, {
        base,
        // Hardware tracks keep their own MIDI channel; sample tracks follow
        // the stems-take convention (drums on 10, everything else on 1).
        channel: t.source.kind === 'instrument' ? t.midi.channel & 0x0f : isRhythm ? 9 : 0,
        notes: [],
      });
    }
  };

  const stepDuration = 60 / s.bpm / 8;
  const harmonic = makeHarmonicMotionState();
  let chordContext = getChordContext();
  let globalStep = 0;
  let sceneStartStep = 0;
  // The pattern the engine is on. A row naming the same scene + bank as the
  // one before it doesn't swap, so the pattern keeps running — only the mutes
  // change (as in playback).
  let curScene = -1;
  let curBank = -1;
  let curTracks: Track[] | null = null;

  resetEngineCounters();
  try {
    for (const row of rows) {
      // An empty scene slot keeps the current scene (playback only engages
      // the bank); an empty bank slot keeps the current pattern.
      const sceneIdx = scenes[row.scene] ? row.scene : curScene;
      const scene = sceneIdx >= 0 ? scenes[sceneIdx] : null;
      const banks: (BankSlot | null)[] = scene ? scene.banks : liveBanks;
      const slot = banks[row.bank];
      if (slot && (sceneIdx !== curScene || row.bank !== curBank || !curTracks)) {
        // Octave and mutation are global per-track knobs, not pattern state:
        // they come from the scene's tracks, not the bank's stored copy.
        const globals = new Map((scene ? scene.tracks : s.tracks).map((t) => [t.id, t]));
        curTracks = slot.tracks.map((bt) => {
          const g = globals.get(bt.id);
          return g ? { ...bt, octave: g.octave, mutation: g.mutation } : bt;
        });
        curScene = sceneIdx;
        curBank = row.bank;
        sceneStartStep = globalStep;
        resetEngineCounters();
        nameTracks(curTracks);
      }
      const rowTicks = Math.max(1, Math.floor(row.bars)) * STEPS_PER_BAR;
      if (!curTracks) {
        // Nothing resolvable yet — the row passes as silence.
        globalStep += rowTicks;
        continue;
      }
      // The row's mute list is the complete audibility statement in song
      // mode: it sets mute and clears solo.
      const muted = new Set(row.mutes);
      const tracks = curTracks.map((t) => ({ ...t, mute: muted.has(t.id), solo: false }));
      const byId = new Map(tracks.map((t) => [t.id, t]));

      for (let i = 0; i < rowTicks; i++, globalStep++) {
        const when = globalStep * stepDuration;
        const harmonicOffset = tickHarmonicMotion(
          harmonic,
          globalStep,
          s.motion,
          s.drift,
          octaveDegrees(s.scale),
        );
        const events = runTick(
          {
            tracks,
            rootNote: s.rootNote,
            scale: s.scale,
            lfos: [],
            density: s.density,
            chaos: s.chaos,
            tension: s.tension,
            voicing: s.voicing,
            freeze: false,
            ghostLeadMutation: () => 0,
            sceneStartStep,
            globalStep,
            when,
            stepDuration,
            harmonicOffset,
            chordContext,
            perform: null,
          },
          {
            readOverlay: () => undefined,
            consumePadDrift: tickPadDrift,
            consumeBranchLeaf,
            consumeStepAccRung,
            consumeAutoMutationRung,
          },
        );
        for (const ev of events) {
          if (ev.kind === 'chordContext') {
            chordContext = ev.chord;
          } else if (ev.kind === 'midi') {
            files.get(ev.trackId)?.notes.push({
              note: Math.max(0, Math.min(127, Math.round(ev.note))),
              velocity: Math.max(1, Math.min(127, Math.round(ev.velocity * 127))),
              onMs: ev.when * 1000,
              offMs: (ev.when + ev.durationS) * 1000,
            });
          } else if (ev.kind === 'sample') {
            const file = files.get(ev.trackId);
            if (!file) continue;
            const velocity = Math.max(1, Math.min(127, Math.round(ev.velocity * 127)));
            const push = (interval: number, at: number, dur: number) =>
              file.notes.push({
                note:
                  ev.midi === undefined
                    ? UNPITCHED_NOTE
                    : Math.max(0, Math.min(127, Math.round(ev.midi + interval))),
                velocity,
                onMs: at * 1000,
                offMs: (at + Math.max(0.02, dur)) * 1000,
              });
            const n = ev.voiceIntervals.length;
            if (byId.get(ev.trackId)?.arpConfig?.on === true && n > 1) {
              // Arp: the chord's tones in order, spread across the tied window
              // (same split the dispatcher makes).
              const sub = (ev.stepDuration * ev.tieLength) / n;
              ev.voiceIntervals.forEach((iv, k) => push(iv, ev.when + k * sub, ev.gate * sub));
            } else {
              for (const iv of ev.voiceIntervals) push(iv, ev.when, ev.gate * ev.stepDuration);
            }
          }
        }
      }
    }
  } finally {
    resetEngineCounters();
  }

  const endMs = globalStep * stepDuration * 1000;
  const bars = globalStep / STEPS_PER_BAR;
  const root = getConfiguredRecordingsDir() ?? (await invoke<string>('get_recordings_dir'));
  const dir = `${root.replace(/\/$/, '')}/${s.bpm}bpm_${timestamp()}_song_midi`;
  const tempos = [{ atMs: 0, bpm: s.bpm }];
  let written = 0;
  for (const f of files.values()) {
    if (f.notes.length === 0) continue; // muted throughout, or never fired
    try {
      await invoke('save_binary_file', {
        path: `${dir}/${f.base}.mid`,
        contents: Array.from(smfFromNotes(f.base, f.channel, f.notes, 0, endMs, tempos)),
      });
      written++;
    } catch (err) {
      console.warn('[songMidiExport] write failed:', err);
    }
  }
  if (written === 0) return { ok: false, reason: 'no track played a note' };
  return { ok: true, dir, files: written, bars };
}
