import { useEffect, useRef } from 'react';
import { useSequencerStore, RATE_STRIDE, type Track } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { sourceIsMelodic, sourceLabel } from '../instruments/library';
import { quantize, midiToName } from '../audio/scale';
import { resolveChord, DEFAULT_CHORD_VOICING } from '../audio/chords';
import { getOverlay } from '../audio/mutationOverlay';

// Phase 1.3b: static authored piano roll of the focused channel.
// X = steps 0..track.length, Y = pitch (authored scale-degree), bar length =
// gate + ties, velocity → brightness. Drum/unpitched tracks collapse to a
// single trigger lane. Playhead column lit while playing. Canvas, redrawn each
// frame off the store (cheap; only mounted while ROLL is the active mode).
// Deviation layer (mutationOverlay), chord-aware pitch, ratchet detail, and a
// proper header come in later phases.
//
// Monochrome (per the sequencer's no-accent-colour convention): notes are
// white, and the scale ROOT rows are highlighted by brightness — a brighter
// band + separator line + note label — rather than by colour. (Reliq uses
// amber + octave-C labels; we keep the readability idea, drop the colour.)
const NOTE_RGB = '255, 255, 255';

function resolveFocusedTrack(tracks: Track[], focusedTrackId: string | null): Track | null {
  if (focusedTrackId) {
    const t = tracks.find((t) => t.id === focusedTrackId);
    if (t) return t;
  }
  return (
    tracks.find((t) => sourceIsMelodic(t.source)) ??
    tracks.find((t) => t.source.kind !== 'empty') ??
    tracks[0] ??
    null
  );
}

export function PianoRoll() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let cssW = 0;
    let cssH = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cssW = container.clientWidth;
      cssH = container.clientHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const draw = () => {
      const W = cssW;
      const H = cssH;
      ctx.clearRect(0, 0, W, H);

      const state = useSequencerStore.getState();
      const track = resolveFocusedTrack(state.tracks, state.focusedTrackId);

      if (track && W > 0 && H > 0) {
        const len = track.length;
        const cw = W / len;
        const xAt = (col: number) => col * cw;
        const melodic = sourceIsMelodic(track.source);
        const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11];

        // Does dispatch read this row's chordVoicing? Chord master (first
        // melodic row) always does; `semitones` followers do when authored.
        // Other follower modes derive single tones from the chord context, so
        // they stay single-note (matches StepInspector's chord-picker gate).
        const chordMasterId =
          state.tracks.find((t) => t.section === 'melodic')?.id ?? null;
        const usesVoicing =
          melodic && (track.id === chordMasterId || track.pitchInterp === 'semitones');

        // The MIDI note set a step sounds at a given (scale-degree) pitch: a
        // full chord for voicing rows, otherwise a single quantized note.
        // `pitch` is passed explicitly so the resolved pass can reuse it with
        // the overlay's mutated/accumulated pitch.
        const chordNotesAt = (stepIndex: number, pitch: number): number[] => {
          if (usesVoicing) {
            const s = track.steps[stepIndex];
            const voicing = s.chordVoicing ?? track.defaultChordVoicing ?? DEFAULT_CHORD_VOICING;
            const { root, intervals } = resolveChord(state.rootNote, state.scale, voicing, pitch);
            return intervals.map((iv) => root + iv);
          }
          return [quantize(state.rootNote, state.scale, pitch)];
        };
        const notesForStep = (i: number): number[] => chordNotesAt(i, track.steps[i].pitch);

        // Visible MIDI range: snap to octave (C) boundaries, min 2 octaves.
        let loMidi = 0;
        let hiMidi = 0;
        if (melodic) {
          let minM = Infinity;
          let maxM = -Infinity;
          for (let i = 0; i < len; i++) {
            if (!track.steps[i].on) continue;
            for (const m of notesForStep(i)) {
              if (m < minM) minM = m;
              if (m > maxM) maxM = m;
            }
          }
          if (minM === Infinity) {
            minM = state.rootNote;
            maxM = state.rootNote;
          }
          loMidi = Math.floor((minM - 2) / 12) * 12;
          hiMidi = Math.ceil((maxM + 3) / 12) * 12;
          if (hiMidi - loMidi < 24) hiMidi = loMidi + 24;
        }
        const laneCount = melodic ? hiMidi - loMidi + 1 : 1;
        const rowH = H / laneCount;
        const yTop = (m: number) => (hiMidi - m) * rowH;
        const barH = melodic ? Math.max(2, rowH * 0.62) : Math.min(10, H * 0.25);
        const rootPc = ((state.rootNote % 12) + 12) % 12;

        // --- chromatic row backgrounds; root rows get a brighter band ---
        if (melodic) {
          for (let m = loMidi; m <= hiMidi; m++) {
            const pc = ((m % 12) + 12) % 12;
            ctx.fillStyle =
              pc === rootPc
                ? 'rgba(255,255,255,0.10)'
                : WHITE_KEYS.includes(pc)
                  ? 'rgba(255,255,255,0.045)'
                  : 'rgba(255,255,255,0.015)';
            ctx.fillRect(0, yTop(m), W, rowH);
          }
          // horizontal lane separators; brighter at root rows.
          ctx.lineWidth = 1;
          for (let m = loMidi; m <= hiMidi; m++) {
            const pc = ((m % 12) + 12) % 12;
            const y = Math.round(yTop(m)) + 0.5;
            ctx.strokeStyle =
              pc === rootPc ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)';
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
          }
        }

        // --- vertical step separators; brighter every 4 (bar) ---
        ctx.lineWidth = 1;
        for (let i = 0; i <= len; i++) {
          const x = Math.round(xAt(i)) + 0.5;
          ctx.strokeStyle = i % 4 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H);
          ctx.stroke();
        }

        // --- notes ---
        // When playing, the AUTHORED pattern is a dim baseline and the live
        // RESOLVED note (from mutationOverlay) draws bright on top — so
        // mutation / chance / ghost read as a visible departure. When stopped,
        // authored draws at full weight.
        const live = state.playing && scheduler.isPlaying();
        const clampVel = (v: number) => Math.min(Math.max(v, 0), 1);
        const yTops = (notes: number[]) =>
          melodic ? notes.map((m) => yTop(m) + (rowH - barH) / 2) : [H / 2 - barH / 2];
        const notch = (x: number, y: number, w: number, ratchet: number) => {
          if (ratchet <= 1) return;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          for (let r = 1; r < ratchet; r++) {
            const rx = x + (r / ratchet) * (cw - 2);
            if (rx > x + w) break;
            ctx.beginPath();
            ctx.moveTo(rx, y);
            ctx.lineTo(rx, y + barH);
            ctx.stroke();
          }
        };

        // Pass A — authored baseline (run-length over ties).
        let i = 0;
        while (i < len) {
          const s = track.steps[i];
          if (!s.on) {
            i++;
            continue;
          }
          let end = i;
          while (melodic && track.steps[end].tieToNext && end + 1 < len) end++;
          const lastGate = Math.min(Math.max(track.steps[end].gate, 0.1), 2);
          const x = xAt(i) + 1;
          const w = Math.max(2, (end - i + lastGate) * cw - 2);
          const dimmed = live && getOverlay(track.id, i) !== undefined;
          const alpha = dimmed ? 0.16 : 0.55 + 0.45 * clampVel(s.velocity);
          ctx.fillStyle = `rgba(${NOTE_RGB},${alpha})`;
          for (const y of yTops(melodic ? notesForStep(i) : [0])) {
            ctx.fillRect(x, y, w, barH);
            if (!dimmed) notch(x, y, w, s.ratchet);
          }
          i = end + 1;
        }

        // Pass B — live resolved notes from the overlay. A note SOUNDS when
        // `gated` (drawn bright) — this includes density FILLS (authored-off
        // steps that fire: on=false, gated=true). Steps that were meant to
        // sound but didn't (chance miss / density THINNING: on=true,
        // gated=false) draw as hollow outlines. Authored ties disambiguate a
        // sustain (skip continuations) from a genuine miss.
        if (live) {
          for (let j = 0; j < len; j++) {
            const ov = getOverlay(track.id, j);
            if (!ov || (!ov.on && !ov.gated)) continue;
            const isContinuation =
              melodic && j > 0 && track.steps[j - 1].on && track.steps[j - 1].tieToNext;
            if (isContinuation) continue;
            let end = j;
            while (melodic && track.steps[end].tieToNext && end + 1 < len) end++;
            const gate = Math.min(Math.max(ov.gate, 0.1), 2);
            const x = xAt(j) + 1;
            const w = Math.max(2, (end - j + gate) * cw - 2);
            // Chord master publishes its resolved chord on the overlay (root
            // already includes the harmonic-motion offset); other voicing rows
            // (semitones followers) don't, so recompute from the authored
            // voicing at the RESOLVED pitch + the harmonic offset (motion/drift).
            const notes =
              !melodic
                ? [0]
                : ov.chord
                  ? ov.chord.intervals.map((iv) => ov.chord!.root + iv)
                  : chordNotesAt(j, ov.pitch + (ov.harmonicShift ?? 0));
            for (const y of yTops(notes)) {
              if (ov.gated) {
                ctx.fillStyle = `rgba(${NOTE_RGB},${0.6 + 0.4 * clampVel(ov.velocity)})`;
                ctx.fillRect(x, y, w, barH);
                notch(x, y, w, ov.ratchet);
              } else {
                ctx.strokeStyle = 'rgba(255,255,255,0.4)';
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, cw - 3), barH - 1);
              }
            }
          }
        }

        // --- playhead column (scene-relative, per-track stride) ---
        if (live) {
          const stride = RATE_STRIDE[track.rate];
          const localCurrent =
            Math.floor((state.globalStep - state.sceneStartStep) / stride) % len;
          if (localCurrent >= 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.1)';
            ctx.fillRect(xAt(localCurrent), 0, cw, H);
          }
        }

        // --- root labels (overlay, left edge) ---
        if (melodic) {
          ctx.fillStyle = `rgba(${NOTE_RGB},0.85)`;
          ctx.font = 'bold 11px ui-monospace, monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          for (let m = loMidi; m <= hiMidi; m++) {
            if (((m % 12) + 12) % 12 !== rootPc) continue;
            ctx.fillText(midiToName(m), 5, yTop(m) + rowH / 2);
          }
        }

        // --- orientation label (top-right, dim) ---
        const label = track.source.kind === 'empty' ? '—' : sourceLabel(track.source);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(label.toUpperCase(), W - 6, 6);
        ctx.textAlign = 'left';
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas ref={canvasRef} />
    </div>
  );
}
