// Native audio engine (Plan B foundation).
//
// Owns a cpal output stream on a dedicated control thread; the audio
// callback closure reads from an Arc<SharedState> using atomics so the
// real-time thread never blocks. Triggers cross the boundary through a
// lockfree SPSC ringbuf (control thread → audio callback).
//
// Phase 0: per-channel test tone.
// Phase 1a: sample voice mixer — WAV loader, 64-slot voice pool, linear
// interpolation, equal-power pan. Voices always render to channels 0+1
// of the open device for now; per-track output routing arrives in a
// later phase.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleRate, Stream, StreamConfig};
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::{Deserialize, Serialize};

use crate::delay::DelayBus;
use crate::reverb::ReverbBus;

// --- output level meter ---
//
// Audio thread writes the peak amplitude of the most recent block to this
// atomic on every callback. A tokio task on the main thread reads it at
// ~30Hz and emits `audio:level` Tauri events. Stored as `f32` bits via
// `to_bits()` / `from_bits()` since AtomicF32 isn't stable. Range is
// nominally 0..1; clipped output can exceed but the visualizer clamps.

static AUDIO_OUTPUT_LEVEL: AtomicU32 = AtomicU32::new(0);

pub fn audio_output_level() -> f32 {
  f32::from_bits(AUDIO_OUTPUT_LEVEL.load(Ordering::Relaxed))
}

// --- engine sample clock ---
//
// Monotonic frame counter for the open cpal stream — the app's master
// timebase. The audio callback advances it by the block size once per
// block; it resets to 0 on every stream (re)open. Everything absolute-
// time-scheduled (triggers, glitch fires) targets a frame on THIS
// counter, so fire times are exact regardless of which block drains the
// command. JS mirrors it via the `audio:time` event (lib.rs emitter) +
// the `audio_engine_time` poll command, extrapolating between events
// with performance.now().
//
// Single writer (the audio callback); plain load/store is sufficient.

static ENGINE_FRAMES: AtomicU64 = AtomicU64::new(0);

// Stream generation — bumped once per build_stream. The callback only
// advances ENGINE_FRAMES (and consumes clock-targeted state like the
// glitch fire_at slot) when its own generation is still current, so a
// zombie stream (macOS: a dropped cpal stream's callback can keep
// running — observed live 2026-07-05 when the dev double-open left two
// streams counting the clock at 2x) renders but never touches the
// timebase.
static ENGINE_STREAM_GEN: AtomicU32 = AtomicU32::new(0);

pub fn engine_frames() -> u64 {
  ENGINE_FRAMES.load(Ordering::Relaxed)
}

// --- device + open metadata ---

#[derive(Debug, Serialize, Clone)]
pub struct DeviceInfo {
  pub name: String,
  pub is_default: bool,
  pub max_output_channels: u32,
  pub default_sample_rate: u32,
  pub supported_sample_rates: Vec<u32>,
  pub min_buffer_size: Option<u32>,
  pub max_buffer_size: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct OpenedInfo {
  pub device_name: String,
  pub channels: u32,
  pub sample_rate: u32,
  pub buffer_size: u32,
}

// --- sample data + registry ---

#[derive(Debug, Clone)]
pub struct SampleData {
  pub channels: u16,
  pub sample_rate: u32,
  pub frames: Vec<f32>, // interleaved if stereo
}

impl SampleData {
  pub fn frame_count(&self) -> usize {
    self.frames.len() / (self.channels.max(1) as usize)
  }
}

// Snap an INTERIOR slice/trim boundary back to the nearest zero crossing at or
// before `target` (searching up to `window` source frames), so a one-shot that
// starts or stops mid-waveform doesn't step from/to a non-zero value and click.
// Backward-biased on purpose: a slice cut sits on a transient, so we only ever
// back up into the quieter pre-onset material — never forward past the attack
// peak, which would soften the hit. Mono-summed so the test is channel-agnostic.
// Returns `target` unchanged when no crossing is found in the window (the caller
// only snaps genuine interior cuts, and the ~1ms declick fade covers the rest).
fn snap_zero_crossing_back(sample: &SampleData, target: f64, window: usize) -> f64 {
  let ch = sample.channels.max(1) as usize;
  let fc = sample.frame_count();
  if fc < 2 || window == 0 {
    return target;
  }
  let t = (target.round() as isize).clamp(1, (fc - 1) as isize);
  let mono = |f: isize| -> f32 {
    let base = f as usize * ch;
    let mut s = 0.0f32;
    for c in 0..ch {
      s += sample.frames[base + c];
    }
    s
  };
  let lo = (t - window as isize).max(1);
  let mut f = t;
  let mut cur = mono(f);
  while f > lo {
    let prev = mono(f - 1);
    // Sign change (or a sample landing on zero) between f-1 and f → crossing.
    if (prev <= 0.0 && cur >= 0.0) || (prev >= 0.0 && cur <= 0.0) {
      return f as f64;
    }
    cur = prev;
    f -= 1;
  }
  target
}

#[derive(Debug, Serialize, Clone)]
pub struct SampleLoadInfo {
  pub path: String,
  pub channels: u16,
  pub sample_rate: u32,
  pub frames: u32,
  pub duration_secs: f32,
}

static SAMPLES: OnceLock<Mutex<HashMap<String, Arc<SampleData>>>> = OnceLock::new();

fn samples_registry() -> &'static Mutex<HashMap<String, Arc<SampleData>>> {
  SAMPLES.get_or_init(|| Mutex::new(HashMap::new()))
}

// --- wavetable smoother ---
// App-side equivalent of the Tracker's "Wavetable Smoother" tool. Arbitrary
// (non-wavetable-formatted) samples looped as single cycles are intrinsically
// crunchy — transient-dense windows read as rough buzz (measured 2026-07-12:
// read-delta bursts >0.1 FS whenever the scan sat in a pad's attack region).
// A voice triggering with wt_on + wt_smooth reads a BAKED variant instead:
// each windowFrames slice is treated as one cycle and smoothed with a
// CIRCULAR triangular kernel (two passes of a circular moving average, total
// width ~wf/16 → keeps roughly the first 16 harmonics). Periodic filtering
// makes every cycle exactly loop-continuous AND rounds intra-window
// transients — the two things arbitrary samples lack. Each window is then
// RMS-matched to its source (makeup capped 4×) so the table keeps its level
// contour without near-silent windows blowing up. Bakes run on the COMMAND
// thread (never the audio thread), once per (sample identity, window size);
// the source sample in the registry is untouched.
fn wavetable_smoothed(src: &Arc<SampleData>, window_frames: f32) -> Arc<SampleData> {
  static CACHE: OnceLock<Mutex<HashMap<(usize, usize, u32), Arc<SampleData>>>> =
    OnceLock::new();
  let fc = src.frame_count();
  let wf = (window_frames.max(2.0) as f64).min((fc as f64 - 2.0).max(2.0)) as usize;
  if wf < 8 || fc < wf {
    return src.clone();
  }
  // Key on Arc identity + length: registry reloads at a recycled address
  // with a different frame count can't alias.
  let key = (Arc::as_ptr(src) as usize, src.frames.len(), wf as u32);
  let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
  if let Some(hit) = cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
    return hit;
  }
  let ch = src.channels.max(1) as usize;
  let window_count = fc / wf;
  let mut frames = src.frames.clone();
  // Half-width per pass; 2 passes ≈ triangle of ~wf/4 → keeps only the first
  // ~4 harmonics of each cycle. Deliberately STRONG (Chris 2026-07-12: "the
  // source really doesn't matter, smooth it to whatever works") — the toggle
  // turns any material into a soft, oscillator-like tone that cannot rasp,
  // especially at the small windows (128/256) he actually plays.
  let h = (wf / 16).max(1);
  let len = (2 * h + 1) as f64;
  let mut cyc = vec![0.0f32; wf];
  let mut tmp = vec![0.0f32; wf];
  let mut prefix = vec![0.0f64; wf + 1];
  for w in 0..window_count {
    let base = w * wf;
    for c in 0..ch {
      for i in 0..wf {
        cyc[i] = frames[(base + i) * ch + c];
      }
      let in_sq: f64 = cyc.iter().map(|v| (*v as f64) * (*v as f64)).sum();
      for _pass in 0..2 {
        prefix[0] = 0.0;
        for i in 0..wf {
          prefix[i + 1] = prefix[i] + cyc[i] as f64;
        }
        let total = prefix[wf];
        for i in 0..wf {
          let a = i as isize - h as isize;
          let b = i as isize + h as isize;
          let sum = if a >= 0 && (b as usize) < wf {
            prefix[b as usize + 1] - prefix[a as usize]
          } else {
            // kernel wraps the cycle boundary: tail of the cycle + head
            let a_m = a.rem_euclid(wf as isize) as usize;
            let b_m = b.rem_euclid(wf as isize) as usize;
            (total - prefix[a_m]) + prefix[b_m + 1]
          };
          tmp[i] = (sum / len) as f32;
        }
        std::mem::swap(&mut cyc, &mut tmp);
      }
      let out_sq: f64 = cyc.iter().map(|v| (*v as f64) * (*v as f64)).sum();
      let g = if out_sq > 1e-12 {
        ((in_sq / out_sq).sqrt() as f32).min(4.0)
      } else {
        1.0
      };
      for i in 0..wf {
        frames[(base + i) * ch + c] = cyc[i] * g;
      }
    }
  }
  let baked = Arc::new(SampleData {
    channels: src.channels,
    sample_rate: src.sample_rate,
    frames,
  });
  if let Ok(mut c) = cache.lock() {
    c.insert(key, baked.clone());
  }
  baked
}

fn load_wav(path: &str) -> Result<SampleData, String> {
  let reader = hound::WavReader::open(Path::new(path))
    .map_err(|e| format!("open wav: {}", e))?;
  decode_wav(reader)
}

fn load_wav_from_bytes(bytes: &[u8]) -> Result<SampleData, String> {
  let reader = hound::WavReader::new(Cursor::new(bytes))
    .map_err(|e| format!("read wav bytes: {}", e))?;
  decode_wav(reader)
}

fn decode_wav<R: std::io::Read>(mut reader: hound::WavReader<R>) -> Result<SampleData, String> {
  let spec = reader.spec();
  let channels = spec.channels;
  let sample_rate = spec.sample_rate;
  if sample_rate == 0 {
    return Err("wav reports sample_rate = 0".into());
  }

  let mut frames: Vec<f32> = match spec.sample_format {
    hound::SampleFormat::Float => reader
      .samples::<f32>()
      .collect::<Result<_, _>>()
      .map_err(|e| format!("decode f32: {}", e))?,
    hound::SampleFormat::Int => {
      let bits = spec.bits_per_sample.max(1);
      // Hound's i32 decoder sign-extends to a 32-bit range scaled by
      // bits_per_sample. Normalize to [-1, 1] in f32.
      let scale = 1.0_f32 / ((1u32 << (bits - 1)) as f32);
      reader
        .samples::<i32>()
        .map(|s| s.map(|v| (v as f32) * scale))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("decode int: {}", e))?
    }
  };

  // Float-format WAVs can legally carry NaN/inf; one non-finite sample
  // riding a voice into the reverb send would latch the recursive tank
  // dead. Scrub at decode (command thread, one pass).
  for s in frames.iter_mut() {
    if !s.is_finite() {
      *s = 0.0;
    }
  }

  Ok(SampleData {
    channels,
    sample_rate,
    frames,
  })
}

// --- per-track filter params + ladder filter ---

// Shared per-track filter state. Cutoff arrives in normalized 0..1 space
// (matching the web `track.filterCutoff` store field); Rust maps to Hz
// internally via the same log curve as `cutoffNormToHz` (50..18000 Hz).
// LFO modulation happens in normalized space — the depth UI then maps
// to the same musical range JS expects.
//
// Phase 6: each modulated field has a `_base` atomic (the user-set knob,
// pushed via IPC) and an `_eff` atomic (the post-LFO value the audio
// thread reads). With no LFO routed, IPC sets both so eff == base.
// When an LFO is routed, the audio thread overwrites eff each block.
//
// Stored as Arc<TrackParams> so every voice triggered for the track holds
// the same reference and reads coefficient changes immediately (knob twists
// hit existing voices, not just future triggers).
pub struct TrackParams {
  // Cutoff in normalized 0..1 (base) and the resolved Hz (effective).
  // Voices apply the Hz value directly; the base→Hz mapping happens
  // either at IPC write time (no LFO) or in the LFO compute (LFO routed).
  cutoff_norm_base: AtomicU32,
  cutoff_hz_eff: AtomicU32,
  resonance_base: AtomicU32,
  resonance_eff: AtomicU32,
  // 0..1 — portion of the voice signal routed to the mangler FX bus
  // (tape → glitch → drive). The voice's dry signal is attenuated by
  // (1 - fx_send) and the wet contribution scaled by fx_send. Per-voice
  // mix, audio-rate atomic. Reverb is NO LONGER on this bus — see below.
  fx_send_base: AtomicU32,
  fx_send_eff: AtomicU32,
  // 0..1 — per-instrument REVERB send. An ADDITIVE aux send (dry stays
  // full, unlike fx_send's crossfade): the voice's full signal × reverb_send
  // taps into the parallel reverb return. Sourced from the instrument's
  // `reverbSend` voice param (saved with the instrument), pushed here per
  // track so knob twists hit voices already in flight. base/eff split so a
  // sequencer LFO can sweep the send continuously (TrackReverbSend dest).
  reverb_send_base: AtomicU32,
  reverb_send_eff: AtomicU32,
  // 0..1 — per-instrument DELAY send. Same additive-aux shape as reverb_send,
  // feeding the global ping-pong delay. base/eff split mirrors reverb_send so
  // it's an LFO automation target too (TrackDelaySend dest).
  delay_send_base: AtomicU32,
  delay_send_eff: AtomicU32,
  // Continuous tuning modulation (TrackTune / TrackFineTune LFO dests). The
  // STATIC tune/finetune is already baked into each voice's playback `rate` at
  // trigger (JS folds it into the trigger pitch); these add an LFO DEVIATION on
  // top, applied per-frame via `pitch_factor`. `*_base_norm` is the static knob
  // value normalized 0..1 (pushed per-track from the active voice) — the LFO
  // swings around it. `*_mod_semis` is the resulting deviation in SEMITONES the
  // audio thread reads (0 = no LFO routed; reset in the snap-back pass). Coarse
  // tune spans ±24 st (norm range 48), finetune ±1 st / ±100 ct (norm range 2).
  tune_base_norm: AtomicU32,
  tune_mod_semis: AtomicU32,
  finetune_base_norm: AtomicU32,
  finetune_mod_semis: AtomicU32,
  // Continuous wavetable-scan modulation (TrackWtPosition LFO dest). A bipolar
  // deviation (0 = no LFO) added to the wavetable voice's scan position EVERY
  // frame, so a routed LFO sweeps the window through a held note — the global
  // LFO on wtPosition behaves like an oscillator's wavetable-position mod, not a
  // per-note snapshot. Reset to 0 in the snap-back pass.
  wt_pos_mod: AtomicU32,
  // Stem-recording slot (1-based track index; 0 = not captured). Set per
  // track when a stems recording arms (start_recording_stems); voices
  // snapshot it at creation into Voice.rec_track so the per-track dry tap
  // reads a plain field on the hot path. 0 the rest of the time — no cost.
  rec_track: AtomicU32,
}

// Cutoff mapping mirrors src/audio/nativeEngine.ts cutoffNormToHz.
// 50 Hz at norm=0, 18 kHz at norm=1, log spacing in between.
const CUTOFF_MIN_HZ: f32 = 50.0;
const CUTOFF_MAX_HZ: f32 = 18000.0;
fn cutoff_norm_to_hz(norm: f32) -> f32 {
  let n = norm.clamp(0.0, 1.0);
  CUTOFF_MIN_HZ * (CUTOFF_MAX_HZ / CUTOFF_MIN_HZ).powf(n)
}

// Per-instrument filter resonance: norm 0..1 → biquad Q. Butterworth-flat
// (0.707) at the bottom up to a screaming ~25 at the top so the extreme is
// genuinely resonant, not just "musical" (per the broken-ranges intent).
fn resonance_norm_to_q(norm: f32) -> f32 {
  0.707 * 2.0_f32.powf(norm.clamp(0.0, 1.0) * 5.13)
}

impl TrackParams {
  fn new() -> Self {
    Self {
      cutoff_norm_base: AtomicU32::new(1.0_f32.to_bits()),
      cutoff_hz_eff: AtomicU32::new(CUTOFF_MAX_HZ.to_bits()),
      resonance_base: AtomicU32::new(0.0_f32.to_bits()),
      resonance_eff: AtomicU32::new(0.0_f32.to_bits()),
      fx_send_base: AtomicU32::new(0.0_f32.to_bits()),
      fx_send_eff: AtomicU32::new(0.0_f32.to_bits()),
      reverb_send_base: AtomicU32::new(0.0_f32.to_bits()),
      reverb_send_eff: AtomicU32::new(0.0_f32.to_bits()),
      delay_send_base: AtomicU32::new(0.0_f32.to_bits()),
      delay_send_eff: AtomicU32::new(0.0_f32.to_bits()),
      // Static tune/finetune both default to 0 → normalized 0.5 (the center).
      tune_base_norm: AtomicU32::new(0.5_f32.to_bits()),
      tune_mod_semis: AtomicU32::new(0.0_f32.to_bits()),
      finetune_base_norm: AtomicU32::new(0.5_f32.to_bits()),
      finetune_mod_semis: AtomicU32::new(0.0_f32.to_bits()),
      wt_pos_mod: AtomicU32::new(0.0_f32.to_bits()),
      rec_track: AtomicU32::new(0),
    }
  }
  fn rec_track(&self) -> u8 {
    self.rec_track.load(Ordering::Relaxed) as u8
  }
  fn set_rec_track(&self, slot: u8) {
    self.rec_track.store(slot as u32, Ordering::Relaxed);
  }
  fn cutoff(&self) -> f32 {
    f32::from_bits(self.cutoff_hz_eff.load(Ordering::Relaxed))
  }
  fn resonance(&self) -> f32 {
    f32::from_bits(self.resonance_eff.load(Ordering::Relaxed))
  }
  fn fx_send(&self) -> f32 {
    f32::from_bits(self.fx_send_eff.load(Ordering::Relaxed))
  }
  fn cutoff_norm_base(&self) -> f32 {
    f32::from_bits(self.cutoff_norm_base.load(Ordering::Relaxed))
  }
  fn resonance_base(&self) -> f32 {
    f32::from_bits(self.resonance_base.load(Ordering::Relaxed))
  }
  fn fx_send_base(&self) -> f32 {
    f32::from_bits(self.fx_send_base.load(Ordering::Relaxed))
  }
  fn reverb_send(&self) -> f32 {
    f32::from_bits(self.reverb_send_eff.load(Ordering::Relaxed))
  }
  fn reverb_send_base(&self) -> f32 {
    f32::from_bits(self.reverb_send_base.load(Ordering::Relaxed))
  }
  fn delay_send(&self) -> f32 {
    f32::from_bits(self.delay_send_eff.load(Ordering::Relaxed))
  }
  fn delay_send_base(&self) -> f32 {
    f32::from_bits(self.delay_send_base.load(Ordering::Relaxed))
  }
  // Tuning: base norms drive the LFO swing center; mod_semis is the deviation
  // the voice adds to its per-frame pitch. mod readers are Relaxed (k-rate).
  fn tune_base_norm(&self) -> f32 {
    f32::from_bits(self.tune_base_norm.load(Ordering::Relaxed))
  }
  fn tune_mod_semis(&self) -> f32 {
    f32::from_bits(self.tune_mod_semis.load(Ordering::Relaxed))
  }
  fn finetune_base_norm(&self) -> f32 {
    f32::from_bits(self.finetune_base_norm.load(Ordering::Relaxed))
  }
  fn finetune_mod_semis(&self) -> f32 {
    f32::from_bits(self.finetune_mod_semis.load(Ordering::Relaxed))
  }
  fn wt_pos_mod(&self) -> f32 {
    f32::from_bits(self.wt_pos_mod.load(Ordering::Relaxed))
  }
  // IPC writes the user-knob value to base AND the post-mapping/post-no-mod
  // value to effective. When an LFO is later routed, the audio thread
  // overwrites effective per block from base + mod.
  fn set_filter_norm(&self, cutoff_norm: f32, resonance: f32) {
    self
      .cutoff_norm_base
      .store(cutoff_norm.to_bits(), Ordering::Release);
    self
      .cutoff_hz_eff
      .store(cutoff_norm_to_hz(cutoff_norm).to_bits(), Ordering::Release);
    self
      .resonance_base
      .store(resonance.to_bits(), Ordering::Release);
    self
      .resonance_eff
      .store(resonance.to_bits(), Ordering::Release);
  }
  fn set_fx_send(&self, fx_send: f32) {
    self
      .fx_send_base
      .store(fx_send.to_bits(), Ordering::Release);
    self
      .fx_send_eff
      .store(fx_send.to_bits(), Ordering::Release);
  }
  fn set_reverb_send(&self, reverb_send: f32) {
    self
      .reverb_send_base
      .store(reverb_send.to_bits(), Ordering::Release);
    self
      .reverb_send_eff
      .store(reverb_send.to_bits(), Ordering::Release);
  }
  fn set_delay_send(&self, delay_send: f32) {
    self
      .delay_send_base
      .store(delay_send.to_bits(), Ordering::Release);
    self
      .delay_send_eff
      .store(delay_send.to_bits(), Ordering::Release);
  }
  // IPC writes the static tune/finetune (normalized) as the LFO swing center.
  // mod_semis is left to the audio thread (snap-back zeroes it, LFO compute
  // writes the deviation) — no need to touch it here.
  fn set_tuning(&self, tune_norm: f32, finetune_norm: f32) {
    self
      .tune_base_norm
      .store(tune_norm.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    self
      .finetune_base_norm
      .store(finetune_norm.clamp(0.0, 1.0).to_bits(), Ordering::Release);
  }
  // Writers used by the LFO compute (audio thread). Effective only —
  // base stays put so the next block can recompute from the same base.
  fn write_cutoff_norm_eff(&self, norm: f32) {
    self
      .cutoff_hz_eff
      .store(cutoff_norm_to_hz(norm).to_bits(), Ordering::Release);
  }
  fn write_resonance_eff(&self, v: f32) {
    self.resonance_eff.store(v.to_bits(), Ordering::Release);
  }
  fn write_fx_send_eff(&self, v: f32) {
    self.fx_send_eff.store(v.to_bits(), Ordering::Release);
  }
  fn write_reverb_send_eff(&self, v: f32) {
    self.reverb_send_eff.store(v.to_bits(), Ordering::Release);
  }
  fn write_delay_send_eff(&self, v: f32) {
    self.delay_send_eff.store(v.to_bits(), Ordering::Release);
  }
  // Tuning deviation writers (audio thread / LFO compute). Semitones.
  fn write_tune_mod_semis(&self, v: f32) {
    self.tune_mod_semis.store(v.to_bits(), Ordering::Release);
  }
  fn write_finetune_mod_semis(&self, v: f32) {
    self.finetune_mod_semis.store(v.to_bits(), Ordering::Release);
  }
  // Wavetable-scan deviation writer (audio thread / LFO compute). Bipolar
  // fraction added to the voice's scan (0 = no LFO).
  fn write_wt_pos_mod(&self, v: f32) {
    self.wt_pos_mod.store(v.to_bits(), Ordering::Release);
  }
}

static TRACK_PARAMS: OnceLock<Mutex<HashMap<String, Arc<TrackParams>>>> = OnceLock::new();

fn track_params_registry() -> &'static Mutex<HashMap<String, Arc<TrackParams>>> {
  TRACK_PARAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_or_create_track_params(track_id: &str) -> Arc<TrackParams> {
  let mut reg = track_params_registry().lock().expect("track params lock");
  reg
    .entry(track_id.to_string())
    .or_insert_with(|| Arc::new(TrackParams::new()))
    .clone()
}

// Clear every track's stem-recording slot (command thread only). Called at
// stems-take start before assigning fresh slots so no track carries a stale
// index from a prior take with a different track order.
fn reset_all_rec_tracks() {
  if let Ok(reg) = track_params_registry().lock() {
    for tp in reg.values() {
      tp.set_rec_track(0);
    }
  }
}

// --- reverb shared state ---
//
// One global reverb bus. Per-voice fx_send routes a portion of each
// voice's post-gain/pan signal into the reverb input; the wet output is
// added to channels 0+1. Params updated via IPC live in atomics so the
// audio callback can re-apply them block-by-block without locking.

pub struct ReverbState {
  // Phase 6: `*_base` is the user-set knob value (IPC writes); the
  // unsuffixed atomic is the effective (DSP-read). IPC writes both;
  // audio-thread LFO compute overwrites effective per block when routed.
  size_base: AtomicU32,
  size: AtomicU32,
  wet_gain_base: AtomicU32,
  wet_gain: AtomicU32,
  diffusion_base: AtomicU32,
  diffusion: AtomicU32,
  damping_base: AtomicU32,
  damping: AtomicU32,
}

impl ReverbState {
  fn new() -> Self {
    Self {
      size_base: AtomicU32::new(0.7_f32.to_bits()),
      size: AtomicU32::new(0.7_f32.to_bits()),
      wet_gain_base: AtomicU32::new(0.0_f32.to_bits()),
      // wet_gain defaults to 0 — silent until the user dials in a mix.
      wet_gain: AtomicU32::new(0.0_f32.to_bits()),
      diffusion_base: AtomicU32::new(0.625_f32.to_bits()),
      diffusion: AtomicU32::new(0.625_f32.to_bits()),
      damping_base: AtomicU32::new(0.4_f32.to_bits()),
      damping: AtomicU32::new(0.4_f32.to_bits()),
    }
  }
  // IPC write: store base AND effective so the no-LFO path works.
  fn ipc_set(&self, size: f32, wet_gain: f32, diffusion: f32, damping: f32) {
    let s = size.to_bits();
    self.size_base.store(s, Ordering::Release);
    self.size.store(s, Ordering::Release);
    let w = wet_gain.to_bits();
    self.wet_gain_base.store(w, Ordering::Release);
    self.wet_gain.store(w, Ordering::Release);
    let d = diffusion.to_bits();
    self.diffusion_base.store(d, Ordering::Release);
    self.diffusion.store(d, Ordering::Release);
    let dm = damping.to_bits();
    self.damping_base.store(dm, Ordering::Release);
    self.damping.store(dm, Ordering::Release);
  }
  fn size_base(&self) -> f32 {
    f32::from_bits(self.size_base.load(Ordering::Relaxed))
  }
  fn wet_gain_base(&self) -> f32 {
    f32::from_bits(self.wet_gain_base.load(Ordering::Relaxed))
  }
  fn diffusion_base(&self) -> f32 {
    f32::from_bits(self.diffusion_base.load(Ordering::Relaxed))
  }
  fn damping_base(&self) -> f32 {
    f32::from_bits(self.damping_base.load(Ordering::Relaxed))
  }
  fn write_size_eff(&self, v: f32) {
    self.size.store(v.to_bits(), Ordering::Release);
  }
  fn write_wet_gain_eff(&self, v: f32) {
    self.wet_gain.store(v.to_bits(), Ordering::Release);
  }
  fn write_diffusion_eff(&self, v: f32) {
    self.diffusion.store(v.to_bits(), Ordering::Release);
  }
  fn write_damping_eff(&self, v: f32) {
    self.damping.store(v.to_bits(), Ordering::Release);
  }
}

static REVERB_STATE: OnceLock<ReverbState> = OnceLock::new();

fn reverb_state() -> &'static ReverbState {
  REVERB_STATE.get_or_init(ReverbState::new)
}

// --- delay shared state ---
//
// Global ping-pong delay aux, sibling to the reverb. Per-voice `delay_send`
// taps an additive copy into the delay send bus; the wet return sums to
// channels 0+1 at unity. Time arrives as seconds (JS computes it from the
// note division + bpm); feedback is 0..~1.1. Single atomics — no LFO base/eff
// split yet (feedback LFO is a planned follow-up; add the split then).
pub struct DelayState {
  delay_seconds: AtomicU32,
  feedback: AtomicU32,
  pingpong: AtomicU32,
  lofi: AtomicU32,
}

impl DelayState {
  fn new() -> Self {
    Self {
      // 0 seconds → silent until JS pushes the synced time; 0 feedback.
      delay_seconds: AtomicU32::new(0.0_f32.to_bits()),
      feedback: AtomicU32::new(0.0_f32.to_bits()),
      pingpong: AtomicU32::new(1.0_f32.to_bits()),
      lofi: AtomicU32::new(0.0_f32.to_bits()),
    }
  }
  fn ipc_set(&self, delay_seconds: f32, feedback: f32, pingpong: f32, lofi: f32) {
    self
      .delay_seconds
      .store(delay_seconds.to_bits(), Ordering::Release);
    self.feedback.store(feedback.to_bits(), Ordering::Release);
    self.pingpong.store(pingpong.to_bits(), Ordering::Release);
    self.lofi.store(lofi.to_bits(), Ordering::Release);
  }
  fn delay_seconds(&self) -> f32 {
    f32::from_bits(self.delay_seconds.load(Ordering::Relaxed))
  }
  fn feedback(&self) -> f32 {
    f32::from_bits(self.feedback.load(Ordering::Relaxed))
  }
  fn pingpong(&self) -> f32 {
    f32::from_bits(self.pingpong.load(Ordering::Relaxed))
  }
  fn lofi(&self) -> f32 {
    f32::from_bits(self.lofi.load(Ordering::Relaxed))
  }
}

static DELAY_STATE: OnceLock<DelayState> = OnceLock::new();

fn delay_state() -> &'static DelayState {
  DELAY_STATE.get_or_init(DelayState::new)
}

// --- pre-saturation shared state ---
//
// Tanh waveshaper applied to the wet bus (reverb input) so the FX
// signal is driven before it hits the reverb tank. Matches the web
// architecture's pre-saturation stage between voicesBus (the wet bus)
// and voicesPostFX. Drive at 0 is a true no-op — no separate bypass
// flag, since fxSend=0 already keeps every voice off the wet bus and
// the saturation function short-circuits when drive < 0.001.
pub struct SaturationState {
  pre_drive_base: AtomicU32,
  pre_drive: AtomicU32,
}

impl SaturationState {
  fn new() -> Self {
    Self {
      pre_drive_base: AtomicU32::new(0.0_f32.to_bits()),
      pre_drive: AtomicU32::new(0.0_f32.to_bits()),
    }
  }
  fn ipc_set(&self, pre_drive: f32) {
    let v = pre_drive.to_bits();
    self.pre_drive_base.store(v, Ordering::Release);
    self.pre_drive.store(v, Ordering::Release);
  }
  fn pre_drive_base(&self) -> f32 {
    f32::from_bits(self.pre_drive_base.load(Ordering::Relaxed))
  }
  fn write_pre_drive_eff(&self, v: f32) {
    self.pre_drive.store(v.to_bits(), Ordering::Release);
  }
}

static SATURATION_STATE: OnceLock<SaturationState> = OnceLock::new();

fn saturation_state() -> &'static SaturationState {
  SATURATION_STATE.get_or_init(SaturationState::new)
}

// --- tape shared state ---
//
// Multi-head varispeed tape on the FX bus. v1 = single bed layer with
// position/length window + varispeed + gain + wet/dry mix; no grains,
// no reverse, no hold, no 2nd layer (those land in later phases).
// Captures the wet-bus input (downmixed to mono) continuously into an
// 8s ring buffer, reads back at the user-specified window with varispeed
// playback. Mix=0 passes the FX bus through unchanged; mix=1 replaces
// it with the tape bed entirely. The driven + reverbed path stays
// downstream — drive colours whatever the tape stage emits.
pub struct TapeState {
  // LFO-modulated fields: each has a base + effective pair (Phase 6).
  position_base: AtomicU32,
  position: AtomicU32,
  length_base: AtomicU32,
  length: AtomicU32,
  // Per-layer stretch (0.25..4 playback rate) and gain (0..1) — not
  // LFO-modulated, single atomic.
  stretch1: AtomicU32,
  gain1: AtomicU32,
  stretch2: AtomicU32,
  gain2: AtomicU32,
  mix_base: AtomicU32,
  mix: AtomicU32,
  reverse: AtomicBool,
  hold: AtomicBool,
  grain_rate_base: AtomicU32,
  grain_rate: AtomicU32,
  grain_mix_base: AtomicU32,
  grain_mix: AtomicU32,
}

impl TapeState {
  fn new() -> Self {
    Self {
      position_base: AtomicU32::new(0.3_f32.to_bits()),
      position: AtomicU32::new(0.3_f32.to_bits()),
      length_base: AtomicU32::new(0.7_f32.to_bits()),
      length: AtomicU32::new(0.7_f32.to_bits()),
      stretch1: AtomicU32::new(1.0_f32.to_bits()),
      gain1: AtomicU32::new(0.41_f32.to_bits()),
      stretch2: AtomicU32::new(0.5_f32.to_bits()),
      gain2: AtomicU32::new(0.8_f32.to_bits()),
      mix_base: AtomicU32::new(0.0_f32.to_bits()),
      mix: AtomicU32::new(0.0_f32.to_bits()),
      reverse: AtomicBool::new(true),
      hold: AtomicBool::new(false),
      grain_rate_base: AtomicU32::new(0.23_f32.to_bits()),
      grain_rate: AtomicU32::new(0.23_f32.to_bits()),
      grain_mix_base: AtomicU32::new(0.3_f32.to_bits()),
      grain_mix: AtomicU32::new(0.3_f32.to_bits()),
    }
  }
  fn position_base(&self) -> f32 {
    f32::from_bits(self.position_base.load(Ordering::Relaxed))
  }
  fn length_base(&self) -> f32 {
    f32::from_bits(self.length_base.load(Ordering::Relaxed))
  }
  fn mix_base(&self) -> f32 {
    f32::from_bits(self.mix_base.load(Ordering::Relaxed))
  }
  fn grain_rate_base(&self) -> f32 {
    f32::from_bits(self.grain_rate_base.load(Ordering::Relaxed))
  }
  fn grain_mix_base(&self) -> f32 {
    f32::from_bits(self.grain_mix_base.load(Ordering::Relaxed))
  }
  fn write_position_eff(&self, v: f32) {
    self.position.store(v.to_bits(), Ordering::Release);
  }
  fn write_length_eff(&self, v: f32) {
    self.length.store(v.to_bits(), Ordering::Release);
  }
  fn write_mix_eff(&self, v: f32) {
    self.mix.store(v.to_bits(), Ordering::Release);
  }
  fn write_grain_rate_eff(&self, v: f32) {
    self.grain_rate.store(v.to_bits(), Ordering::Release);
  }
  fn write_grain_mix_eff(&self, v: f32) {
    self.grain_mix.store(v.to_bits(), Ordering::Release);
  }
}

static TAPE_STATE: OnceLock<TapeState> = OnceLock::new();

fn tape_state() -> &'static TapeState {
  TAPE_STATE.get_or_init(TapeState::new)
}

// --- glitch shared state ---
//
// Clocked stutter stage in the FX bus. Direct port of
// `public/worklets/glitch-machine.js`. JS rolls the dice on every beat
// (scheduler.onStep) and calls `audio_glitch_fire` on a hit — keeps the
// chance / scheduler logic in TypeScript where the bar grid already
// lives, native side just owns the ring buffer + slice playback.
//
// `mix` is the wet level DURING a fire event (k-rate). Outside fires
// the stage passes through unchanged regardless of mix.
// `fire_requested` is the ASAP trigger flag (no target); audio thread
// polls on each block and clears once consumed. `fire_at_frame` is the
// beat-aligned path: an absolute ENGINE_FRAMES deadline (u64::MAX =
// none) that fires in the block containing that frame — so a dice roll
// scheduled a lookahead ahead of the audible beat lands ON the beat
// instead of ~SCHEDULE_AHEAD early. One pending slot, last-write-wins
// (fires come at beat rate, blocks are far denser).
const GLITCH_FIRE_NONE: u64 = u64::MAX;

pub struct GlitchState {
  mix_base: AtomicU32,
  mix: AtomicU32,
  fire_requested: AtomicBool,
  fire_at_frame: AtomicU64,
}

impl GlitchState {
  fn new() -> Self {
    Self {
      mix_base: AtomicU32::new(1.0_f32.to_bits()),
      mix: AtomicU32::new(1.0_f32.to_bits()),
      fire_requested: AtomicBool::new(false),
      fire_at_frame: AtomicU64::new(GLITCH_FIRE_NONE),
    }
  }
  fn ipc_set(&self, mix: f32) {
    let v = mix.to_bits();
    self.mix_base.store(v, Ordering::Release);
    self.mix.store(v, Ordering::Release);
  }
  fn mix_base(&self) -> f32 {
    f32::from_bits(self.mix_base.load(Ordering::Relaxed))
  }
  fn write_mix_eff(&self, v: f32) {
    self.mix.store(v.to_bits(), Ordering::Release);
  }
}

static GLITCH_STATE: OnceLock<GlitchState> = OnceLock::new();

fn glitch_state() -> &'static GlitchState {
  GLITCH_STATE.get_or_init(GlitchState::new)
}

// --- master shared state ---
//
// Final-stage tone-shaping unit applied to buf[0]/buf[1] after the FX
// bus output has been mixed in. Phase 7e-1 ships the static character
// shaping: input gain → 5Hz DC block → lo-cut HPF → hi-cut LPF →
// trim → always-on -1dB peak at 450Hz. Compressor / distortion / gate
// land in later 7e phases between lo-cut and hi-cut.
//
// `input` 0..1 → -12..+18 dB (linearized via 10^(db/20)).
// `lo_cut` 0..3 → [Flat (1Hz), 75Hz, 150Hz, 300Hz] — Flat is rendered
//   as a near-DC HPF kept in the chain so toggling doesn't reconnect.
// `hi_cut` 0..1 → 10..20000 Hz on a log curve (10 × 2000^v).
// `trim`  0..1 → -24..0 dB.
pub struct MasterState {
  // Phase 6: every LFO-modulated field has a _base alongside the
  // effective. lo_cut/comp_attack/comp_release/dist_mode/gate_enabled/
  // bypass are discrete or boolean — no LFO route, single atomic.
  input_base: AtomicU32,
  input: AtomicU32,
  lo_cut: AtomicU32,
  hi_cut_base: AtomicU32,
  hi_cut: AtomicU32,
  trim_base: AtomicU32,
  trim: AtomicU32,
  comp_amount_base: AtomicU32,
  comp_amount: AtomicU32,
  comp_attack: AtomicU32,
  comp_release: AtomicU32,
  dist_mode: AtomicU32,
  dist_drive_base: AtomicU32,
  dist_drive: AtomicU32,
  // Bias is stored in its natural 0..0.2 range. LFO compute normalizes
  // to 0..1 before applying mod, then scales back — matches the web
  // `bias/0.2 → modulate → ×0.2` pattern in App.tsx so depth UI stays
  // meaningful.
  dist_bias_base: AtomicU32,
  dist_bias: AtomicU32,
  dist_mix_base: AtomicU32,
  dist_mix: AtomicU32,
  gate_enabled: AtomicBool,
  gate_threshold_base: AtomicU32,
  gate_threshold: AtomicU32,
  bypass: AtomicBool,
}

impl MasterState {
  fn new() -> Self {
    let dup = |v: f32| (AtomicU32::new(v.to_bits()), AtomicU32::new(v.to_bits()));
    let (input_base, input) = dup(0.52);
    let (hi_cut_base, hi_cut) = dup(0.97);
    let (trim_base, trim) = dup(0.725);
    let (comp_amount_base, comp_amount) = dup(0.80);
    let (dist_drive_base, dist_drive) = dup(0.34);
    let (dist_bias_base, dist_bias) = dup(0.082);
    let (dist_mix_base, dist_mix) = dup(0.66);
    let (gate_threshold_base, gate_threshold) = dup(0.80);
    Self {
      input_base,
      input,
      lo_cut: AtomicU32::new(1),
      hi_cut_base,
      hi_cut,
      trim_base,
      trim,
      comp_amount_base,
      comp_amount,
      comp_attack: AtomicU32::new(4),  // 10 ms
      comp_release: AtomicU32::new(5), // 10 s
      dist_mode: AtomicU32::new(0),    // boost
      dist_drive_base,
      dist_drive,
      dist_bias_base,
      dist_bias,
      dist_mix_base,
      dist_mix,
      gate_enabled: AtomicBool::new(false),
      gate_threshold_base,
      gate_threshold,
      bypass: AtomicBool::new(false),
    }
  }
  fn ipc_set_filters(&self, input: f32, lo_cut: u32, hi_cut: f32, trim: f32) {
    let i = input.to_bits();
    self.input_base.store(i, Ordering::Release);
    self.input.store(i, Ordering::Release);
    self.lo_cut.store(lo_cut, Ordering::Release);
    let h = hi_cut.to_bits();
    self.hi_cut_base.store(h, Ordering::Release);
    self.hi_cut.store(h, Ordering::Release);
    let t = trim.to_bits();
    self.trim_base.store(t, Ordering::Release);
    self.trim.store(t, Ordering::Release);
  }
  fn ipc_set_comp(&self, amount: f32, attack_idx: u32, release_idx: u32) {
    let a = amount.to_bits();
    self.comp_amount_base.store(a, Ordering::Release);
    self.comp_amount.store(a, Ordering::Release);
    self.comp_attack.store(attack_idx, Ordering::Release);
    self.comp_release.store(release_idx, Ordering::Release);
  }
  fn ipc_set_dist(&self, mode: u32, drive: f32, bias: f32, mix: f32) {
    self.dist_mode.store(mode, Ordering::Release);
    let d = drive.to_bits();
    self.dist_drive_base.store(d, Ordering::Release);
    self.dist_drive.store(d, Ordering::Release);
    let b = bias.to_bits();
    self.dist_bias_base.store(b, Ordering::Release);
    self.dist_bias.store(b, Ordering::Release);
    let m = mix.to_bits();
    self.dist_mix_base.store(m, Ordering::Release);
    self.dist_mix.store(m, Ordering::Release);
  }
  fn ipc_set_gate(&self, enabled: bool, threshold: f32) {
    self.gate_enabled.store(enabled, Ordering::Release);
    let t = threshold.to_bits();
    self.gate_threshold_base.store(t, Ordering::Release);
    self.gate_threshold.store(t, Ordering::Release);
  }
  fn input_base(&self) -> f32 {
    f32::from_bits(self.input_base.load(Ordering::Relaxed))
  }
  fn hi_cut_base(&self) -> f32 {
    f32::from_bits(self.hi_cut_base.load(Ordering::Relaxed))
  }
  fn trim_base(&self) -> f32 {
    f32::from_bits(self.trim_base.load(Ordering::Relaxed))
  }
  fn comp_amount_base(&self) -> f32 {
    f32::from_bits(self.comp_amount_base.load(Ordering::Relaxed))
  }
  fn dist_drive_base(&self) -> f32 {
    f32::from_bits(self.dist_drive_base.load(Ordering::Relaxed))
  }
  fn dist_bias_base(&self) -> f32 {
    f32::from_bits(self.dist_bias_base.load(Ordering::Relaxed))
  }
  fn dist_mix_base(&self) -> f32 {
    f32::from_bits(self.dist_mix_base.load(Ordering::Relaxed))
  }
  fn gate_threshold_base(&self) -> f32 {
    f32::from_bits(self.gate_threshold_base.load(Ordering::Relaxed))
  }
  fn write_input_eff(&self, v: f32) {
    self.input.store(v.to_bits(), Ordering::Release);
  }
  fn write_hi_cut_eff(&self, v: f32) {
    self.hi_cut.store(v.to_bits(), Ordering::Release);
  }
  fn write_trim_eff(&self, v: f32) {
    self.trim.store(v.to_bits(), Ordering::Release);
  }
  fn write_comp_amount_eff(&self, v: f32) {
    self.comp_amount.store(v.to_bits(), Ordering::Release);
  }
  fn write_dist_drive_eff(&self, v: f32) {
    self.dist_drive.store(v.to_bits(), Ordering::Release);
  }
  fn write_dist_bias_eff(&self, v: f32) {
    self.dist_bias.store(v.to_bits(), Ordering::Release);
  }
  fn write_dist_mix_eff(&self, v: f32) {
    self.dist_mix.store(v.to_bits(), Ordering::Release);
  }
  fn write_gate_threshold_eff(&self, v: f32) {
    self.gate_threshold.store(v.to_bits(), Ordering::Release);
  }
}

static MASTER_STATE: OnceLock<MasterState> = OnceLock::new();

fn master_state() -> &'static MasterState {
  MASTER_STATE.get_or_init(MasterState::new)
}

// --- recorder shared state (phase 7f-1) ---
//
// Combined recording = streaming write of the post-master stereo bus
// (buf channels 0+1) to a WAV file. Audio thread pushes interleaved
// i16 samples into a lock-free ring; a worker thread drains and writes
// to disk via hound. Memory caps the queue at ~5s of stereo audio at
// 48k (480_000 samples) — far more headroom than the worker thread's
// 5ms drain cadence ever needs.
//
// Split recording (7f-2) reuses the same pattern with two additional
// queues for rhythm/melody section buses.
// Maximum per-track stems in a full-stems recording (matches the 16-track
// grid). A stems take captures up to this many dry per-track WAVs plus the
// master / fx / reverb / delay bus WAVs — all sample-locked (one command).
const MAX_STEMS: usize = 16;

// Static worker labels for per-track stems (spawn_recorder_worker wants a
// &'static str for the finalize payload). Index i → the i-th track's stem.
const STEM_LABELS: [&str; MAX_STEMS] = [
  "track01", "track02", "track03", "track04", "track05", "track06", "track07",
  "track08", "track09", "track10", "track11", "track12", "track13", "track14",
  "track15", "track16",
];

pub struct RecorderState {
  // Mirror of audio-thread state for IPC introspection ("is recording
  // armed?"). Set true by start, cleared by stop.
  combined_enabled: AtomicBool,
  splits_enabled: AtomicBool,
  stems_enabled: AtomicBool,
  // Per-recording worker stop flags. Single-recording-at-a-time per
  // mode so one shared flag per stream is fine. `stems_stop` is shared
  // by ALL workers in a stems take (master + tracks + fx + reverb + delay)
  // so one flag finalizes the whole set.
  combined_stop: Arc<AtomicBool>,
  splits_stop: Arc<AtomicBool>,
  stems_stop: Arc<AtomicBool>,
}

impl RecorderState {
  fn new() -> Self {
    Self {
      combined_enabled: AtomicBool::new(false),
      splits_enabled: AtomicBool::new(false),
      stems_enabled: AtomicBool::new(false),
      combined_stop: Arc::new(AtomicBool::new(false)),
      splits_stop: Arc::new(AtomicBool::new(false)),
      stems_stop: Arc::new(AtomicBool::new(false)),
    }
  }
}

static RECORDER_STATE: OnceLock<RecorderState> = OnceLock::new();

// Stop-flag of the loop bounce in flight (if any) — reachable from the
// stream-teardown path, which can't see the audio thread's locals. Without
// this, closing/reopening the device mid-bounce would leave the worker
// spinning forever on an open file.
fn loop_bounce_teardown() -> &'static Mutex<Option<Arc<AtomicBool>>> {
  static CELL: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
  CELL.get_or_init(|| Mutex::new(None))
}

fn recorder_state() -> &'static RecorderState {
  RECORDER_STATE.get_or_init(RecorderState::new)
}

// Frame-atomic recorder push. Only whole L/R pairs enter the ring — under
// ring-full pressure (stalled worker) a half-pushed frame would offset the
// interleave and channel-swap the remainder of the take; dropping the whole
// frame leaves a gap instead. Samples are 32-bit float (no clip): stems
// hotter than 0dBFS survive intact for the DAW to trim.
#[inline]
fn push_rec_frame(prod: &mut HeapProd<f32>, l: f32, r: f32) {
  if prod.vacant_len() >= 2 {
    let _ = prod.try_push(l);
    let _ = prod.try_push(r);
  }
}

// --- count-in click samples ---
//
// Mirrors web `audio/clickIn.ts` — short 50ms square-wave pulse with a
// 1ms attack + exp-decay envelope. Generated at the device sample
// rate when audio_open_device succeeds; registered under the synthetic
// paths `__click_accent` (1500Hz, gain 0.6) and `__click_beat` (1000Hz,
// gain 0.4) so JS can trigger them via the existing `triggerSample`
// IPC with `delaySecs` for sample-accurate scheduling.
const CLICK_PATH_ACCENT: &str = "__click_accent";
const CLICK_PATH_BEAT: &str = "__click_beat";
const CLICK_DURATION_SECS: f32 = 0.05;
const CLICK_FLOOR: f32 = 0.0001;

fn synthesize_click(sample_rate: u32, freq_hz: f32, peak_gain: f32) -> SampleData {
  let frame_count = (sample_rate as f32 * CLICK_DURATION_SECS) as usize;
  let attack_samples = (sample_rate as f32 * 0.001) as usize; // 1ms
  // Exponential decay from peak → FLOOR over the remaining samples,
  // computed per-sample as peak * (FLOOR/peak)^(t/decay_samples).
  let decay_samples = frame_count.saturating_sub(attack_samples).max(1);
  let decay_ratio = (CLICK_FLOOR / peak_gain).max(1e-6);
  let mut frames = Vec::with_capacity(frame_count);
  let period_samples = sample_rate as f32 / freq_hz;
  for i in 0..frame_count {
    // Square wave: sign of sin(2π·f·t). Cheap: compare phase to π.
    let phase = ((i as f32) % period_samples) / period_samples;
    let sq = if phase < 0.5 { 1.0 } else { -1.0 };
    // Envelope: linear ramp up over attack, exp decay through end.
    let env = if i < attack_samples {
      peak_gain * (i as f32 + 1.0) / (attack_samples as f32)
    } else {
      let t = (i - attack_samples) as f32 / decay_samples as f32;
      peak_gain * decay_ratio.powf(t)
    };
    frames.push(sq * env);
  }
  SampleData {
    channels: 1,
    sample_rate,
    frames,
  }
}

#[derive(serde::Serialize, Clone)]
struct RecorderFinalizedPayload {
  label: &'static str,
  path: String,
  duration_secs: f32,
}

// Worker thread that drains a HeapRb consumer of i16 samples into a
// hound WavWriter. Tight loop with 5ms sleep tick + stop-flag check.
// Final drain after stop catches anything pushed between the audio
// thread observing StopX and the stop flag being set. On successful
// finalize, emits `recorder:finalized` so JS can show a toast.
fn spawn_recorder_worker(
  app: tauri::AppHandle,
  label: &'static str,
  path: String,
  writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
  mut cons: HeapCons<f32>,
  stop_flag: Arc<AtomicBool>,
) {
  use tauri::Emitter;
  // Sample rate snapshot for the duration calc below.
  let sample_rate = writer.spec().sample_rate.max(1);
  let channels = writer.spec().channels.max(1) as u32;
  thread::spawn(move || {
    let mut writer = writer;
    // Track sample writes so we can report duration on finalize.
    // hound's WavWriter consumes itself on .finalize() so we can't
    // query it after — keep our own counter.
    let mut samples_written: u64 = 0;
    loop {
      while let Some(sample) = cons.try_pop() {
        if let Err(e) = writer.write_sample(sample) {
          log::error!("[recorder/{}] write sample failed: {}", label, e);
          break;
        }
        samples_written += 1;
      }
      if stop_flag.load(Ordering::Acquire) {
        break;
      }
      thread::sleep(std::time::Duration::from_millis(5));
    }
    while let Some(sample) = cons.try_pop() {
      if let Err(e) = writer.write_sample(sample) {
        log::error!("[recorder/{}] write sample failed: {}", label, e);
        break;
      }
      samples_written += 1;
    }
    match writer.finalize() {
      Err(e) => {
        log::error!(
          "[recorder/{}] finalize '{}' failed: {}",
          label, path, e
        );
      }
      Ok(()) => {
        log::info!("[recorder/{}] wav finalized: {}", label, path);
        // Convert samples (interleaved across channels) → frames → seconds.
        let frames = samples_written / channels as u64;
        let duration_secs = (frames as f32) / (sample_rate as f32);
        let payload = RecorderFinalizedPayload {
          label,
          path: path.clone(),
          duration_secs,
        };
        if let Err(e) = app.emit("recorder:finalized", payload) {
          log::warn!(
            "[recorder/{}] failed to emit finalized event: {}",
            label, e
          );
        }
      }
    }
  });
}

fn register_click_samples(sample_rate: u32) {
  let accent = synthesize_click(sample_rate, 1500.0, 0.6);
  let beat = synthesize_click(sample_rate, 1000.0, 0.4);
  if let Ok(mut registry) = samples_registry().lock() {
    registry.insert(CLICK_PATH_ACCENT.to_string(), Arc::new(accent));
    registry.insert(CLICK_PATH_BEAT.to_string(), Arc::new(beat));
  }
}

const MASTER_LO_CUT_FREQS: [f32; 4] = [1.0, 75.0, 150.0, 300.0];
const MASTER_DC_BLOCK_HZ: f32 = 5.0;
const MASTER_TAIL_EQ_HZ: f32 = 450.0;
const MASTER_TAIL_EQ_Q: f32 = 0.7;
const MASTER_TAIL_EQ_GAIN_DB: f32 = -1.0;

// Compressor static tables — index 0..5 selects from these.
const MASTER_COMP_ATTACK_MS: [f32; 6] = [0.1, 0.3, 1.0, 3.0, 10.0, 30.0];
const MASTER_COMP_RELEASE_MS: [f32; 6] =
  [30.0, 100.0, 300.0, 1000.0, 3000.0, 10000.0];
// BOUM compressor constants (direct port of public/worklets/master-compressor.js).
const MASTER_COMP_KNEE_DB: f32 = 6.0;
const MASTER_COMP_ACTIVE_GR_DB: f32 = 0.5;
const MASTER_COMP_FAST_RELEASE_FACTOR: f32 = 0.5;
const MASTER_COMP_SLOW_RELEASE_FACTOR: f32 = 2.0;
const MASTER_COMP_ACTIVE_FAST_MS: f32 = 100.0;
const MASTER_COMP_ACTIVE_SLOW_MS: f32 = 500.0;
const MASTER_COMP_GR_SAT_SCALE: f32 = 0.05;

// Distortion (phase 7e-3) — direct port of master-distortion.js.
const MASTER_DIST_NUM_MODES: u32 = 4;
const MASTER_DIST_MODE_BOOST: u32 = 0;
const MASTER_DIST_MODE_TUBE: u32 = 1;
const MASTER_DIST_MODE_FUZZ: u32 = 2;
const MASTER_DIST_MODE_SQUARE: u32 = 3;
const MASTER_DIST_DRIVE_CEIL: [f32; 4] = [6.0, 4.0, 5.0, 8.0];
const MASTER_DIST_MEMORY: [f32; 4] = [0.05, 0.18, 0.10, 0.0];
const MASTER_DIST_POST_LP: [f32; 4] = [0.0, 0.5, 0.0, 0.18];
const MASTER_DIST_OUTPUT_TRIM: [f32; 4] = [1.0, 0.9, 0.65, 0.55];
const MASTER_DIST_NOISE: [f32; 4] = [0.0003, 0.0005, 0.0008, 0.0003];
// Stereo mismatch (~0.5%). Cumulative across the chain → natural width.
const MASTER_DIST_STEREO_DRIVE: [f32; 2] = [1.0, 1.005];
const MASTER_DIST_STEREO_BIAS: [f32; 2] = [1.0, 0.995];
// Drift LFO on bias for asymmetric modes (Tube/Fuzz). ±0.002 amplitude,
// 0.13/0.19 Hz per channel, phase offset on R for decorrelation.
const MASTER_DIST_DRIFT_AMP: f32 = 0.002;
const MASTER_DIST_DRIFT_RATE_L: f32 = 0.13;
const MASTER_DIST_DRIFT_RATE_R: f32 = 0.19;
const MASTER_DIST_DRIFT_PHASE_R_INIT: f32 = std::f32::consts::PI * 0.37;
const MASTER_DIST_EMPHASIS_HZ: f32 = 3000.0;
const MASTER_DIST_EMPHASIS_DB: f32 = 4.0;

// Gate (phase 7e-4) — peak detector + attack/release envelope. Fast
// enough to find quiet moments between percussive transients (~250ms
// to drop 40dB at 25ms release) but slow enough not to flutter on
// low-frequency oscillation.
const MASTER_GATE_PEAK_RELEASE_MS: f32 = 25.0;
const MASTER_GATE_ATTACK_MS: f32 = 1.0;
const MASTER_GATE_RELEASE_MS: f32 = 30.0;

// Bypass crossfade ramp — 5ms linear slew of the wet/dry mix so toggling
// doesn't click. Equal-power (sin/cos) cross at the actual sample.
const MASTER_BYPASS_RAMP_MS: f32 = 5.0;

#[inline]
fn master_gate_threshold_db(v: f32) -> f32 {
  -30.0 + v.clamp(0.0, 1.0) * 30.0
}

// Per-sample nonlinearity for one of the 4 modes. Caller passes the
// effective bias (incl. drift + stereo mismatch) and the raw drive_n
// (0..1) since Square's threshold depends on it. Identical math to
// `MasterDistortionProcessor.applyMode`.
#[inline]
fn master_dist_apply_mode(input: f32, mode: u32, bias: f32, drive_n: f32) -> f32 {
  match mode {
    MASTER_DIST_MODE_BOOST => (input * 0.8).tanh(),
    MASTER_DIST_MODE_TUBE => {
      let biased = input + bias;
      let y_tanh = if biased >= 0.0 {
        (biased * 1.4).tanh()
      } else {
        (biased * 0.5).tanh() * 0.6
      };
      y_tanh - bias
    }
    MASTER_DIST_MODE_FUZZ => {
      let biased = input + bias;
      let mut s = biased / (1.0 + (biased * 0.6).abs());
      if s > 0.75 {
        s = 0.75 + (s - 0.75) * 0.15;
      } else if s < -0.75 {
        s = -0.75 + (s + 0.75) * 0.15;
      }
      let clamped = s.clamp(-0.9, 0.9);
      clamped - bias
    }
    MASTER_DIST_MODE_SQUARE => {
      let threshold = 0.35 * (1.0 - drive_n * 0.95);
      if input.abs() > threshold {
        input.signum() * 0.9
      } else {
        0.0
      }
    }
    _ => input,
  }
}

// Equal-power dry/wet gains for the distortion crossfade.
#[inline]
fn master_dist_mix_gains(mix: f32) -> (f32, f32) {
  let m = mix.clamp(0.0, 1.0);
  let theta = m * std::f32::consts::FRAC_PI_2;
  (theta.cos(), theta.sin())
}

#[inline]
fn master_input_linear(v: f32) -> f32 {
  let db = -12.0 + v.clamp(0.0, 1.0) * 30.0;
  10.0_f32.powf(db / 20.0)
}

#[inline]
fn master_trim_linear(v: f32) -> f32 {
  let db = -24.0 + v.clamp(0.0, 1.0) * 24.0;
  10.0_f32.powf(db / 20.0)
}

#[inline]
fn master_hi_cut_hz(v: f32) -> f32 {
  10.0 * 2000.0_f32.powf(v.clamp(0.0, 1.0))
}

#[inline]
fn master_lo_cut_index(v: u32) -> usize {
  (v as usize).min(MASTER_LO_CUT_FREQS.len() - 1)
}

// Maps the one-knob `amount` to (threshDb, slope, makeupDb).
// First 60% of knob is gentle (linear), last 40% accelerates via sqrt.
// Past amount=0.9 the slope crosses zero (brick-wall limiter) and goes
// negative — louder input → quieter output (BOUM signature). Direct
// port of the worklet's `amountToParams`.
#[inline]
fn master_comp_amount_to_params(amount: f32) -> (f32, f32, f32) {
  let a = amount.clamp(0.0, 1.0);
  let shaped = if a <= 0.6 {
    a * 0.5
  } else {
    let t = (a - 0.6) / 0.4;
    0.3 + t.sqrt() * 0.7
  };
  let thresh_db = -shaped * 30.0;
  let slope = if a <= 0.9 {
    let t = a / 0.9;
    let ratio = 1.0 + t * 19.0;
    1.0 / ratio
  } else {
    let t = (a - 0.9) / 0.1;
    0.05 - t * 1.05
  };
  let makeup_db = shaped * 18.0;
  (thresh_db, slope, makeup_db)
}

// Soft-knee gain reduction in dB given detected level (dB) and current
// threshold / slope. Quadratic ramp through the ±3dB knee.
#[inline]
fn master_comp_gr_db(level_db: f32, thresh_db: f32, slope: f32) -> f32 {
  let knee_start = thresh_db - MASTER_COMP_KNEE_DB * 0.5;
  let knee_end = thresh_db + MASTER_COMP_KNEE_DB * 0.5;
  if level_db <= knee_start {
    return 0.0;
  }
  let one_minus_slope = 1.0 - slope;
  if level_db >= knee_end {
    return one_minus_slope * (level_db - thresh_db);
  }
  let x = (level_db - knee_start) / MASTER_COMP_KNEE_DB;
  let target = one_minus_slope * (level_db - thresh_db);
  target * x * x
}

#[inline]
fn one_pole_coef(time_ms: f32, sample_rate: f32) -> f32 {
  // 1 - exp(-1 / (ms * 0.001 * sr)). Standard envelope follower coef.
  1.0 - (-1.0 / (time_ms.max(0.001) * 0.001 * sample_rate)).exp()
}

// Web saturation.ts builds a WaveShaperNode curve: y = tanh(k*x) /
// tanh(k), where k = 1 + drive^2 * 30. Quadratic on drive keeps the
// 0..0.5 range warm and 0.5..1 crushing hard. Post-gain = 1 / (1 +
// drive * 0.9) compensates for the energy boost the saturator adds.
// Skip oversampling for now (Web Audio used 4x); the curve is smooth
// enough that aliasing isn't audible at typical drive levels. Bump if
// we hear it at extreme settings.
#[inline]
fn pre_saturate_sample(x: f32, drive: f32) -> f32 {
  if drive < 0.001 {
    return x;
  }
  let k = 1.0 + drive * drive * 30.0;
  let norm = k.tanh();
  let shaped = (k * x).tanh() / norm;
  let post_gain = 1.0 / (1.0 + drive * 0.9);
  shaped * post_gain
}

// --- tape buffer (audio-thread only) ---
//
// 8-second mono ring buffer with two varispeed read heads + an 8-slot
// grain pool. Direct port of `public/worklets/tape-machine.js`.
//
// Per-sample advance for each head:
//   hold  + reverse: +stretch         (read walks back through frozen buffer)
//   hold  + forward: -stretch         (read walks forward through frozen buffer)
//   !hold + reverse: 1 + stretch      (reverse against an advancing writer)
//   !hold + forward: 1 - stretch      (stretch=1 → 0 = live pitch)
//
// Boundary handling: when a head crosses windowMin/windowMax, the current
// `read_back` is snapshotted into a `ghost_rb` companion, the primary
// wraps to the other side, and over the next 20ms the ghost fades out
// while the primary fades in. Same trick is used to snap heads back into
// the window when fast knob jumps outrun the per-sample wrap. The window
// itself is smoothed with a one-pole filter (~100ms time constant) so
// fast scrubbing doesn't retrigger the ghost crossfade every block.
//
// Grain pool: each block rolls dice on a Poisson-ish spawn probability
// `(grain_rate * 16) * (block_duration_sec)`. Spawned grains pick a
// random offset within the window, a length in [167ms, 400ms], a
// quantized pitch ratio from {½, ⅔, 1, 1½, 2}×, and a side (L or R).
// Each grain plays once forward through its slice with a 50ms attack/
// release envelope (capped at 25% of grain length), then frees its slot.

const TAPE_LAYERS: usize = 2;
const TAPE_GRAIN_POOL: usize = 8;
const TAPE_GRAIN_LEN_MIN_SECS: f32 = 0.167;
const TAPE_GRAIN_LEN_MAX_SECS: f32 = 0.4;
const TAPE_GRAIN_FADE_SECS: f32 = 0.05;
const TAPE_GRAIN_RATES: [f32; 5] = [0.5, 0.6667, 1.0, 1.5, 2.0];
const TAPE_GRAIN_MIX_MAX: f32 = 0.65;
// 12 dB/oct Butterworth HPF on the tape output. Always on — carving low
// end out of the bed is a deliberate identity choice (web tape.ts
// comment): bass voices keep their full range on the dry path; the
// stretch2 octave-down layer would otherwise pull mid content into the
// bass band and muddy things.
const TAPE_HPF_HZ: f32 = 300.0;
const TAPE_HPF_Q: f32 = 0.707;

// One-channel biquad. State = two previous inputs + two previous
// outputs (Direct Form I). Coefficients are fixed at construction for
// the tape HPF since both fc and Q are constants.
#[derive(Clone, Copy)]
struct Biquad {
  b0: f32,
  b1: f32,
  b2: f32,
  a1: f32,
  a2: f32,
  x1: f32,
  x2: f32,
  y1: f32,
  y2: f32,
}

impl Biquad {
  fn new_unity() -> Self {
    // Pass-through (y = x) — useful as a default before coefficients are set.
    Self {
      b0: 1.0,
      b1: 0.0,
      b2: 0.0,
      a1: 0.0,
      a2: 0.0,
      x1: 0.0,
      x2: 0.0,
      y1: 0.0,
      y2: 0.0,
    }
  }

  fn highpass(sample_rate: f32, fc: f32, q: f32) -> Self {
    let mut b = Self::new_unity();
    b.set_highpass(sample_rate, fc, q);
    b
  }

  fn set_highpass(&mut self, sample_rate: f32, fc: f32, q: f32) {
    // RBJ Audio EQ Cookbook — HPF.
    let w0 = std::f32::consts::TAU * fc / sample_rate;
    let cos_w0 = w0.cos();
    let alpha = w0.sin() / (2.0 * q).max(1e-6);
    let a0 = 1.0 + alpha;
    let b0 = (1.0 + cos_w0) * 0.5;
    let b1 = -(1.0 + cos_w0);
    let b2 = (1.0 + cos_w0) * 0.5;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha;
    self.b0 = b0 / a0;
    self.b1 = b1 / a0;
    self.b2 = b2 / a0;
    self.a1 = a1 / a0;
    self.a2 = a2 / a0;
  }

  fn set_lowpass(&mut self, sample_rate: f32, fc: f32, q: f32) {
    // RBJ Audio EQ Cookbook — LPF.
    let w0 = std::f32::consts::TAU * fc / sample_rate;
    let cos_w0 = w0.cos();
    let alpha = w0.sin() / (2.0 * q).max(1e-6);
    let a0 = 1.0 + alpha;
    let b0 = (1.0 - cos_w0) * 0.5;
    let b1 = 1.0 - cos_w0;
    let b2 = (1.0 - cos_w0) * 0.5;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha;
    self.b0 = b0 / a0;
    self.b1 = b1 / a0;
    self.b2 = b2 / a0;
    self.a1 = a1 / a0;
    self.a2 = a2 / a0;
  }

  fn set_bandpass(&mut self, sample_rate: f32, fc: f32, q: f32) {
    // RBJ Audio EQ Cookbook — BPF (constant 0 dB peak gain).
    let w0 = std::f32::consts::TAU * fc / sample_rate;
    let cos_w0 = w0.cos();
    let alpha = w0.sin() / (2.0 * q).max(1e-6);
    let a0 = 1.0 + alpha;
    let b0 = alpha;
    let b1 = 0.0;
    let b2 = -alpha;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha;
    self.b0 = b0 / a0;
    self.b1 = b1 / a0;
    self.b2 = b2 / a0;
    self.a1 = a1 / a0;
    self.a2 = a2 / a0;
  }

  // Zero the delay line (call on retrigger so a reused voice slot doesn't
  // carry the previous note's filter state into the attack).
  fn reset_state(&mut self) {
    self.x1 = 0.0;
    self.x2 = 0.0;
    self.y1 = 0.0;
    self.y2 = 0.0;
  }

  fn set_highshelf(&mut self, sample_rate: f32, fc: f32, gain_db: f32) {
    // RBJ Audio EQ Cookbook — high shelf. Slope = 1 (Q ≈ 0.707).
    let a_amp = 10.0_f32.powf(gain_db / 40.0);
    let w0 = std::f32::consts::TAU * fc / sample_rate;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    // alpha for slope=1 → 2·sqrt(A) factor below; use the standard form.
    let beta = (a_amp + 1.0 / a_amp + 1.0 - 1.0).sqrt() * sin_w0 / 1.0;
    // Equivalent: alpha = sin(w0)/2 * sqrt((A+1/A)·(1/S - 1) + 2), S=1 → 2 inside.
    let _ = beta; // keep linter happy if unused below
    let alpha = sin_w0 * 0.5 * 2.0_f32.sqrt();
    let two_sqrt_a_alpha = 2.0 * a_amp.sqrt() * alpha;
    let a0 = (a_amp + 1.0) - (a_amp - 1.0) * cos_w0 + two_sqrt_a_alpha;
    let b0 = a_amp * ((a_amp + 1.0) + (a_amp - 1.0) * cos_w0 + two_sqrt_a_alpha);
    let b1 = -2.0 * a_amp * ((a_amp - 1.0) + (a_amp + 1.0) * cos_w0);
    let b2 = a_amp * ((a_amp + 1.0) + (a_amp - 1.0) * cos_w0 - two_sqrt_a_alpha);
    let a1 = 2.0 * ((a_amp - 1.0) - (a_amp + 1.0) * cos_w0);
    let a2 = (a_amp + 1.0) - (a_amp - 1.0) * cos_w0 - two_sqrt_a_alpha;
    self.b0 = b0 / a0;
    self.b1 = b1 / a0;
    self.b2 = b2 / a0;
    self.a1 = a1 / a0;
    self.a2 = a2 / a0;
  }

  fn set_peaking(&mut self, sample_rate: f32, fc: f32, q: f32, gain_db: f32) {
    // RBJ peaking EQ.
    let a_amp = 10.0_f32.powf(gain_db / 40.0);
    let w0 = std::f32::consts::TAU * fc / sample_rate;
    let cos_w0 = w0.cos();
    let alpha = w0.sin() / (2.0 * q).max(1e-6);
    let a0 = 1.0 + alpha / a_amp;
    let b0 = 1.0 + alpha * a_amp;
    let b1 = -2.0 * cos_w0;
    let b2 = 1.0 - alpha * a_amp;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha / a_amp;
    self.b0 = b0 / a0;
    self.b1 = b1 / a0;
    self.b2 = b2 / a0;
    self.a1 = a1 / a0;
    self.a2 = a2 / a0;
  }

  #[inline]
  fn process(&mut self, x: f32) -> f32 {
    let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
      - self.a1 * self.y1
      - self.a2 * self.y2;
    self.x2 = self.x1;
    self.x1 = x;
    self.y2 = self.y1;
    self.y1 = y;
    y
  }
}

struct TapeHead {
  read_back: f64,
  ghost_rb: f64,
  xfade_left: i32,
}

struct TapeGrain {
  active: bool,
  rb: f64,
  remaining: i32,
  total: i32,
  fade: i32,
  rate: f32,
  reverse: bool,
  side: u8, // 0 = L, 1 = R
}

struct TapeBuffer {
  buffer: Vec<f32>,
  write_head: usize,
  heads: [TapeHead; TAPE_LAYERS],
  pan_l: [f32; TAPE_LAYERS],
  pan_r: [f32; TAPE_LAYERS],
  grains: [TapeGrain; TAPE_GRAIN_POOL],
  xfade_samples: i32,
  // Smoothed window bounds (one-pole filter, ~100ms TC). -1 sentinel
  // until the first block initializes them.
  smoothed_window_min: f64,
  smoothed_window_max: f64,
  sample_rate_f: f32,
  // xorshift32 PRNG state — audio-thread-safe, no allocation, fine for
  // dice rolls on grain spawn / offset / rate / side.
  rng_state: u32,
  // Per-channel 300Hz HPF on the bed+grain sum (always on, fixed
  // coefficients). Carves bass out of the tape output.
  hpf_l: Biquad,
  hpf_r: Biquad,
}

#[inline]
fn xorshift32(state: &mut u32) -> u32 {
  let mut x = *state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *state = x;
  x
}

#[inline]
fn rand_unit(state: &mut u32) -> f32 {
  // 0..1 inclusive of 0, exclusive of 1.
  (xorshift32(state) as f32) / (u32::MAX as f32 + 1.0)
}

// New bipolar (-1..1) sample for the Random LFO shape's sample-&-hold.
#[inline]
fn lfo_rand_bipolar(state: &mut u32) -> f32 {
  rand_unit(state) * 2.0 - 1.0
}

// Cutoff-LFO shape evaluation, bipolar (-1..1). phase ∈ [0,1). Random returns
// the held value (refreshed on phase wrap by the caller). 0 revsaw · 1 saw ·
// 2 tri · 3 square · 4 random.
#[inline]
fn lfo_eval(shape: u8, phase: f32, rand_val: f32) -> f32 {
  match shape {
    0 => 1.0 - 2.0 * phase,            // revsaw: 1 → -1
    1 => 2.0 * phase - 1.0,            // saw:   -1 → 1
    2 => 1.0 - 4.0 * (phase - 0.5).abs(), // triangle: peak at center
    3 => if phase < 0.5 { 1.0 } else { -1.0 }, // square
    _ => rand_val,                     // random: sample & hold
  }
}

// Number of generic modulator slots (editor B2 full grid). Fixed roles, agreed
// with the JS MOD_SLOT map: 0 vol-LFO (tremolo) · 1 pan-env · 2 pan-LFO ·
// 3 cutoff-env · 4 pitch-env · 5 pitch-LFO · 6 granPos-LFO · 7 granPos-env ·
// 8 wtPos-LFO · 9 wtPos-env. (Vol-env = the amp envelope and cutoff-LFO = the
// bespoke filter LFO live outside this array; slots 6/7 sweep the granular read
// position, granular playmode only; slots 8/9 sweep the wavetable scan position,
// wavetable playmode only.)
const MOD_SLOTS: usize = 10;

// Wavetable single-cycle loop-seam crossfade length, as a fraction of the window
// (one cycle). Smooths the wrap discontinuity that otherwise clicks at the
// fundamental. Bigger = smoother/cleaner but blends more of the neighbouring
// window into each cycle (more timbral coloration); smaller = brighter but the
// seam click returns. 0.15 = a gentle round-off.
const WT_SEAM_FRAC: f64 = 0.15;

// Grain window envelope (granular playmode, editor Phase C). Shapes one grain
// over its phase 0..1: square (flat with short raised-cosine edges to declick
// the grain seam), triangle (linear bell), gauss (gaussian bell). Matches the
// .pti Granular.shape codes (0 Square · 1 Triangle · 2 Gauss).
#[inline]
fn grain_window(shape: u8, phase: f32) -> f32 {
  let ph = phase.clamp(0.0, 1.0);
  match shape {
    0 => {
      let edge = 0.03;
      if ph < edge {
        0.5 - 0.5 * (std::f32::consts::PI * ph / edge).cos()
      } else if ph > 1.0 - edge {
        0.5 - 0.5 * (std::f32::consts::PI * (1.0 - ph) / edge).cos()
      } else {
        1.0
      }
    }
    1 => {
      if ph < 0.5 {
        2.0 * ph
      } else {
        2.0 * (1.0 - ph)
      }
    }
    _ => {
      let x = (ph - 0.5) * 2.0; // -1..1
      (-(x * x) * 5.0).exp()
    }
  }
}

// One generic modulator: an envelope OR an LFO whose output (× depth) is summed
// onto a target. Pure scalars → Copy, so it crosses the command queue and seeds
// a voice with no heap on the audio thread. depth meaning is per-target and
// applied at the read site (tremolo amount / pan offset / cutoff-norm offset /
// pitch semitones).
#[derive(Clone, Copy)]
struct Modulator {
  on: bool,
  is_lfo: bool,
  depth: f32,
  // envelope stage lengths in samples (sustain is a level 0..1)
  attack: u32,
  decay: u32,
  sustain: f32,
  release: u32,
  // lfo
  shape: u8,
  rate_hz: f32,
  // runtime
  phase: f32,
  rand: f32,
  rng: u32,
}

impl Modulator {
  fn off() -> Self {
    Self {
      on: false,
      is_lfo: false,
      depth: 0.0,
      attack: 0,
      decay: 0,
      sustain: 1.0,
      release: 0,
      shape: 0,
      rate_hz: 0.0,
      phase: 0.0,
      rand: 0.0,
      rng: 0x9e37_79b9,
    }
  }

  fn from_ipc(s: &ModSpecIpc, sr: f32, seed: u32) -> Self {
    Self {
      on: true,
      is_lfo: s.is_lfo,
      depth: s.depth,
      attack: (s.attack * sr).max(1.0) as u32,
      decay: (s.decay * sr).max(0.0) as u32,
      sustain: s.sustain.clamp(0.0, 1.0),
      release: (s.release * sr).max(1.0) as u32,
      shape: s.shape,
      rate_hz: s.rate_hz,
      phase: 0.0,
      rand: 0.0,
      rng: 0x9e37_79b9 ^ seed.wrapping_mul(2_654_435_761),
    }
  }

  // Advance the LFO phase one sample (no-op for envelopes / off slots).
  #[inline]
  fn tick(&mut self, sr: f32) {
    if !self.on || !self.is_lfo {
      return;
    }
    self.phase += self.rate_hz / sr;
    if self.phase >= 1.0 {
      self.phase -= self.phase.floor();
      self.rand = lfo_rand_bipolar(&mut self.rng);
    }
  }

  // Current output × depth. Envelopes use `elapsed` output-frames + the note
  // `hold` (samples) for the sustain→release transition; LFOs use the phase.
  #[inline]
  fn value(&self, elapsed: u32, hold: u32) -> f32 {
    if !self.on {
      return 0.0;
    }
    let raw = if self.is_lfo {
      lfo_eval(self.shape, self.phase, self.rand)
    } else {
      let attack_end = self.attack;
      let decay_end = attack_end + self.decay;
      let release_end = hold.saturating_add(self.release);
      if elapsed < attack_end {
        (elapsed + 1) as f32 / attack_end.max(1) as f32
      } else if elapsed < decay_end && self.decay > 0 {
        let t = (elapsed - attack_end + 1) as f32 / self.decay as f32;
        1.0 + t * (self.sustain - 1.0)
      } else if elapsed < hold {
        self.sustain
      } else if elapsed < release_end {
        let t = (elapsed - hold + 1) as f32 / self.release.max(1) as f32;
        self.sustain * (1.0 - t.min(1.0))
      } else {
        0.0
      }
    };
    raw * self.depth
  }
}

// IPC shape for one modulator (matches the JS ModSpec; camelCase over the wire).
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModSpecIpc {
  slot: u8,
  is_lfo: bool,
  depth: f32,
  attack: f32,
  decay: f32,
  sustain: f32,
  release: f32,
  shape: u8,
  rate_hz: f32,
}

// Build the fixed slot array from the IPC list (off where unspecified). Done on
// the command thread so the audio thread only copies a Copy array.
fn build_mod_array(specs: &[ModSpecIpc], sr: f32) -> [Modulator; MOD_SLOTS] {
  let mut arr = [Modulator::off(); MOD_SLOTS];
  for (i, s) in specs.iter().enumerate() {
    let slot = s.slot as usize;
    if slot < MOD_SLOTS {
      arr[slot] = Modulator::from_ipc(s, sr, (slot as u32) ^ (i as u32).wrapping_mul(0x85eb_ca6b));
    }
  }
  arr
}

impl TapeBuffer {
  fn new(sample_rate: u32) -> Self {
    let len = (sample_rate as usize) * 8;
    const LAYER_PANS: [f32; TAPE_LAYERS] = [-0.5, 0.5];
    let mut pan_l = [0.0_f32; TAPE_LAYERS];
    let mut pan_r = [0.0_f32; TAPE_LAYERS];
    for (i, p) in LAYER_PANS.iter().enumerate() {
      let theta = (p + 1.0) * std::f32::consts::FRAC_PI_4;
      pan_l[i] = theta.cos();
      pan_r[i] = theta.sin();
    }
    let grain = TapeGrain {
      active: false,
      rb: 0.0,
      remaining: 0,
      total: 0,
      fade: 0,
      rate: 1.0,
      reverse: false,
      side: 0,
    };
    Self {
      buffer: vec![0.0; len],
      write_head: 0,
      heads: [
        TapeHead { read_back: (sample_rate as f64) * 0.5, ghost_rb: 0.0, xfade_left: 0 },
        TapeHead { read_back: (sample_rate as f64) * 0.5, ghost_rb: 0.0, xfade_left: 0 },
      ],
      pan_l,
      pan_r,
      grains: std::array::from_fn(|_| TapeGrain { ..grain }),
      xfade_samples: ((sample_rate as f32) * 0.02) as i32,
      smoothed_window_min: -1.0,
      smoothed_window_max: -1.0,
      sample_rate_f: sample_rate as f32,
      // Seed from arbitrary nonzero constant — same seed every boot is
      // fine, grain timing only needs decorrelation within a session.
      rng_state: 0x9E3779B9,
      hpf_l: Biquad::highpass(sample_rate as f32, TAPE_HPF_HZ, TAPE_HPF_Q),
      hpf_r: Biquad::highpass(sample_rate as f32, TAPE_HPF_HZ, TAPE_HPF_Q),
    }
  }

  // Processes the wet bus signal in-place. `in_out_l/r` carry the
  // bus input on entry and the (input·(1-mix) + (bed + grains)·mix)
  // blend on exit.
  #[allow(clippy::too_many_arguments)]
  fn process_block(
    &mut self,
    in_out_l: &mut [f32],
    in_out_r: &mut [f32],
    frames: usize,
    position: f32,
    length: f32,
    stretches: [f32; TAPE_LAYERS],
    gains: [f32; TAPE_LAYERS],
    mix: f32,
    reverse: bool,
    hold: bool,
    grain_rate: f32,
    grain_mix: f32,
  ) {
    let buf_len = self.buffer.len();
    if buf_len == 0 {
      return;
    }
    let safety = (buf_len / 32).max(2048);
    if buf_len <= safety + 1 {
      return;
    }
    let max_lookback = (buf_len - safety - 1) as f32;
    let min_window = (buf_len as f32) * 0.0125;
    let target_window_size =
      min_window.max(max_lookback * length.clamp(0.0, 1.0));
    let target_window_min =
      safety as f32 + (max_lookback - target_window_size) * position.clamp(0.0, 1.0);
    let target_window_max = target_window_min + target_window_size;

    // One-pole smoothing on window bounds. Matches web worklet (SMOOTH=0.04
    // per block ≈ 100ms time constant at typical block sizes), so fast
    // scrubbing glides instead of snapping the heads every block.
    if self.smoothed_window_min < 0.0 {
      self.smoothed_window_min = target_window_min as f64;
      self.smoothed_window_max = target_window_max as f64;
    } else {
      const SMOOTH: f64 = 0.04;
      self.smoothed_window_min +=
        (target_window_min as f64 - self.smoothed_window_min) * SMOOTH;
      self.smoothed_window_max +=
        (target_window_max as f64 - self.smoothed_window_max) * SMOOTH;
    }
    let window_min = self.smoothed_window_min as f32;
    let window_max = self.smoothed_window_max as f32;
    let window_size = window_max - window_min;
    let xfade = self.xfade_samples;

    // Snap-back crossfade — if smoothing still leaves a head out of
    // bounds (very fast scrub or programmatic jump), snap to the edge
    // and trigger a crossfade so the snap doesn't click.
    for head in self.heads.iter_mut() {
      if (head.read_back as f32) < window_min {
        if head.xfade_left <= 0 {
          head.ghost_rb = head.read_back;
          head.xfade_left = xfade;
        }
        head.read_back = window_min as f64;
      } else if (head.read_back as f32) > window_max {
        if head.xfade_left <= 0 {
          head.ghost_rb = head.read_back;
          head.xfade_left = xfade;
        }
        head.read_back = window_max as f64;
      }
    }

    let mix_f = mix.clamp(0.0, 1.0);
    let one_minus_mix = 1.0 - mix_f;
    let grain_mix_f = (grain_mix.clamp(0.0, 1.0) * TAPE_GRAIN_MIX_MAX).max(0.0);

    // Per-layer advance — precomputed (stretch is k-rate within the block).
    let mut advances = [0.0_f64; TAPE_LAYERS];
    for i in 0..TAPE_LAYERS {
      let s = stretches[i] as f64;
      advances[i] = if hold {
        if reverse { s } else { -s }
      } else if reverse {
        1.0 + s
      } else {
        1.0 - s
      };
    }

    // Maybe spawn a grain this block. Probability scales with rate and
    // block size; capped by pool size since a single block can only
    // claim one slot (matches the web worklet — at max settings, ≈4.6%
    // chance per 128-sample block at 44.1k, well below pool saturation).
    let events_per_sec = grain_rate.clamp(0.0, 1.0) * 16.0;
    let block_secs = (frames as f32) / self.sample_rate_f;
    let prob_spawn = events_per_sec * block_secs;
    if prob_spawn > 0.0
      && window_size > 0.0
      && rand_unit(&mut self.rng_state) < prob_spawn
    {
      let length_secs = TAPE_GRAIN_LEN_MIN_SECS
        + rand_unit(&mut self.rng_state)
          * (TAPE_GRAIN_LEN_MAX_SECS - TAPE_GRAIN_LEN_MIN_SECS);
      let total_samples =
        ((length_secs * self.sample_rate_f) as i32).max(64);
      let usable_window = (window_size - total_samples as f32).max(1.0);
      let offset = rand_unit(&mut self.rng_state) * usable_window;
      // 50ms fade, capped at 25% of grain length so short grains don't over-fade.
      let fade = ((self.sample_rate_f * TAPE_GRAIN_FADE_SECS) as i32)
        .min(total_samples / 4);
      let rate_idx =
        (rand_unit(&mut self.rng_state) * TAPE_GRAIN_RATES.len() as f32) as usize;
      let rate = TAPE_GRAIN_RATES
        [rate_idx.min(TAPE_GRAIN_RATES.len() - 1)];
      let side: u8 = if rand_unit(&mut self.rng_state) < 0.5 { 0 } else { 1 };
      for slot in self.grains.iter_mut() {
        if !slot.active {
          slot.rb = window_min as f64 + offset as f64;
          slot.remaining = total_samples;
          slot.total = total_samples;
          slot.fade = fade.max(1);
          slot.rate = rate;
          slot.reverse = reverse;
          slot.side = side;
          slot.active = true;
          break;
        }
      }
    }

    for i in 0..frames {
      let in_l = in_out_l[i];
      let in_r = in_out_r[i];
      // Write — skipped while held so the captured buffer stays static.
      if !hold {
        let mono = (in_l + in_r) * 0.5;
        self.buffer[self.write_head] = mono;
        self.write_head += 1;
        if self.write_head >= buf_len {
          self.write_head = 0;
        }
      }

      let xfade_f = xfade as f32;

      // Bed — sum both layers into stereo. Crossfade ghost head with
      // primary while a wrap is in flight (xfade_left > 0).
      let mut bed_l = 0.0_f32;
      let mut bed_r = 0.0_f32;
      for h in 0..TAPE_LAYERS {
        let head = &mut self.heads[h];
        let gain = gains[h];
        if gain > 0.0001 {
          let primary = Self::read_interp_static(&self.buffer, self.write_head, head.read_back);
          let sample = if head.xfade_left > 0 {
            let t = 1.0 - (head.xfade_left as f32) / xfade_f;
            let ghost = Self::read_interp_static(&self.buffer, self.write_head, head.ghost_rb);
            ghost * (1.0 - t) + primary * t
          } else {
            primary
          };
          let s = sample * gain;
          bed_l += s * self.pan_l[h];
          bed_r += s * self.pan_r[h];
        }
        if head.xfade_left > 0 {
          head.ghost_rb += advances[h];
          head.xfade_left -= 1;
        }
        head.read_back += advances[h];
        // Wrap trigger (only when not already crossfading) — snapshot
        // the current position as ghost, wrap primary, start crossfade.
        if head.xfade_left <= 0 {
          if (head.read_back as f32) > window_max {
            head.ghost_rb = head.read_back;
            head.read_back -= window_size as f64;
            head.xfade_left = xfade;
          } else if (head.read_back as f32) < window_min {
            head.ghost_rb = head.read_back;
            head.read_back += window_size as f64;
            head.xfade_left = xfade;
          }
        }
      }

      // Grain layer — single-shot reads at random offsets, panned per
      // spawn to L or R. Linear attack/release envelope (slot.fade
      // samples at each end).
      let mut grain_l = 0.0_f32;
      let mut grain_r = 0.0_f32;
      if grain_mix_f > 0.0001 {
        for slot in self.grains.iter_mut() {
          if !slot.active {
            continue;
          }
          let sample = Self::read_interp_static(&self.buffer, self.write_head, slot.rb);
          let elapsed = slot.total - slot.remaining;
          let env = if elapsed < slot.fade {
            (elapsed as f32) / (slot.fade as f32)
          } else if slot.remaining < slot.fade {
            (slot.remaining as f32) / (slot.fade as f32)
          } else {
            1.0
          };
          let out = sample * env;
          if slot.side == 0 {
            grain_l += out;
          } else {
            grain_r += out;
          }
          // Same advance rules as the bed heads, with the grain's own rate.
          let r = slot.rate as f64;
          let advance = if hold {
            if slot.reverse { r } else { -r }
          } else if slot.reverse {
            1.0 + r
          } else {
            1.0 - r
          };
          slot.rb += advance;
          slot.remaining -= 1;
          if slot.remaining <= 0 {
            slot.active = false;
          }
        }
      }

      // 300Hz HPF on the bed+grain sum. Always on — placed after the
      // tape stage so it catches both directly-recorded bass and
      // content shifted into the low range by the stretch2 layer.
      let tape_l = self.hpf_l.process(bed_l + grain_l * grain_mix_f);
      let tape_r = self.hpf_r.process(bed_r + grain_r * grain_mix_f);
      in_out_l[i] = in_l * one_minus_mix + tape_l * mix_f;
      in_out_r[i] = in_r * one_minus_mix + tape_r * mix_f;
    }
  }

  // Static read_interp callable while a head is borrowed mutably.
  // Same math as the method form; pulled out so the bed loop can read
  // both primary and ghost positions from inside a `&mut head` borrow.
  #[inline]
  fn read_interp_static(buffer: &[f32], write_head: usize, read_back: f64) -> f32 {
    let buf_len = buffer.len();
    let buf_len_f = buf_len as f64;
    let mut read_pos = write_head as f64 - read_back;
    while read_pos < 0.0 {
      read_pos += buf_len_f;
    }
    while read_pos >= buf_len_f {
      read_pos -= buf_len_f;
    }
    let i0 = read_pos as usize;
    let frac = (read_pos - i0 as f64) as f32;
    let i1 = if i0 + 1 >= buf_len { 0 } else { i0 + 1 };
    buffer[i0] * (1.0 - frac) + buffer[i1] * frac
  }
}

// --- master stage (audio-thread only) ---
//
// Phase 7e-1: input gain → DC block (5Hz HPF) → lo-cut HPF → hi-cut LPF
// → trim → tail EQ (always-on -1dB peak at 450Hz). Compressor /
// distortion / gate slot in between lo-cut and hi-cut in later phases.
//
// Coefficients are recomputed once per block when lo-cut index or
// hi-cut value change (not per-sample). Per-channel biquad state
// keeps L/R independent.
struct MasterStage {
  sample_rate: f32,
  dc_l: Biquad,
  dc_r: Biquad,
  lo_l: Biquad,
  lo_r: Biquad,
  hi_l: Biquad,
  hi_r: Biquad,
  tail_l: Biquad,
  tail_r: Biquad,
  last_lo_cut_idx: usize,
  last_hi_cut_hz: f32,
  // Compressor detector state — per-channel peak envelope + RMS².
  comp_peak_env_l: f32,
  comp_peak_env_r: f32,
  comp_rms_sq_l: f32,
  comp_rms_sq_r: f32,
  // Shared (stereo-linked) gain-reduction state. Linking keeps the
  // L/R reduction identical so the stereo image doesn't wander under
  // heavy compression.
  comp_smoothed_gr_db: f32,
  comp_active_samples: u32,
  // Constant-lifetime detector coefficients (peak release ~50ms, RMS
  // window ~10ms). Computed once at construction.
  comp_peak_release_coef: f32,
  comp_rms_coef: f32,
  // Distortion stage — pre/de-emphasis high-shelves around the 4-mode
  // shaper. Pre boosts +4dB at 3kHz INTO the shaper so the saturation
  // hits more high-frequency content (and reveals more harmonics);
  // de-emphasis pulls -4dB at 3kHz on the way out so the original
  // spectral balance is restored, just with added harmonics.
  pre_emph_l: Biquad,
  pre_emph_r: Biquad,
  de_emph_l: Biquad,
  de_emph_r: Biquad,
  // Per-channel shaper state: one-sample memory feedback (Tube
  // especially) + post-LP filter + delayed input for 2x linear-interp
  // upsampling on Fuzz/Square.
  dist_prev_y_l: f32,
  dist_prev_y_r: f32,
  dist_post_lp_l: f32,
  dist_post_lp_r: f32,
  dist_prev_x_l: f32,
  dist_prev_x_r: f32,
  // Drift LFO on bias (asymmetric modes only) — different rates per
  // channel + phase offset on R for natural stereo decorrelation.
  dist_drift_phase_l: f32,
  dist_drift_phase_r: f32,
  dist_drift_inc_l: f32,
  dist_drift_inc_r: f32,
  // xorshift32 for the per-mode noise floor. Seeded distinctly from
  // tape/glitch so spawn patterns stay decorrelated.
  dist_rng: u32,
  // Gate detector + smoothed gain. Stereo-linked (max(L,R)) so the
  // open/close decision is identical across channels. Peak envelope
  // keeps tracking even when disabled so toggling back on doesn't pop.
  gate_peak_env_l: f32,
  gate_peak_env_r: f32,
  gate_smoothed_gain: f32,
  gate_peak_release_coef: f32,
  // Bypass crossfade. `bypass_wet` = 1.0 → fully processed signal,
  // 0.0 → fully dry. Slewed toward target by `bypass_slew_per_sample`
  // each sample to avoid clicks on toggle.
  bypass_wet: f32,
  bypass_slew_per_sample: f32,
}

impl MasterStage {
  fn new(sample_rate: u32) -> Self {
    let sr = sample_rate as f32;
    let mut dc_l = Biquad::new_unity();
    let mut dc_r = Biquad::new_unity();
    dc_l.set_highpass(sr, MASTER_DC_BLOCK_HZ, 0.707);
    dc_r.set_highpass(sr, MASTER_DC_BLOCK_HZ, 0.707);
    let mut tail_l = Biquad::new_unity();
    let mut tail_r = Biquad::new_unity();
    tail_l.set_peaking(sr, MASTER_TAIL_EQ_HZ, MASTER_TAIL_EQ_Q, MASTER_TAIL_EQ_GAIN_DB);
    tail_r.set_peaking(sr, MASTER_TAIL_EQ_HZ, MASTER_TAIL_EQ_Q, MASTER_TAIL_EQ_GAIN_DB);
    let mut pre_emph_l = Biquad::new_unity();
    let mut pre_emph_r = Biquad::new_unity();
    pre_emph_l.set_highshelf(sr, MASTER_DIST_EMPHASIS_HZ, MASTER_DIST_EMPHASIS_DB);
    pre_emph_r.set_highshelf(sr, MASTER_DIST_EMPHASIS_HZ, MASTER_DIST_EMPHASIS_DB);
    let mut de_emph_l = Biquad::new_unity();
    let mut de_emph_r = Biquad::new_unity();
    de_emph_l.set_highshelf(sr, MASTER_DIST_EMPHASIS_HZ, -MASTER_DIST_EMPHASIS_DB);
    de_emph_r.set_highshelf(sr, MASTER_DIST_EMPHASIS_HZ, -MASTER_DIST_EMPHASIS_DB);
    Self {
      sample_rate: sr,
      dc_l,
      dc_r,
      lo_l: Biquad::new_unity(),
      lo_r: Biquad::new_unity(),
      hi_l: Biquad::new_unity(),
      hi_r: Biquad::new_unity(),
      tail_l,
      tail_r,
      last_lo_cut_idx: usize::MAX,
      last_hi_cut_hz: 0.0,
      comp_peak_env_l: 0.0,
      comp_peak_env_r: 0.0,
      comp_rms_sq_l: 0.0,
      comp_rms_sq_r: 0.0,
      comp_smoothed_gr_db: 0.0,
      comp_active_samples: 0,
      comp_peak_release_coef: one_pole_coef(50.0, sr),
      comp_rms_coef: one_pole_coef(10.0, sr),
      pre_emph_l,
      pre_emph_r,
      de_emph_l,
      de_emph_r,
      dist_prev_y_l: 0.0,
      dist_prev_y_r: 0.0,
      dist_post_lp_l: 0.0,
      dist_post_lp_r: 0.0,
      dist_prev_x_l: 0.0,
      dist_prev_x_r: 0.0,
      dist_drift_phase_l: 0.0,
      dist_drift_phase_r: MASTER_DIST_DRIFT_PHASE_R_INIT,
      dist_drift_inc_l: (MASTER_DIST_DRIFT_RATE_L * std::f32::consts::TAU) / sr,
      dist_drift_inc_r: (MASTER_DIST_DRIFT_RATE_R * std::f32::consts::TAU) / sr,
      dist_rng: 0xCAFE_F00D,
      gate_peak_env_l: 0.0,
      gate_peak_env_r: 0.0,
      gate_smoothed_gain: 1.0,
      gate_peak_release_coef: one_pole_coef(MASTER_GATE_PEAK_RELEASE_MS, sr),
      bypass_wet: 1.0,
      bypass_slew_per_sample: 1.0 / (MASTER_BYPASS_RAMP_MS * 0.001 * sr).max(1.0),
    }
  }

  // Zero every piece of running state (biquad delay lines, comp/gate
  // envelopes, distortion memories) while keeping coefficients. Called by
  // Panic — a runaway FX tail that reached inf leaves NaN latched in the
  // biquad x/y history and the detector envelopes, and without this the
  // output stays dead after the panic clears the FX buses. Also invoked
  // per-block by the non-finite guard in process_block. Allocation-free.
  fn reset_state(&mut self) {
    self.dc_l.reset_state();
    self.dc_r.reset_state();
    self.lo_l.reset_state();
    self.lo_r.reset_state();
    self.hi_l.reset_state();
    self.hi_r.reset_state();
    self.tail_l.reset_state();
    self.tail_r.reset_state();
    self.pre_emph_l.reset_state();
    self.pre_emph_r.reset_state();
    self.de_emph_l.reset_state();
    self.de_emph_r.reset_state();
    self.comp_peak_env_l = 0.0;
    self.comp_peak_env_r = 0.0;
    self.comp_rms_sq_l = 0.0;
    self.comp_rms_sq_r = 0.0;
    self.comp_smoothed_gr_db = 0.0;
    self.comp_active_samples = 0;
    self.dist_prev_y_l = 0.0;
    self.dist_prev_y_r = 0.0;
    self.dist_post_lp_l = 0.0;
    self.dist_post_lp_r = 0.0;
    self.dist_prev_x_l = 0.0;
    self.dist_prev_x_r = 0.0;
    self.gate_peak_env_l = 0.0;
    self.gate_peak_env_r = 0.0;
    self.gate_smoothed_gain = 1.0;
  }

  // True when any running state has gone non-finite (NaN/inf from a
  // poisoned upstream block). Probes a sum across the stateful subsystems —
  // all values are bounded audio-range floats, so a finite sum ⇔ every
  // term finite; NaN and inf−inf both propagate to the probe.
  #[inline]
  fn state_is_poisoned(&self) -> bool {
    let probe = self.dc_l.y1
      + self.dc_r.y1
      + self.lo_l.y1
      + self.lo_r.y1
      + self.hi_l.y1
      + self.hi_r.y1
      + self.tail_l.y1
      + self.tail_r.y1
      + self.pre_emph_l.y1
      + self.pre_emph_r.y1
      + self.de_emph_l.y1
      + self.de_emph_r.y1
      + self.comp_rms_sq_l
      + self.comp_rms_sq_r
      + self.comp_smoothed_gr_db
      + self.dist_prev_y_l
      + self.dist_prev_y_r
      + self.dist_post_lp_l
      + self.dist_post_lp_r
      + self.gate_peak_env_l
      + self.gate_peak_env_r
      + self.gate_smoothed_gain;
    !probe.is_finite()
  }

  // Distortion stage applied to a single channel sample. State refs
  // are split fields of MasterStage; pre/de-emphasis biquads handled
  // by the caller because they're regular Biquads. Caller is also
  // responsible for the dry/wet mix gain — this returns the wet sample
  // only (after de-emph applied externally).
  #[allow(clippy::too_many_arguments)]
  fn dist_process_channel(
    prev_y: &mut f32,
    post_lp: &mut f32,
    prev_x: &mut f32,
    drift_phase: &mut f32,
    drift_inc: f32,
    d_mul: f32,
    b_mul: f32,
    x: f32,
    mode: u32,
    drive_n: f32,
    bias_n: f32,
    drive_ceil: f32,
    memory: f32,
    one_minus_mem: f32,
    post_lp_coef: f32,
    out_trim: f32,
    noise: f32,
    asymmetric: bool,
    oversample: bool,
    rng_state: &mut u32,
  ) -> f32 {
    let drive_lin = (1.0 + drive_n * (drive_ceil - 1.0)) * d_mul;
    let x_driven = x * drive_lin;
    let y_pre = one_minus_mem * x_driven + memory * *prev_y;
    let drift = if asymmetric {
      drift_phase.sin() * MASTER_DIST_DRIFT_AMP
    } else {
      0.0
    };
    let eff_bias = if asymmetric {
      bias_n * b_mul + drift
    } else {
      0.0
    };
    let mut y;
    if oversample {
      let u0 = (*prev_x + y_pre) * 0.5;
      let u1 = y_pre;
      *prev_x = y_pre;
      let v0 = master_dist_apply_mode(u0, mode, eff_bias, drive_n);
      let v1 = master_dist_apply_mode(u1, mode, eff_bias, drive_n);
      y = (v0 + v1) * 0.5;
    } else {
      y = master_dist_apply_mode(y_pre, mode, eff_bias, drive_n);
      *prev_x = y_pre;
    }
    if post_lp_coef > 0.0 {
      *post_lp += post_lp_coef * (y - *post_lp);
      y = *post_lp;
    }
    y *= out_trim;
    if noise > 0.0 {
      y += (rand_unit(rng_state) - 0.5) * noise;
    }
    *prev_y = y;
    *drift_phase += drift_inc;
    if *drift_phase > std::f32::consts::TAU {
      *drift_phase -= std::f32::consts::TAU;
    }
    y
  }

  fn update_filters(&mut self, lo_cut_idx: usize, hi_cut_hz: f32) {
    if lo_cut_idx != self.last_lo_cut_idx {
      let fc = MASTER_LO_CUT_FREQS[lo_cut_idx.min(MASTER_LO_CUT_FREQS.len() - 1)];
      self.lo_l.set_highpass(self.sample_rate, fc, 0.707);
      self.lo_r.set_highpass(self.sample_rate, fc, 0.707);
      self.last_lo_cut_idx = lo_cut_idx;
    }
    if (hi_cut_hz - self.last_hi_cut_hz).abs() > 1.0 {
      self.hi_l.set_lowpass(self.sample_rate, hi_cut_hz, 0.707);
      self.hi_r.set_lowpass(self.sample_rate, hi_cut_hz, 0.707);
      self.last_hi_cut_hz = hi_cut_hz;
    }
  }

  // Processes buf channels 0+1 in place. Mono-out devices (n_ch == 1)
  // get only the L pipeline (compressor detector still uses L only).
  // Chain: input gain → DC block → lo-cut → COMPRESSOR → pre-emph →
  // DISTORTION (4 modes) → de-emph → wet/dry mix → hi-cut → trim →
  // tail EQ. Gate slots between de-emph mix and hi-cut later.
  #[allow(clippy::too_many_arguments)]
  fn process_block(
    &mut self,
    buf: &mut [f32],
    frames: usize,
    n_ch: usize,
    input_gain: f32,
    trim_gain: f32,
    comp_amount: f32,
    comp_attack_ms: f32,
    comp_release_ms: f32,
    dist_mode: u32,
    dist_drive: f32,
    dist_bias: f32,
    dist_mix: f32,
    gate_enabled: bool,
    gate_threshold_norm: f32,
    bypass: bool,
  ) {
    if n_ch == 0 {
      return;
    }
    // Non-finite recovery — a NaN/inf that slipped in from an upstream
    // block (runaway FX before the delay's feedback bound, a pathological
    // sample) would otherwise latch in the biquad/envelope state forever
    // and silence the output permanently. Heals one block after the
    // source stops. One branch per block.
    if self.state_is_poisoned() {
      self.reset_state();
    }
    let bypass_target: f32 = if bypass { 0.0 } else { 1.0 };
    let bypass_slew = self.bypass_slew_per_sample;
    // Per-block compressor coefficients. Attack/release are k-rate
    // (don't change mid-block) so we precompute once. Amount is a-rate
    // in the worklet but our LFO pipeline only updates per RAF frame,
    // so treating it as block-constant matches the user's actual flow.
    let (thresh_db, slope, makeup_db) = master_comp_amount_to_params(comp_amount);
    let attack_coef = one_pole_coef(comp_attack_ms, self.sample_rate);
    let fast_release_coef = one_pole_coef(
      comp_release_ms * MASTER_COMP_FAST_RELEASE_FACTOR,
      self.sample_rate,
    );
    let slow_release_coef = one_pole_coef(
      comp_release_ms * MASTER_COMP_SLOW_RELEASE_FACTOR,
      self.sample_rate,
    );
    let makeup_linear = 10.0_f32.powf(makeup_db / 20.0);

    // Per-block distortion mode constants. mode is k-rate; drive/bias/mix
    // are a-rate in the worklet but RAF-update-limited here, so block-
    // constant matches actual flow.
    let dist_mode_idx = dist_mode.min(MASTER_DIST_NUM_MODES - 1) as usize;
    let dist_drive_ceil = MASTER_DIST_DRIVE_CEIL[dist_mode_idx];
    let dist_memory = MASTER_DIST_MEMORY[dist_mode_idx];
    let dist_one_minus_mem = 1.0 - dist_memory;
    let dist_post_lp_coef = MASTER_DIST_POST_LP[dist_mode_idx];
    let dist_out_trim = MASTER_DIST_OUTPUT_TRIM[dist_mode_idx];
    let dist_noise = MASTER_DIST_NOISE[dist_mode_idx];
    let dist_asymmetric = dist_mode == MASTER_DIST_MODE_TUBE
      || dist_mode == MASTER_DIST_MODE_FUZZ;
    let dist_oversample = dist_mode == MASTER_DIST_MODE_FUZZ
      || dist_mode == MASTER_DIST_MODE_SQUARE;
    let (dist_dry_g, dist_wet_g) = master_dist_mix_gains(dist_mix);

    // Gate envelope coefs precomputed per block (attack/release are
    // constants in this v1). Threshold is read into dB here so the
    // per-sample compare is a cheap >= against a fixed scalar.
    let gate_threshold_db = master_gate_threshold_db(gate_threshold_norm);
    let gate_attack_coef = one_pole_coef(MASTER_GATE_ATTACK_MS, self.sample_rate);
    let gate_release_coef =
      one_pole_coef(MASTER_GATE_RELEASE_MS, self.sample_rate);

    if n_ch == 1 {
      for frame in 0..frames {
        let idx = frame * n_ch;
        // Dry snapshot for the bypass crossfade. Pre-input-gain so
        // bypassed signal hits the device exactly as it arrived from
        // the upstream FX bus — no master coloring leaks through.
        let dry_in = buf[idx];
        let mut s = buf[idx] * input_gain;
        s = self.dc_l.process(s);
        s = self.lo_l.process(s);
        // Compressor (mono path uses L state only).
        let abs_s = s.abs();
        self.comp_peak_env_l = if abs_s > self.comp_peak_env_l {
          abs_s
        } else {
          self.comp_peak_env_l
            + self.comp_peak_release_coef * (abs_s - self.comp_peak_env_l)
        };
        self.comp_rms_sq_l +=
          self.comp_rms_coef * (s * s - self.comp_rms_sq_l);
        let rms = self.comp_rms_sq_l.sqrt();
        let level = self.comp_peak_env_l.max(rms);
        let level_db = 20.0 * (level + 1e-10).log10();
        let target_gr = master_comp_gr_db(level_db, thresh_db, slope);
        let active_ms =
          (self.comp_active_samples as f32 / self.sample_rate) * 1000.0;
        let release_coef = if active_ms <= MASTER_COMP_ACTIVE_FAST_MS {
          fast_release_coef
        } else if active_ms >= MASTER_COMP_ACTIVE_SLOW_MS {
          slow_release_coef
        } else {
          let t = (active_ms - MASTER_COMP_ACTIVE_FAST_MS)
            / (MASTER_COMP_ACTIVE_SLOW_MS - MASTER_COMP_ACTIVE_FAST_MS);
          fast_release_coef + t * (slow_release_coef - fast_release_coef)
        };
        if target_gr > self.comp_smoothed_gr_db {
          self.comp_smoothed_gr_db +=
            attack_coef * (target_gr - self.comp_smoothed_gr_db);
        } else {
          self.comp_smoothed_gr_db +=
            release_coef * (target_gr - self.comp_smoothed_gr_db);
        }
        if self.comp_smoothed_gr_db > MASTER_COMP_ACTIVE_GR_DB {
          self.comp_active_samples = self.comp_active_samples.saturating_add(1);
        } else {
          self.comp_active_samples = 0;
        }
        let gr_saturated = (self.comp_smoothed_gr_db * MASTER_COMP_GR_SAT_SCALE)
          .tanh()
          / MASTER_COMP_GR_SAT_SCALE;
        let total_gain = 10.0_f32.powf(-gr_saturated / 20.0) * makeup_linear;
        s *= total_gain;
        // Distortion stage — equal-power dry/wet crossfade around
        // pre-emphasis → shaper → de-emphasis. Mono path uses L state.
        let dry = s;
        let pre = self.pre_emph_l.process(s);
        let mut wet = Self::dist_process_channel(
          &mut self.dist_prev_y_l,
          &mut self.dist_post_lp_l,
          &mut self.dist_prev_x_l,
          &mut self.dist_drift_phase_l,
          self.dist_drift_inc_l,
          MASTER_DIST_STEREO_DRIVE[0],
          MASTER_DIST_STEREO_BIAS[0],
          pre,
          dist_mode,
          dist_drive,
          dist_bias,
          dist_drive_ceil,
          dist_memory,
          dist_one_minus_mem,
          dist_post_lp_coef,
          dist_out_trim,
          dist_noise,
          dist_asymmetric,
          dist_oversample,
          &mut self.dist_rng,
        );
        wet = self.de_emph_l.process(wet);
        s = dry * dist_dry_g + wet * dist_wet_g;
        s = self.hi_l.process(s);
        // Gate — peak envelope (mono uses L only) + threshold +
        // attack/release envelope on the gain. Disabled = passthrough
        // with gain pinned at 1 so re-enable doesn't pop.
        {
          let abs_s = s.abs();
          self.gate_peak_env_l = if abs_s > self.gate_peak_env_l {
            abs_s
          } else {
            self.gate_peak_env_l
              + self.gate_peak_release_coef * (abs_s - self.gate_peak_env_l)
          };
          if gate_enabled {
            let peak_db = 20.0 * (self.gate_peak_env_l + 1e-10).log10();
            let target = if peak_db >= gate_threshold_db { 1.0 } else { 0.0 };
            let coef = if target > self.gate_smoothed_gain {
              gate_attack_coef
            } else {
              gate_release_coef
            };
            self.gate_smoothed_gain +=
              coef * (target - self.gate_smoothed_gain);
            s *= self.gate_smoothed_gain;
          } else {
            self.gate_smoothed_gain = 1.0;
          }
        }
        s = s * trim_gain;
        s = self.tail_l.process(s);
        // Bypass crossfade — slew `bypass_wet` toward target each
        // sample, equal-power mix of dry input vs processed output.
        if self.bypass_wet != bypass_target {
          let delta = (bypass_target - self.bypass_wet).clamp(-bypass_slew, bypass_slew);
          self.bypass_wet = (self.bypass_wet + delta).clamp(0.0, 1.0);
        }
        let theta = self.bypass_wet * std::f32::consts::FRAC_PI_2;
        buf[idx] = dry_in * theta.cos() + s * theta.sin();
      }
      return;
    }

    for frame in 0..frames {
      let il = frame * n_ch;
      let ir = il + 1;
      // Dry snapshots for the bypass crossfade — captured pre-master
      // so bypass = no master coloring at all.
      let dry_l_in = buf[il];
      let dry_r_in = buf[ir];
      let mut l = buf[il] * input_gain;
      let mut r = buf[ir] * input_gain;
      l = self.dc_l.process(l);
      r = self.dc_r.process(r);
      l = self.lo_l.process(l);
      r = self.lo_r.process(r);

      // Compressor — stereo-linked detector: peak + RMS per channel,
      // then max across both channels for the gain-reduction decision.
      let abs_l = l.abs();
      let abs_r = r.abs();
      self.comp_peak_env_l = if abs_l > self.comp_peak_env_l {
        abs_l
      } else {
        self.comp_peak_env_l
          + self.comp_peak_release_coef * (abs_l - self.comp_peak_env_l)
      };
      self.comp_peak_env_r = if abs_r > self.comp_peak_env_r {
        abs_r
      } else {
        self.comp_peak_env_r
          + self.comp_peak_release_coef * (abs_r - self.comp_peak_env_r)
      };
      self.comp_rms_sq_l +=
        self.comp_rms_coef * (l * l - self.comp_rms_sq_l);
      self.comp_rms_sq_r +=
        self.comp_rms_coef * (r * r - self.comp_rms_sq_r);
      let rms_l = self.comp_rms_sq_l.sqrt();
      let rms_r = self.comp_rms_sq_r.sqrt();
      let level_l = self.comp_peak_env_l.max(rms_l);
      let level_r = self.comp_peak_env_r.max(rms_r);
      let level = level_l.max(level_r);
      let level_db = 20.0 * (level + 1e-10).log10();
      let target_gr = master_comp_gr_db(level_db, thresh_db, slope);

      // Program-dependent release: brief activity → fast (snappy),
      // sustained activity → slow (musical, doesn't pump).
      let active_ms =
        (self.comp_active_samples as f32 / self.sample_rate) * 1000.0;
      let release_coef = if active_ms <= MASTER_COMP_ACTIVE_FAST_MS {
        fast_release_coef
      } else if active_ms >= MASTER_COMP_ACTIVE_SLOW_MS {
        slow_release_coef
      } else {
        let t = (active_ms - MASTER_COMP_ACTIVE_FAST_MS)
          / (MASTER_COMP_ACTIVE_SLOW_MS - MASTER_COMP_ACTIVE_FAST_MS);
        fast_release_coef + t * (slow_release_coef - fast_release_coef)
      };
      if target_gr > self.comp_smoothed_gr_db {
        self.comp_smoothed_gr_db +=
          attack_coef * (target_gr - self.comp_smoothed_gr_db);
      } else {
        self.comp_smoothed_gr_db +=
          release_coef * (target_gr - self.comp_smoothed_gr_db);
      }
      if self.comp_smoothed_gr_db > MASTER_COMP_ACTIVE_GR_DB {
        self.comp_active_samples = self.comp_active_samples.saturating_add(1);
      } else {
        self.comp_active_samples = 0;
      }
      // Gain-reduction self-saturation — tanh-shaped so heavy comp
      // adds its own harmonic content. Transparent at small gr,
      // saturates ~20dB ceiling at extreme reduction.
      let gr_saturated = (self.comp_smoothed_gr_db * MASTER_COMP_GR_SAT_SCALE)
        .tanh()
        / MASTER_COMP_GR_SAT_SCALE;
      let total_gain = 10.0_f32.powf(-gr_saturated / 20.0) * makeup_linear;
      l *= total_gain;
      r *= total_gain;

      // Distortion stage — equal-power dry/wet crossfade around
      // pre-emphasis → shaper → de-emphasis. Per-channel state +
      // ~0.5% stereo mismatch on drive/bias multipliers.
      let dry_l = l;
      let dry_r = r;
      let pre_l = self.pre_emph_l.process(l);
      let pre_r = self.pre_emph_r.process(r);
      let mut wet_l = Self::dist_process_channel(
        &mut self.dist_prev_y_l,
        &mut self.dist_post_lp_l,
        &mut self.dist_prev_x_l,
        &mut self.dist_drift_phase_l,
        self.dist_drift_inc_l,
        MASTER_DIST_STEREO_DRIVE[0],
        MASTER_DIST_STEREO_BIAS[0],
        pre_l,
        dist_mode,
        dist_drive,
        dist_bias,
        dist_drive_ceil,
        dist_memory,
        dist_one_minus_mem,
        dist_post_lp_coef,
        dist_out_trim,
        dist_noise,
        dist_asymmetric,
        dist_oversample,
        &mut self.dist_rng,
      );
      let mut wet_r = Self::dist_process_channel(
        &mut self.dist_prev_y_r,
        &mut self.dist_post_lp_r,
        &mut self.dist_prev_x_r,
        &mut self.dist_drift_phase_r,
        self.dist_drift_inc_r,
        MASTER_DIST_STEREO_DRIVE[1],
        MASTER_DIST_STEREO_BIAS[1],
        pre_r,
        dist_mode,
        dist_drive,
        dist_bias,
        dist_drive_ceil,
        dist_memory,
        dist_one_minus_mem,
        dist_post_lp_coef,
        dist_out_trim,
        dist_noise,
        dist_asymmetric,
        dist_oversample,
        &mut self.dist_rng,
      );
      wet_l = self.de_emph_l.process(wet_l);
      wet_r = self.de_emph_r.process(wet_r);
      l = dry_l * dist_dry_g + wet_l * dist_wet_g;
      r = dry_r * dist_dry_g + wet_r * dist_wet_g;

      l = self.hi_l.process(l);
      r = self.hi_r.process(r);

      // Gate — stereo-linked peak detector. Threshold compare against
      // max(peak_l, peak_r); single smoothed gain applied to both
      // channels so the open/close decision is identical L/R.
      {
        let abs_l = l.abs();
        let abs_r = r.abs();
        self.gate_peak_env_l = if abs_l > self.gate_peak_env_l {
          abs_l
        } else {
          self.gate_peak_env_l
            + self.gate_peak_release_coef * (abs_l - self.gate_peak_env_l)
        };
        self.gate_peak_env_r = if abs_r > self.gate_peak_env_r {
          abs_r
        } else {
          self.gate_peak_env_r
            + self.gate_peak_release_coef * (abs_r - self.gate_peak_env_r)
        };
        if gate_enabled {
          let peak = self.gate_peak_env_l.max(self.gate_peak_env_r);
          let peak_db = 20.0 * (peak + 1e-10).log10();
          let target = if peak_db >= gate_threshold_db { 1.0 } else { 0.0 };
          let coef = if target > self.gate_smoothed_gain {
            gate_attack_coef
          } else {
            gate_release_coef
          };
          self.gate_smoothed_gain +=
            coef * (target - self.gate_smoothed_gain);
          l *= self.gate_smoothed_gain;
          r *= self.gate_smoothed_gain;
        } else {
          self.gate_smoothed_gain = 1.0;
        }
      }

      l = l * trim_gain;
      r = r * trim_gain;
      l = self.tail_l.process(l);
      r = self.tail_r.process(r);

      // Bypass crossfade — slew `bypass_wet` toward target each
      // sample, equal-power mix per channel.
      if self.bypass_wet != bypass_target {
        let delta = (bypass_target - self.bypass_wet).clamp(-bypass_slew, bypass_slew);
        self.bypass_wet = (self.bypass_wet + delta).clamp(0.0, 1.0);
      }
      let theta = self.bypass_wet * std::f32::consts::FRAC_PI_2;
      let dry_g = theta.cos();
      let wet_g = theta.sin();
      buf[il] = dry_l_in * dry_g + l * wet_g;
      buf[ir] = dry_r_in * dry_g + r * wet_g;
    }
  }
}

// --- glitch machine (audio-thread only) ---
//
// 1-second mono ring buffer that's always recording the FX bus input.
// On fire, picks a random mode from `GLITCH_MODES` and plays a slice
// of the ring at the mode's rate/direction for the mode's total
// duration. Random L or R side per fire; the other channel passes the
// dry signal through. Outside fires both channels pass through.
const GLITCH_RING_SECONDS: f32 = 1.0;
const GLITCH_STUTTER_REPEATS_MIN: i32 = 2;
const GLITCH_STUTTER_REPEATS_MAX: i32 = 5;
const GLITCH_NUM_MODES: usize = 8;

// (slice_sec, rate, dir, rate_decay, silent, output_sec, repeats_kind)
// Direct table port from public/worklets/glitch-machine.js — variety
// comes from the random mode pick, not from per-mode knobs.
struct GlitchMode {
  slice_sec: f32,
  rate: f32,
  dir: i8,
  rate_decay: f32,  // 1.0 = no decay; <1 = tape-stop
  silent: bool,
  output_sec: f32,  // 0.0 = derive from slice × repeats / rate
  stutter: bool,    // true = random 2..5 repeats; false = single pass
}

const GLITCH_MODES: [GlitchMode; GLITCH_NUM_MODES] = [
  // 0 STUTTER         — 90ms slice, 2..5× forward repeats (CD skip)
  GlitchMode { slice_sec: 0.09,  rate: 1.0, dir:  1, rate_decay: 1.0, silent: false, output_sec: 0.0,  stutter: true  },
  // 1 REVERSE         — 250ms slice, single backward pass (tape rewind)
  GlitchMode { slice_sec: 0.25,  rate: 1.0, dir: -1, rate_decay: 1.0, silent: false, output_sec: 0.0,  stutter: false },
  // 2 OCTAVE_UP       — 200ms × 2×  (pitched squeak)
  GlitchMode { slice_sec: 0.2,   rate: 2.0, dir:  1, rate_decay: 1.0, silent: false, output_sec: 0.0,  stutter: false },
  // 3 OCTAVE_DOWN     — 75ms  × 0.5 (slow pitched-down)
  GlitchMode { slice_sec: 0.075, rate: 0.5, dir:  1, rate_decay: 1.0, silent: false, output_sec: 0.0,  stutter: false },
  // 4 OCTAVE_2_UP     — 200ms × 4×  (very short chirp)
  GlitchMode { slice_sec: 0.2,   rate: 4.0, dir:  1, rate_decay: 1.0, silent: false, output_sec: 0.0,  stutter: false },
  // 5 REVERSE_OCTAVE  — 200ms × 2× reversed (rewind + pitched)
  GlitchMode { slice_sec: 0.2,   rate: 2.0, dir: -1, rate_decay: 1.0, silent: false, output_sec: 0.0,  stutter: false },
  // 6 SILENCE         — 150ms drop (broken dropout)
  GlitchMode { slice_sec: 0.15,  rate: 1.0, dir:  1, rate_decay: 1.0, silent: true,  output_sec: 0.0,  stutter: false },
  // 7 TAPE_STOP       — rate decays 1×→0 over 350ms (turntable stop)
  GlitchMode { slice_sec: 0.5,   rate: 1.0, dir:  1, rate_decay: 0.9995, silent: false, output_sec: 0.35, stutter: false },
];

struct GlitchMachine {
  ring: Vec<f32>,
  write_head: usize,
  fire_active: bool,
  fire_pos_f: f32,
  fire_rate: f32,
  fire_rate_decay: f32,
  fire_direction: i8,
  fire_remaining: i32,
  fire_slice_len: i32,
  fire_start: usize,
  fire_side: u8,
  fire_silent: bool,
  sample_rate_f: f32,
  rng_state: u32,
}

impl GlitchMachine {
  fn new(sample_rate: u32) -> Self {
    let ring_len = ((sample_rate as f32) * GLITCH_RING_SECONDS) as usize;
    Self {
      ring: vec![0.0; ring_len],
      write_head: 0,
      fire_active: false,
      fire_pos_f: 0.0,
      fire_rate: 1.0,
      fire_rate_decay: 1.0,
      fire_direction: 1,
      fire_remaining: 0,
      fire_slice_len: 0,
      fire_start: 0,
      fire_side: 0,
      fire_silent: false,
      sample_rate_f: sample_rate as f32,
      // Different seed from tape so spawn patterns don't correlate.
      rng_state: 0xDEAD_BEEF,
    }
  }

  fn fire(&mut self) {
    let mode_idx =
      (rand_unit(&mut self.rng_state) * GLITCH_NUM_MODES as f32) as usize;
    let mode_idx = mode_idx.min(GLITCH_NUM_MODES - 1);
    let cfg = &GLITCH_MODES[mode_idx];
    self.fire_slice_len = (self.sample_rate_f * cfg.slice_sec) as i32;
    self.fire_rate = cfg.rate;
    self.fire_rate_decay = cfg.rate_decay;
    self.fire_direction = cfg.dir;
    self.fire_silent = cfg.silent;
    self.fire_pos_f = if cfg.dir == 1 {
      0.0
    } else {
      (self.fire_slice_len - 1) as f32
    };
    let ring_len = self.ring.len() as i32;
    let start = (self.write_head as i32 - self.fire_slice_len).rem_euclid(ring_len);
    self.fire_start = start as usize;
    let repeats = if cfg.stutter {
      GLITCH_STUTTER_REPEATS_MIN
        + (rand_unit(&mut self.rng_state)
          * (GLITCH_STUTTER_REPEATS_MAX - GLITCH_STUTTER_REPEATS_MIN + 1) as f32)
          as i32
    } else {
      1
    };
    self.fire_remaining = if cfg.output_sec > 0.0 {
      (self.sample_rate_f * cfg.output_sec) as i32
    } else {
      ((self.fire_slice_len * repeats) as f32 / cfg.rate.max(0.0001)) as i32
    };
    self.fire_remaining = self.fire_remaining.max(1);
    self.fire_side = if rand_unit(&mut self.rng_state) < 0.5 { 0 } else { 1 };
    self.fire_active = true;
  }

  // In-place processor on the wet bus signal. Mirrors the tape stage's
  // signature — `in_out_l/r` carry the bus on entry and the
  // glitch-blended result on exit.
  fn process_block(
    &mut self,
    in_out_l: &mut [f32],
    in_out_r: &mut [f32],
    frames: usize,
    mix: f32,
    fire_requested: bool,
  ) {
    // Always restart the slice when a fire lands, even mid-active —
    // matches the web worklet. Otherwise back-to-back beats with long
    // modes (REVERSE 250ms, STUTTER×5 450ms, TAPE_STOP 350ms) would
    // silently drop the new fire when its predecessor hadn't finished.
    if fire_requested {
      self.fire();
    }
    let ring_len = self.ring.len();
    if ring_len == 0 {
      return;
    }
    let mix_f = mix.clamp(0.0, 1.0);
    let one_minus_mix = 1.0 - mix_f;

    for i in 0..frames {
      let s_l = in_out_l[i];
      let s_r = in_out_r[i];
      // Always capture (mono downmix) so the ring stays warm regardless
      // of fire state.
      self.ring[self.write_head] = (s_l + s_r) * 0.5;
      self.write_head += 1;
      if self.write_head >= ring_len {
        self.write_head = 0;
      }

      let mut out_l = s_l;
      let mut out_r = s_r;

      if self.fire_active {
        let fire_sample = if self.fire_silent {
          0.0
        } else {
          let mut idx_f =
            self.fire_start as f32 + self.fire_pos_f;
          let rl = ring_len as f32;
          while idx_f < 0.0 {
            idx_f += rl;
          }
          while idx_f >= rl {
            idx_f -= rl;
          }
          let i0 = idx_f as usize;
          let frac = idx_f - i0 as f32;
          let i1 = if i0 + 1 >= ring_len { 0 } else { i0 + 1 };
          self.ring[i0] * (1.0 - frac) + self.ring[i1] * frac
        };

        // Side-only wet: untouched channel keeps the dry signal.
        if self.fire_side == 0 {
          out_l = one_minus_mix * s_l + mix_f * fire_sample;
        } else {
          out_r = one_minus_mix * s_r + mix_f * fire_sample;
        }

        self.fire_pos_f += self.fire_rate * self.fire_direction as f32;
        // Slice wrap for stutter (no-op for single-pass modes since they
        // end via fire_remaining before wrapping).
        if self.fire_direction == 1 && self.fire_pos_f >= self.fire_slice_len as f32 {
          self.fire_pos_f -= self.fire_slice_len as f32;
        } else if self.fire_direction == -1 && self.fire_pos_f < 0.0 {
          self.fire_pos_f += self.fire_slice_len as f32;
        }
        if self.fire_rate_decay != 1.0 {
          self.fire_rate *= self.fire_rate_decay;
        }
        self.fire_remaining -= 1;
        if self.fire_remaining <= 0 {
          self.fire_active = false;
        }
      }

      in_out_l[i] = out_l;
      in_out_r[i] = out_r;
    }
  }
}

// Moog-style 4-pole ladder lowpass — direct port of public/worklets/track-
// ladder.js. Per-voice state (each trigger gets a fresh filter); shared
// params via the voice's Arc<TrackParams>. Voice-vs-track-state divergence
// from the web path is intentional: per-voice means each chord tone runs
// through its own filter envelope, which is arguably more musical for the
// polyphonic case and removes the trackId tag from the audio loop.
#[derive(Clone, Default)]
struct LadderFilter {
  y1_l: f32,
  y2_l: f32,
  y3_l: f32,
  y4_l: f32,
  y1_r: f32,
  y2_r: f32,
  y3_r: f32,
  y4_r: f32,
}

const LADDER_MAX_K: f32 = 3.95;
const LADDER_G_CEIL: f32 = 0.95;

impl LadderFilter {
  fn reset(&mut self) {
    self.y1_l = 0.0;
    self.y2_l = 0.0;
    self.y3_l = 0.0;
    self.y4_l = 0.0;
    self.y1_r = 0.0;
    self.y2_r = 0.0;
    self.y3_r = 0.0;
    self.y4_r = 0.0;
  }

  fn process_stereo(
    &mut self,
    ls: f32,
    rs: f32,
    cutoff_hz: f32,
    resonance: f32,
    sample_rate: f32,
  ) -> (f32, f32) {
    // g = 1 - exp(-2π·fc/sr), clamped at 0.95 — above that the cascaded
    // feedback has no smoothing per stage and the loop blows up at high
    // resonance.
    let g = (1.0 - (-std::f32::consts::TAU * cutoff_hz / sample_rate).exp())
      .min(LADDER_G_CEIL)
      .max(0.0);
    // Cutoff-dependent resonance taming. As cutoff approaches Nyquist
    // the cascaded poles' phase response tightens and k near 4 becomes
    // numerically unstable; scale by (1 - 0.85·g) so resonance fades
    // gracefully into the top of the cutoff range.
    let k = (4.0 * resonance).min(LADDER_MAX_K) * (1.0 - 0.85 * g);
    // Passband-level compensation. At low res the gain is ~unity; at
    // res=1 the passband dips ~6 dB. Scale the (1 + 0.5·res) boost by
    // (1 - g) so fully open cutoff doesn't pile gain onto already
    // near-full-scale audio.
    let comp = 1.0 + resonance * 0.5 * (1.0 - g);

    let drive_l = (ls - k * self.y4_l).tanh();
    self.y1_l += g * (drive_l - self.y1_l);
    self.y2_l += g * (self.y1_l - self.y2_l);
    self.y3_l += g * (self.y2_l - self.y3_l);
    self.y4_l += g * (self.y3_l - self.y4_l);

    let drive_r = (rs - k * self.y4_r).tanh();
    self.y1_r += g * (drive_r - self.y1_r);
    self.y2_r += g * (self.y1_r - self.y2_r);
    self.y3_r += g * (self.y2_r - self.y3_r);
    self.y4_r += g * (self.y3_r - self.y4_r);

    (self.y4_l * comp, self.y4_r * comp)
  }
}

// --- LFO engine (phase 6) ---
//
// Eight slow LFOs run on the audio thread at block rate. JS pushes the
// LFO state (rate / depth / destinations) via `audio_set_lfos` whenever
// the user touches the LFO panel; the audio thread reads a lock-free
// Arc snapshot at the top of each callback, advances phases by
// `block_size / sample_rate`, and writes the modulated value into each
// destination's `_eff` atomic. DSP reads `_eff` unchanged from earlier
// phases — only the writer changes.
//
// IPC writes the BASE atomic and an initial copy to EFFECTIVE so the
// no-LFO case stays correct. When a destination is unrouted, the next
// IPC `audio_set_lfos` resets eff = base for every modulated param
// (see `install_lfo_snapshot`), so stale modulation can't linger.
//
// Block rate (vs sample rate) is the right granularity: filter zipper
// noise comes from the IPC delay (~16ms RAF + serdes), not from the
// LFO update interval itself. With block sizes of 256–2048 samples at
// 48 kHz, block rate is 5–43 ms — already faster than RAF, and the
// LFO is a slow shape (period 7 s minimum) so audio-rate per-sample
// updates would be wasted CPU.

const LFO_COUNT: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LfoDestKind {
  TrackFilterCutoff,
  TrackFilterResonance,
  TrackFxSend,
  TrackReverbSend,
  TrackDelaySend,
  TrackTune,
  TrackFineTune,
  TrackWtPosition,
  ReverbSize,
  ReverbMix,
  ReverbDiffusion,
  ReverbDamping,
  PreSaturationDrive,
  GlitchMix,
  TapePosition,
  TapeLength,
  TapeMix,
  TapeGrainRate,
  TapeGrainMix,
  MasterInput,
  MasterHiCut,
  MasterTrim,
  MasterComp,
  MasterDrive,
  MasterBias,
  MasterMix,
  MasterGateThreshold,
}

impl LfoDestKind {
  fn is_per_track(self) -> bool {
    matches!(
      self,
      LfoDestKind::TrackFilterCutoff
        | LfoDestKind::TrackFilterResonance
        | LfoDestKind::TrackFxSend
        | LfoDestKind::TrackReverbSend
        | LfoDestKind::TrackDelaySend
        | LfoDestKind::TrackTune
        | LfoDestKind::TrackFineTune
        | LfoDestKind::TrackWtPosition,
    )
  }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfoDestinationIpc {
  pub knob: LfoDestKind,
  // None for global destinations; Some(track_id) for per-track ones.
  // Serde aliases let JS send either `trackId` or omit it for globals.
  pub track_id: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfoIpc {
  pub id: u32,
  pub rate: f32,
  pub depth: f32,
  pub destinations: Vec<LfoDestinationIpc>,
}

// Audio-thread-readable snapshot. Built by the IPC handler, swapped
// atomically; the audio callback reads via `Arc::clone` once per block
// and iterates without any locking.
struct LfoSnapshot {
  rate: [f32; LFO_COUNT],
  depth: [f32; LFO_COUNT],
  // Grouped by destination so the audio thread can apply each
  // destination's accumulated LFO output in one pass. `track_params`
  // is pre-resolved at snapshot construction time so no string lookups
  // happen on the audio thread.
  groups: Vec<LfoGroup>,
}

struct LfoGroup {
  kind: LfoDestKind,
  track_params: Option<Arc<TrackParams>>,
  // (lfo_id, depth) pairs. depth is duplicated from the parent rate
  // array for cache locality during the per-block compute.
  contributors: Vec<u8>,
}

impl LfoSnapshot {
  fn empty() -> Self {
    Self {
      rate: [0.0; LFO_COUNT],
      depth: [0.0; LFO_COUNT],
      groups: Vec::new(),
    }
  }
}

// ArcSwap so the audio thread reads the snapshot wait-free at the top
// of each callback (no Mutex on the audio thread). Writers (IPC) do an
// atomic `store` with a freshly-built Arc; the previous Arc is dropped
// on the writer thread, not the audio callback. Audio thread uses
// `load()` (Guard, no Arc::clone) so even high-rate LFO panel churn
// can't stall the deadline. See `install_lfo_snapshot` for the writer.
static LFO_SNAPSHOT: OnceLock<ArcSwap<LfoSnapshot>> = OnceLock::new();

fn lfo_snapshot_cell() -> &'static ArcSwap<LfoSnapshot> {
  LFO_SNAPSHOT.get_or_init(|| ArcSwap::from_pointee(LfoSnapshot::empty()))
}

// JS payload → snapshot builder. Resolves per-track destinations to
// Arc<TrackParams> handles and groups routings by (kind, track) so the
// audio thread can iterate once per destination.
//
// Side effect: copies base → effective for every modulatable destination
// reachable from the previous snapshot. This is how unrouting an LFO
// "snaps back" — the audio thread stops overwriting effective for that
// destination, but here we make sure the last written value isn't a
// frozen modulated frame.
fn install_lfo_snapshot(lfos: Vec<LfoIpc>) {
  // 1) Reset every global effective to its base. Cheap (~22 writes)
  // and avoids the "previously-modulated, now-unrouted destination
  // stays stuck at last LFO frame" footgun.
  {
    let r = reverb_state();
    r.write_size_eff(r.size_base());
    r.write_wet_gain_eff(r.wet_gain_base());
    r.write_diffusion_eff(r.diffusion_base());
    r.write_damping_eff(r.damping_base());

    let s = saturation_state();
    s.write_pre_drive_eff(s.pre_drive_base());

    let g = glitch_state();
    g.write_mix_eff(g.mix_base());

    let t = tape_state();
    t.write_position_eff(t.position_base());
    t.write_length_eff(t.length_base());
    t.write_mix_eff(t.mix_base());
    t.write_grain_rate_eff(t.grain_rate_base());
    t.write_grain_mix_eff(t.grain_mix_base());

    let m = master_state();
    m.write_input_eff(m.input_base());
    m.write_hi_cut_eff(m.hi_cut_base());
    m.write_trim_eff(m.trim_base());
    m.write_comp_amount_eff(m.comp_amount_base());
    m.write_dist_drive_eff(m.dist_drive_base());
    m.write_dist_bias_eff(m.dist_bias_base());
    m.write_dist_mix_eff(m.dist_mix_base());
    m.write_gate_threshold_eff(m.gate_threshold_base());
  }
  // 2) Per-track effectives: snap back every track in the registry
  // (rare event, cheap iteration).
  {
    let reg = track_params_registry().lock().expect("track params lock");
    for params in reg.values() {
      params.write_cutoff_norm_eff(params.cutoff_norm_base());
      params.write_resonance_eff(params.resonance_base());
      params.write_fx_send_eff(params.fx_send_base());
      params.write_reverb_send_eff(params.reverb_send_base());
      params.write_delay_send_eff(params.delay_send_base());
      // Tuning deviation is additive (0 = no mod), so snap back to 0 rather
      // than to a base — the static tune already lives in each voice's rate.
      params.write_tune_mod_semis(0.0);
      params.write_finetune_mod_semis(0.0);
      params.write_wt_pos_mod(0.0);
    }
  }

  // 3) Build the new snapshot. Group key = (kind, track_id) so multiple
  // LFOs routed to the same destination share one group.
  use std::collections::HashMap;
  let mut groups_map: HashMap<(LfoDestKind, Option<String>), Vec<u8>> =
    HashMap::new();
  let mut rate = [0.0_f32; LFO_COUNT];
  let mut depth = [0.0_f32; LFO_COUNT];
  for lfo in &lfos {
    let id = lfo.id as usize;
    if id >= LFO_COUNT {
      continue;
    }
    rate[id] = lfo.rate.max(0.0);
    depth[id] = lfo.depth.clamp(0.0, 1.0);
    if depth[id] == 0.0 {
      continue;
    }
    for dest in &lfo.destinations {
      let track_id = if dest.knob.is_per_track() {
        dest.track_id.clone()
      } else {
        None
      };
      if dest.knob.is_per_track() && track_id.is_none() {
        continue;
      }
      groups_map
        .entry((dest.knob, track_id))
        .or_default()
        .push(lfo.id as u8);
    }
  }

  // Resolve per-track destinations to Arc handles, drop track_id strings.
  let mut groups: Vec<LfoGroup> = Vec::with_capacity(groups_map.len());
  for ((kind, track_id), contributors) in groups_map.into_iter() {
    let track_params = track_id.as_deref().map(get_or_create_track_params);
    groups.push(LfoGroup {
      kind,
      track_params,
      contributors,
    });
  }

  let snap = Arc::new(LfoSnapshot {
    rate,
    depth,
    groups,
  });
  // Atomic store; previous Arc is dropped here on the writer thread.
  // Audio thread's outstanding `load()` Guards remain valid and are
  // released without an Arc decrement (arc-swap's hazard-cell trick).
  lfo_snapshot_cell().store(snap);
}

// Catmull-Rom cubic interpolation — 4-tap reconstruction for reading a
// sample at a fractional position (pitch shift / detune jitter / SR
// mismatch). p1..p2 bracket the read; p0/p3 are the outer neighbours and
// shape the curve. Smoother high end + less aliasing than 2-tap linear,
// most audible on sustained / pitched tonal material. ~a dozen flops more
// than linear per channel per frame. `t` is the 0..1 fraction past p1.
#[inline]
fn catmull(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
  let t2 = t * t;
  let t3 = t2 * t;
  0.5
    * ((2.0 * p1)
      + (-p0 + p2) * t
      + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
      + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
}

// Port of `applyLFO` in src/audio/lfo.ts. Slides the swing window inside
// [0,1] when base sits near an edge so the dial keeps moving continuously
// instead of pinning. `out` is the bipolar (-1..1) summed LFO output.
fn apply_lfo(base: f32, depth: f32, out: f32) -> f32 {
  if depth <= 0.0 {
    return base;
  }
  let mut lo = base - depth;
  let mut hi = base + depth;
  if lo < 0.0 {
    hi -= lo;
    lo = 0.0;
  }
  if hi > 1.0 {
    lo -= hi - 1.0;
    hi = 1.0;
  }
  lo = lo.max(0.0);
  hi = hi.min(1.0);
  let center = (lo + hi) * 0.5;
  let half = (hi - lo) * 0.5;
  center + out * half
}

// --- voice pool ---

// Pre-allocated voice slots (realtime-safe: the audio thread never allocates).
// Not a hardware limit — CPU scales with SIMULTANEOUSLY-SOUNDING voices, not the
// pool size (inactive slots early-continue in the render loop), so a generous
// pool is nearly free. Bumped 64→256 because dense slice sequencing (16th notes
// on random over a break, whose one-shot tails overlap) exhausted 64 and forced
// voice stealing, which clicks.
const VOICE_POOL_SIZE: usize = 256;
const TRIGGER_QUEUE_CAPACITY: usize = 256;
// Loop/resample capture ring length. 32s holds 8 bars down to ~60bpm; a
// capture span longer than the ring is rejected at drain.
const LOOP_RING_SECONDS: usize = 32;

// Loop-unit visualization channel — lock-free statics the audio thread
// writes and the `audio_loop_viz`/`audio_loop_peaks` commands read, so the
// LOOPS tab can draw the captured waveform + live playhead/grains without
// touching the callback. Peaks are min/max f32 bit-patterns per column,
// filled during LoopCapture (subsampled — a visual, not a measurement);
// VERSION bumps per capture so JS knows when to re-fetch. POS is the
// playhead as a 0..1 fraction (bits of -1.0 = unit inactive); GRAINS pack
// 8 × (position fraction, window level) — position -1.0 = slot idle.
const LOOP_PEAK_COLS: usize = 512;
const LOOP_GRAIN_SLOTS: usize = 8;
static LOOP_VIZ_PEAKS: [AtomicU32; LOOP_PEAK_COLS * 2] =
  [const { AtomicU32::new(0) }; LOOP_PEAK_COLS * 2];
static LOOP_VIZ_VERSION: AtomicU32 = AtomicU32::new(0);
static LOOP_VIZ_POS: AtomicU32 = AtomicU32::new(0);
static LOOP_VIZ_GRAINS: [AtomicU32; LOOP_GRAIN_SLOTS * 2] =
  [const { AtomicU32::new(0) }; LOOP_GRAIN_SLOTS * 2];
// Bounce progress 0..1 as f32 bits; -1.0 = no bounce in flight. Note the
// zero-init reads as 0.0 — the audio thread republishes every block while
// the unit runs, and JS treats <0 OR no-saving state as "no bar".
static LOOP_VIZ_BOUNCE: AtomicU32 = AtomicU32::new(0);
// NOISE unit ping LEDs (L, R) — peak-hold envelopes (fire to 1.0 on each
// edge ping, ~100ms decay per block) so the 30Hz UI poll catches flashes
// the way a real LED's persistence does. The Mörser's tuning LED, lifted.
static NOISE_VIZ_PING: [AtomicU32; 2] = [const { AtomicU32::new(0) }; 2];
// NOISE unit output scope — scrolling min/max columns of the unit's
// PRE-level output (the unit's voice; LEVEL is just the return fader, so
// the scope stays readable while you dial the sound in quiet). The audio
// thread pushes one column per NOISE_SCOPE_DECIM frames (~2.7ms → ~1/2s
// window); the NOISE tab polls ~30Hz. Interleaved (min,max) f32 bits plus
// a write cursor — same lock-free shape as the ping LEDs.
const NOISE_SCOPE_COLS: usize = 192;
const NOISE_SCOPE_DECIM: u32 = 128;
static NOISE_SCOPE: [AtomicU32; NOISE_SCOPE_COLS * 2] =
  [const { AtomicU32::new(0) }; NOISE_SCOPE_COLS * 2];
static NOISE_SCOPE_POS: AtomicU32 = AtomicU32::new(0);

fn noise_scope_push(min: f32, max: f32) {
  let pos =
    NOISE_SCOPE_POS.load(Ordering::Relaxed) as usize % NOISE_SCOPE_COLS;
  NOISE_SCOPE[pos * 2].store(min.to_bits(), Ordering::Relaxed);
  NOISE_SCOPE[pos * 2 + 1].store(max.to_bits(), Ordering::Relaxed);
  NOISE_SCOPE_POS
    .store(((pos + 1) % NOISE_SCOPE_COLS) as u32, Ordering::Relaxed);
}
// Cap for the per-stream sample-accurate pending-trigger queue. The
// audio thread pre-allocates this many slots so pushes never realloc;
// overflow drops with `PENDING_TRIGGER_DROPS` for diagnostics.
const PENDING_TRIGGERS_CAP: usize = 512;

// Diagnostic counter — incremented from the audio thread when a
// delayed trigger arrives with the pending queue full. Read via the
// status IPC for debug overlays.
static PENDING_TRIGGER_DROPS: std::sync::atomic::AtomicU32 =
  std::sync::atomic::AtomicU32::new(0);

// Editor playhead readback. The instrument editor sets MONITOR_NOTE_ID to
// the note_id of its preview voice; the audio thread publishes that voice's
// normalized read position (0..1 over the whole sample) into MONITOR_POS
// once per block. A negative value means "no active monitored voice" — set
// on the voice's deactivation or when the editor clears the id (note_id 0).
// Read over IPC by the waveform playhead. Lock-free, single producer.
static MONITOR_NOTE_ID: std::sync::atomic::AtomicU64 =
  std::sync::atomic::AtomicU64::new(0);
static MONITOR_POS: AtomicU32 = AtomicU32::new(0); // f32 bits; <0 = none
// Live wavetable scan (0..1) of the monitored voice — the resolved scan position
// INCLUDING self-morph deviation + wtPos automation, so the editor's zoomed
// visualizer can track what the engine is actually reading (deviation is
// engine-only; the JS side can't recompute it). f32 bits; <0 = none/not wt.
static MONITOR_WT_SCAN: AtomicU32 = AtomicU32::new(0);

// Loop-seam crossfade length. fwd/bwd loops jump from play_end→play_start
// (or vice-versa), so the waveform is discontinuous at the seam and clicks
// without a blend; this equal-power crossfade smooths it. Pingpong reverses
// continuously (no jump) so it's exempt. Capped at half the loop span so
// short loops still crossfade.
const LOOP_XFADE_SECS: f32 = 0.02;

// Cutoff-LFO coefficient recompute interval (samples). The LFO phase advances
// every sample, but recomputing the biquad every ~32 samples (~0.7ms at 44.1k)
// is smooth enough and keeps the per-sample cost down.
const LFO_RECOMPUTE_SAMPLES: u32 = 32;

#[derive(Clone)]
struct Voice {
  sample: Option<Arc<SampleData>>,
  position: f64,
  rate: f64,
  // Rate glide (portamento) for live re-voicing. RepitchNote ramps `rate`
  // toward `rate_target` by `rate_glide_inc` per frame over the remaining
  // frame count, rather than snapping — an instantaneous rate change is a
  // waveform slope discontinuity that ticks (audible when the voicing macro
  // is cranked and tones move by large intervals). remaining == 0 means steady
  // (rate has reached rate_target).
  rate_target: f64,
  rate_glide_inc: f64,
  rate_glide_remaining: u32,
  gain: f32,
  pan_left: f32,
  pan_right: f32,
  // Base pan (-1..1) kept so a pan modulator can offset it and recompute
  // pan_left/right each frame around this center.
  pan_base: f32,
  // Output routing. out_first is the first physical channel (0-indexed).
  // out_stereo=true uses out_first + out_first+1 (L/R with pan applied).
  // out_stereo=false sums L+R*0.5 into out_first only (pan ignored — pan is
  // a stereo concept; on a mono out it'd just attenuate).
  out_first: usize,
  out_stereo: bool,
  // Per-track filter params. None = no filter (manual triggers from the
  // Phase 0 panel don't carry a track context). Some = ladder filter
  // applied per-frame with cutoff/resonance read from these atomics, so
  // knob twists hit voices already in flight.
  track_params: Option<Arc<TrackParams>>,
  filter: LadderFilter,
  // Sample offset within the FIRST audio block to begin emitting from.
  // Set by the pending-trigger queue for sample-accurate dispatch — a
  // voice with start_frame=N skips the first N frames of its first
  // block then plays normally from frame N onward. Reset to 0 at end
  // of that first block so subsequent blocks emit from frame 0.
  start_frame: usize,
  active: bool,
  // Section tag for splits recording. 0 = none (skip splits), 1 = drum
  // (writes to rhythm scratch), 2 = melodic (writes to melody scratch),
  // 3 = click (writes to BOTH so DAW alignment markers land in either
  // split file). Mirrors the web `TrackSection` plus the click bus tap.
  section: u8,
  // Stem-recording slot (1-based track index; 0 = not captured). Snapshotted
  // from track_params.rec_track() at voice creation so the per-track dry stem
  // tap reads a plain field on the hot path. Fixed for the voice's lifetime
  // (matches section's per-trigger semantics).
  rec_track: u8,
  // Texture-role flag. On transport stop, texture voices get a long
  // release ramp (graceful fade) while everything else cuts; see the
  // StopFade mixer command.
  is_texture: bool,
  // Frozen per-track DSP snapshot (cutoff_hz, resonance, fx_send). None =
  // read live from track_params (the normal case — knob twists hit the
  // voice). Some = this voice was caught mid-tail by a scene/bank/song
  // swap and detached from the shared track_params so the incoming
  // scene's settings can't retune its ring-out (a resonance jump would
  // self-oscillate into a crash). Set by FreezeVoiceParams, cleared on
  // re-trigger. Tuple = (cutoff_hz, resonance, fx_send, reverb_send, delay_send).
  frozen_params: Option<(f32, f32, f32, f32, f32)>,
  // Output frames elapsed since trigger — drives the flat-voice declick
  // fade-in. Counts output frames (not sample position), so it's
  // rate-independent.
  frames_played: u32,
  // Choke-group tag (FNV-1a hash of the manifest group name, 0 = none).
  // A new trigger carrying a non-zero group gives every active voice with
  // the SAME group the ~20ms release ramp — across tracks, matching the
  // web samplePlayer's manifest chokeGroups (closed hat chokes open hat
  // even though they live on different tracks). Hashed JS→IPC-thread-side
  // so no String ever crosses into the audio callback.
  choke_group: u32,
  // Monophonic-choke release state. When a new trigger lands on a track
  // marked monophonic, all existing active voices that share the SAME
  // track_params Arc get `release_remaining` set to RELEASE_FRAMES. Per
  // sample, the voice's output is scaled by `release_remaining /
  // release_total`, decremented each frame; when 0, the voice deactivates.
  // 0 here = no release in flight (steady playback). Matches the web
  // path's STEAL_RELEASE ~20ms soft choke in `samplePlayer.trigger`.
  release_remaining: u32,
  release_total: u32,
  // Per-voice ADSR envelope. `env_active = false` → voice plays at flat
  // `gain` (drums, leads without an envelope config). `env_active = true`
  // → output multiplied by `env_level` per sample using linear ramps:
  //   attack: 0 → 1 over attack_samples
  //   decay:  1 → sustain over decay_samples
  //   sustain: hold at sustain through hold_samples
  //   release: env_release_start_level → 0 over release_samples
  // Voice deactivates exactly at `hold_samples + release_samples` —
  // hits zero cleanly, no asymptotic tail past gate end. The release
  // ramps from whatever level was captured on entering release (so
  // short gates that end mid-attack still get a clean fade from the
  // partial peak the voice actually reached). Linear is simpler than
  // web's exponentialRamp but hits the same zero on the same sample.
  env_active: bool,
  env_level: f32,
  env_elapsed: u32,
  env_attack_samples: u32,
  env_decay_samples: u32,
  env_hold_samples: u32,
  env_release_samples: u32,
  env_sustain_level: f32,
  // Sentinel < 0 = not yet captured (still pre-release). Set to the
  // current env_level on the first sample where elapsed >= hold_samples.
  env_release_start_level: f32,
  // Voice handle for targeted release. 0 = untagged (the normal case —
  // sequencer triggers never set it). Live MIDI input monitoring tags each
  // held note with a unique id so the matching note-off can release THAT
  // voice (a soft ramp) without touching the armed track's pattern voices,
  // which share the same track_params Arc. See MixerCommand::ReleaseNote.
  note_id: u64,
  // Per-instrument sample window + loop (editor A3). play_start/play_end
  // are read positions in sample frames; loop_mode is 0 off · 1 fwd · 2
  // bwd · 3 pingpong · 4 rev one-shot; play_dir is the read direction
  // (+1/-1), flipped at the window edges for pingpong and held at -1 for
  // backward readers (bwd loop + rev one-shot).
  // Defaults (0 / frame_count / 0 / +1) reproduce a full-length one-shot.
  play_start: f64,
  play_end: f64,
  loop_mode: u8,
  play_dir: f64,
  // Per-instrument filter (editor B1) — DISTINCT from the per-track mixer
  // ladder `filter` above. inst_filter_on gates it; the L/R biquads carry
  // the same coefficients (set at trigger) with independent delay lines.
  // Bypassed (no-op) for every voice that didn't author a filter.
  inst_filter_on: bool,
  inst_filter_l: Biquad,
  inst_filter_r: Biquad,
  // Cutoff LFO (editor B2). When lfo_on, the instrument filter's coefficients
  // are recomputed every LFO_RECOMPUTE samples from inst_cutoff_norm offset by
  // the LFO, so the cutoff sweeps live. Base params (type/cutoff/q) are kept
  // so the recompute has something to modulate around. lfo_phase advances per
  // sample; lfo_rand holds the sample-&-hold value for the Random shape.
  inst_filter_type: u8,
  inst_cutoff_norm: f32,
  inst_q: f32,
  // Per-instrument saturation drive (0 = bypass), applied post-filter —
  // a cranked resonance screams INTO the shaper by design.
  sat_drive: f32,
  // Per-instrument bit crush, 4..16 (>=16 = bypass), after saturation.
  bit_depth: u8,
  lfo_on: bool,
  lfo_shape: u8,
  lfo_rate_hz: f32,
  lfo_depth: f32,
  lfo_phase: f32,
  lfo_recompute_ctr: u32,
  lfo_rand: f32,
  lfo_rng: u32,
  // Generic modulator grid (editor B2). Fixed slot roles (see MOD_SLOTS). Each
  // ticks per sample and its value is summed onto its target (tremolo / pan /
  // cutoff / pitch). All-off by default → no extra work.
  mods: [Modulator; MOD_SLOTS],
  // Note hold in samples for mod-envelope release (= amp env hold when present,
  // else u32::MAX = sustain until the voice ends).
  mod_hold_samples: u32,
  // Granular (editor Phase C). When gran_on, the voice plays through a single
  // windowed read-head instead of the normal trim/loop reader: each grain reads
  // `gran_grain_frames` source frames from the swept base position, shaped by
  // `gran_shape`, read in `gran_dir` (0 fwd · 1 bwd · 2 pingpong), repeating to
  // sustain. The base position is `gran_pos_norm` (0..1 of the sample) offset by
  // the granular-position mods (slots 6/7). gran_read = source frames into the
  // current grain; gran_ping_fwd = current direction for pingpong.
  gran_on: bool,
  gran_grain_frames: f64,
  gran_pos_norm: f32,
  gran_shape: u8,
  gran_dir: u8,
  gran_read: f64,
  gran_ping_fwd: bool,
  // The grain's start position in frames, LATCHED at each grain boundary (so the
  // read point is fixed for the duration of a grain and the position automation
  // only steps forward between grains — the discrete-grain texture). Recomputing
  // it every sample instead would smear each grain into a continuous scrub.
  gran_base_latched: f64,
  // Per-grain start scatter (0..1 of the sample): each new grain latches at a
  // random offset ± this around the target position, so the read "jumps around"
  // the point rather than tracking one forward span. gran_rng is a dedicated
  // PRNG so the scatter doesn't perturb the cutoff-LFO's random sequence.
  gran_spray: f32,
  gran_rng: u32,
  // Wavetable (editor Phase D). When wt_on, the voice is a single-cycle
  // oscillator: the sample is a bank of `wt_window_frames`-frame windows (each
  // one cycle), the played note `wt_hz` sets the pitch (phase advances
  // wt_window_frames·wt_hz/sr per output sample, wrapping at one window), and
  // `wt_pos_norm` (+ the wtPos mods, slots 8/9) scans which window is read.
  // wt_morph crossfades the two nearest windows during a sweep; off = stepped.
  // wt_phase is the in-window read position in frames (0..wt_window_frames).
  wt_on: bool,
  wt_window_frames: f64,
  wt_pos_norm: f32,
  wt_morph: bool,
  wt_hz: f32,
  wt_phase: f64,
  // Per-frame smoothed TrackWtPosition deviation. The global LFO writes
  // wt_pos_mod once per BLOCK (k-rate); adding it raw steps the scan at every
  // block edge — a hard waveform jump (up to ~0.6 FS measured) per block on a
  // swept voice, audible as intermittent crunch. One-pole smoothed (~4ms) the
  // sweep glides instead. NaN = seed from the first block's value (so a voice
  // triggered mid-sweep starts AT the LFO, no onset slew).
  wt_track_scan: f64,
  // Stepped (morph-off) read: the window playing the current cycle, and the
  // seam's pending destination window. Re-picking the window per frame flips
  // content mid-cycle whenever the scan moves — a hard splice. Instead the
  // in-flight cycle keeps its window; the target is latched at seam entry,
  // the tail crossfades toward ITS pre-start frames, and the switch lands
  // sample-continuously on the phase wrap. -1 = latch from the live scan.
  wt_wi_cur: f64,
  wt_wi_next: f64,
  // Wavetable smoother: v.sample is the BAKED variant (each window circularly
  // smoothed + gain-matched independently). Baked windows are periodic and
  // mutually discontinuous at their edges, so the read wraps WITHIN the
  // window (circular Catmull, no seam, no AA box — content is pre-band-limited)
  // and a stepped switch fades A(ph)→B(ph).
  wt_smooth: bool,
}

impl Default for Voice {
  fn default() -> Self {
    Self {
      sample: None,
      position: 0.0,
      rate: 1.0,
      rate_target: 1.0,
      rate_glide_inc: 0.0,
      rate_glide_remaining: 0,
      gain: 0.0,
      pan_left: 0.0,
      pan_right: 0.0,
      pan_base: 0.0,
      out_first: 0,
      out_stereo: true,
      track_params: None,
      filter: LadderFilter::default(),
      start_frame: 0,
      active: false,
      choke_group: 0,
      release_remaining: 0,
      release_total: 0,
      env_active: false,
      env_level: 1.0,
      env_elapsed: 0,
      env_attack_samples: 0,
      env_decay_samples: 0,
      env_hold_samples: 0,
      env_release_samples: 0,
      env_sustain_level: 1.0,
      env_release_start_level: -1.0,
      section: 0,
      rec_track: 0,
      is_texture: false,
      frozen_params: None,
      frames_played: 0,
      note_id: 0,
      play_start: 0.0,
      play_end: 0.0,
      loop_mode: 0,
      play_dir: 1.0,
      inst_filter_on: false,
      inst_filter_l: Biquad::new_unity(),
      inst_filter_r: Biquad::new_unity(),
      inst_filter_type: 0,
      inst_cutoff_norm: 1.0,
      inst_q: 0.707,
      sat_drive: 0.0,
      bit_depth: 16,
      lfo_on: false,
      lfo_shape: 0,
      lfo_rate_hz: 0.0,
      lfo_depth: 0.0,
      lfo_phase: 0.0,
      lfo_recompute_ctr: 0,
      lfo_rand: 0.0,
      lfo_rng: 0x9e37_79b9,
      mods: [Modulator::off(); MOD_SLOTS],
      mod_hold_samples: u32::MAX,
      gran_on: false,
      gran_grain_frames: 0.0,
      gran_pos_norm: 0.0,
      gran_shape: 0,
      gran_dir: 0,
      gran_read: 0.0,
      gran_ping_fwd: true,
      gran_base_latched: 0.0,
      gran_spray: 0.0,
      gran_rng: 0x1234_5678,
      wt_on: false,
      wt_window_frames: 2048.0,
      wt_pos_norm: 0.0,
      wt_morph: true,
      wt_hz: 261.63,
      wt_phase: 0.0,
      wt_track_scan: f64::NAN,
      wt_wi_cur: -1.0,
      wt_wi_next: -1.0,
      wt_smooth: false,
    }
  }
}

// Section codes — match `VoiceSection` in the JS bridge. Kept as u8 in
// the IPC + Voice to avoid string overhead on every trigger.
const SECTION_NONE: u8 = 0;
const SECTION_DRUM: u8 = 1;
const SECTION_MELODIC: u8 = 2;
const SECTION_CLICK: u8 = 3;

enum MixerCommand {
  // Recorder lifecycle — producer arrives via the command queue so the
  // audio thread can install it without locking. Worker thread on the
  // other side of the producer (held outside this enum) drains samples
  // and writes WAV.
  StartCombinedRecording {
    producer: HeapProd<f32>,
    // Absolute ENGINE_FRAMES at which capture should begin — aligned to the
    // first musical downbeat so WAV frame 0 = the downbeat (no leading
    // dead-space, on-grid in the DAW). 0 = start immediately (legacy).
    start_frame: u64,
  },
  StopCombinedRecording,
  StartSplitsRecording {
    rhythm: HeapProd<f32>,
    melody: HeapProd<f32>,
  },
  StopSplitsRecording,
  // Full-stems recording — every producer installs on the SAME audio block
  // so master / per-track / fx / reverb / delay are all sample-locked. The
  // per-track producer array is boxed so this variant doesn't bloat every
  // ring slot; the one-time heap free when the box is consumed happens on a
  // user-initiated record-start, never on the per-block hot path.
  StartStemsRecording {
    master: Option<HeapProd<f32>>,
    fx: Option<HeapProd<f32>>,
    reverb: Option<HeapProd<f32>>,
    delay: Option<HeapProd<f32>>,
    tracks: Box<[Option<HeapProd<f32>>; MAX_STEMS]>,
    // Aligned capture start (see StartCombinedRecording::start_frame).
    start_frame: u64,
  },
  StopStemsRecording,
  Trigger {
    sample: Arc<SampleData>,
    gain: f32,
    pan: f32,        // -1..1 (ignored when out_stereo=false)
    pitch: f32,      // 1.0 = native rate
    out_first: u32,  // first physical channel, 0-indexed
    out_stereo: bool,
    track_params: Option<Arc<TrackParams>>,
    // Monophonic flag — when true, on dispatch all OTHER active voices
    // sharing the same `track_params` Arc get a 20ms release ramp and
    // deactivate. Matches the web bass/lead workflow where a new note
    // chokes the prior one's tail.
    monophonic: bool,
    // Choke-group hash (0 = none) — chokes matching voices ACROSS tracks
    // on dispatch (hats). See Voice::choke_group.
    choke_group: u32,
    // Section tag (see SECTION_* constants). Drives the splits recording
    // tap — drum voices into rhythm WAV, melodic into melody WAV, click
    // into both. SECTION_NONE skips splits entirely.
    section: u8,
    // Texture-role flag. Texture voices fade out (multi-second release
    // ramp) on transport stop; everything else cuts. See StopFade.
    is_texture: bool,
    // Optional ADSR envelope. None → voice plays at flat `gain` (drums,
    // leads without an envelope config). Some → output multiplied by
    // per-sample envelope level; voice deactivates when release tail
    // completes. Seconds in the IPC; coefficients computed at dispatch.
    envelope: Option<EnvelopeSpec>,
    // Absolute ENGINE_FRAMES position the voice should begin emitting
    // at. 0 = no absolute target (fall back to delay_samples). This is
    // the jitter-free path: the deadline doesn't depend on which block
    // drains the command.
    target_frame: u64,
    // Frames to wait after this trigger is drained from the queue
    // before the voice begins emitting — the RELATIVE fallback, used
    // when target_frame == 0. Converted to an absolute target against
    // ENGINE_FRAMES at drain time. 0 = fire immediately at the start
    // of the next audio block.
    delay_samples: u32,
    // Voice handle (0 = untagged). Only live-input monitoring sets it.
    note_id: u64,
    // Per-instrument sample window (0..1 fractions of the sample) + loop
    // mode (0 off · 1 fwd · 2 bwd · 3 pingpong · 4 rev one-shot). 0/1/0 = full one-shot.
    start_frac: f32,
    end_frac: f32,
    loop_mode: u8,
    // Per-instrument filter: type 0 off · 1 lp · 2 hp · 3 bp; cutoff +
    // resonance normalized 0..1. type 0 bypasses.
    inst_filter_type: u8,
    inst_cutoff: f32,
    inst_resonance: f32,
    // Per-instrument saturation drive 0..1 (0 = bypass). Applied
    // post-filter in the voice loop via pre_saturate_sample — same tanh
    // family as the mangler-bus pre-drive.
    sat_drive: f32,
    // Per-instrument bit crush, 4..16 (>=16 = bypass), applied after
    // saturation: drive → crush.
    bit_depth: u8,
    // Cutoff LFO: shape 0 revsaw · 1 saw · 2 tri · 3 square · 4 random; rate
    // in Hz; depth 0..1 bipolar. depth 0 (or filter off) = no modulation.
    lfo_shape: u8,
    lfo_rate_hz: f32,
    lfo_depth: f32,
    // Generic modulator grid (prebuilt on the command thread — no heap here).
    mods: [Modulator; MOD_SLOTS],
    // Granular (editor Phase C). gran_on switches the voice to the single
    // windowed read-head; grain length in ms (resolved to frames at the device
    // rate when the trigger is consumed), position 0..1, shape 0/1/2, dir 0/1/2.
    gran_on: bool,
    gran_grain_ms: f32,
    gran_position: f32,
    gran_shape: u8,
    gran_dir: u8,
    gran_spray: f32,
    // Wavetable (editor Phase D). wt_on switches the voice to a single-cycle
    // oscillator read-head: wt_window_frames source frames = one cycle, the
    // played note (wt_hz) sets the pitch, position 0..1 scans the windows,
    // morph crossfades adjacent windows on a sweep.
    wt_on: bool,
    wt_window_frames: f32,
    wt_pos_norm: f32,
    wt_morph: bool,
    wt_hz: f32,
    // Wavetable smoother: the sample Arc was already swapped for the baked
    // (circularly-smoothed) variant on the command thread; the flag switches
    // the voice to the circular in-window read (see the wt branch).
    wt_smooth: bool,
  },
  StopAll,
  // Hard panic: stop every voice (like StopAll) AND clear the reverb + delay
  // buffers, killing a runaway / self-oscillating FX tail that StopAll alone
  // leaves ringing (the feedback loops keep regenerating without new input).
  Panic,
  // Release a single tagged voice (live-input monitoring note-off). Starts
  // the per-voice release ramp (fade_frames) on the active voice carrying
  // `note_id`, leaving every other voice — including the armed track's
  // pattern voices on the same track_params Arc — untouched. Reuses the same
  // release_remaining/release_total ramp as the monophonic choke.
  ReleaseNote {
    note_id: u64,
    fade_frames: u32,
  },
  // Live re-pitch of a tagged, in-flight voice. Multiplies the matched
  // voice's playback `rate` by `ratio` (= 2^(semitones/12), computed JS-side
  // from the tracked old→new MIDI of that chord tone). Used by the voicing
  // macro to slide a held chord's inversion/spread tones to their new pitch
  // without retriggering. Pitch IS `rate` here (position += rate per sample),
  // so this is a clean frequency change from the current read position — no
  // amplitude discontinuity. v1 snaps; a future glide ramps `rate` over N
  // frames. Skips frozen + already-releasing voices like ReleaseNote.
  RepitchNote {
    note_id: u64,
    ratio: f32,
    glide_frames: u32,
  },
  // Transport-stop texture fade. ONLY texture-role voices get a release
  // ramp (fade_frames) so sustained material rings down gracefully on
  // stop. Every other voice — and the pending-trigger queue — is left
  // completely untouched (rings out naturally, exactly as before).
  // Reuses the per-voice release_remaining/release_total ramp already
  // mixed in per sample.
  FadeTextures {
    fade_frames: u32,
  },
  // Drop queued-but-not-yet-fired triggers whose absolute deadline is at
  // or past min_frame. Sounding voices are untouched. This is the perform
  // punch-in/release path: the JS scheduler dispatches ~250ms ahead, so
  // without a flush a punch edge only becomes audible after the queued
  // horizon plays out — the dispatcher flushes from "now" and re-emits
  // the horizon under the new perform state.
  FlushPending {
    min_frame: u64,
  },
  // Detach every active, not-yet-frozen voice from its shared
  // track_params by snapshotting the current cutoff/resonance/fx_send
  // onto the voice. Issued on a scene/bank/song swap so in-flight tails
  // keep the OUTGOING scene's DSP settings as they ring out — the
  // incoming scene's params (pushed moments later) then can't retune the
  // tails (a resonance jump would otherwise self-oscillate into a crash).
  FreezeVoiceParams,
  // Loop/resample capture unit (P1). The audio thread keeps an
  // always-writing pre-master ring indexed by absolute engine frame, so
  // a capture is a modular slice of the PAST — grab the bars you just
  // heard, not the ones about to play. Playback is phase-locked to the
  // capture end ((frame - end_frame) % len), which makes the punch
  // seamless: the loop continues the mix in bar phase. The ring taps the
  // mix BEFORE loop playback injects, so loops can never re-capture
  // themselves (the Bluebox is output-only).
  LoopCapture {
    start_frame: u64,
    end_frame: u64,
  },
  LoopStop,
  LoopGain {
    gain: f32,
  },
  // P2 manipulation layer (Morphagene/ADDAC-112 flavored). speed =
  // thru-zero vari-speed, JS-side quantized to the octave ladder
  // ±(0.25/0.5/1/2/4) + 0 — octave ratios keep both pitch and the loop's
  // bar phase musically coherent; size = grain size norm (1.0 =
  // whole-loop tape mode, below = windowed grains down to ~20ms);
  // random = start-point randomness 0..1 (0 = grains at the playhead,
  // 1 = uniformly anywhere in the loop — ±half-loop offset depth, wrap
  // makes it truly uniform); grains = concurrent grain voices 1..8 (new
  // spawns steal the oldest); rate_hz = grain spawn rate 0.5..60,
  // independent of size (sparse blips ↔ dense cloud).
  // Per-control DEVIATION (the ADDAC 112 concept): each grain rolls its
  // own value within ±dev of the base — size_dev in size octaves (4^±dev),
  // pitch_dev in pitch octaves (2^±2dev), rate_dev as spawn-interval
  // jitter. `random` is position's deviation. All 0..1.
  // pitch: fixed grain read rate (octave ladder, signed = direction);
  // 0.0 = FOLLOW speed (tape-chained, the default). A fixed pitch under a
  // slow/stopped playhead is granular TIMESTRETCH — the periodic windows
  // re-reading the same material are the artifact.
  // loop_level / grain_level: INDEPENDENT layer outputs (Chris's
  // correction of the earlier crossfade read) — the tape loop and the
  // grain cloud are two modules over the same capture, each with its own
  // return level into the mix. Both up = both heard; either can be silent.
  // spawn_frames: grain spawn interval in device frames (JS converts from
  // clock divisions or free Hz); rate_synced: when true, spawns anchor to
  // the capture's bar grid (spawn ON the grid, not just at grid rate).
  // Bounce the loop unit's OUTPUT (post-mangle, post-gain — what you
  // hear) to a WAV via the recorder-worker pattern: the audio thread
  // pushes `frames` stereo frames starting at the next bar-grid point
  // ((abs − anchor) % align == 0, so the file re-loops cleanly), then
  // fires `stop` and the worker finalizes. This is the save-to-library
  // path (docs/loop-resample.md P4).
  LoopBounce {
    producer: HeapProd<f32>,
    frames: u64,
    align_frames: u64,
    stop: Arc<AtomicBool>,
  },
  // loop_lock: pitch-lock the TAPE layer — a two-head overlap-add
  // stretcher (85ms triangular windows, 50% hop) reads at native pitch
  // from the vari-speed playhead, so SPEED becomes pure time for the loop
  // layer: timestretch, reverse-at-pitch, frozen slice at stop. Off =
  // tape physics (pitch follows speed).
  // NOISE unit (P1, Mörser-shaped — docs/loop-resample.md §NOISE): a second
  // capture off the same pre-master ring, played by a simple vari-speed
  // head into: [+ clocked digital noise] → stereo WASP-grit SVF (tanh in
  // the resonance loop; per-channel resonance via res±width; LP/BP tap) →
  // always-on distortion → own return. The clocked noise ALSO jitters the
  // cutoff (the Mörser's noise→CV normalling) — clock at bar divisions or
  // free Hz. Sounds with an EMPTY capture (noise alone through the filter).
  NoiseCapture {
    start_frame: u64,
    end_frame: u64,
  },
  NoiseStop,
  NoiseParams {
    // 0 = INS (Loop A routes THROUGH the chain — wet-only, the save
    // bounce prints the post-noise signal); 1 = PAR (Loop A feeds the
    // chain in parallel — its direct injection stays, noise adds on top);
    // 2 = CAP (own capture — a second bed); 3 = OFF (self-sounding).
    source: u8,
    speed: f32,
    drive: f32,      // 0..1 → 1..24x input gain INTO the filter (the WASP
                     // level-sensitivity — pushing it IS the sound)
    cutoff: f32,     // 0..1 norm (log-mapped to Hz)
    res: f32,        // 0..1
    width: f32,      // 0..1 — L/R resonance offset (stereo instability)
    mode: u8,        // 0 = LP, 1 = BP
    noise: f32,      // 0..1 noise level into the audio path
    cv: f32,         // 0..1 noise→cutoff jitter depth (octaves at full)
    clock_frames: f32,
    clock_synced: bool,
    // SIGNAL CLOCK (Spektrum-shaped): clock_mode 1 derives ticks from a
    // signal's zero crossings instead of the timer — clock rate IS the
    // material's pitch/brightness. clock_src: 0 = the unit's own input,
    // 1 = Loop A's output, 2 = the pre-master mix. clock_div divides
    // crossings (/1../64 — audio-rate pitches pulled to gesture rate);
    // sens sets the hysteresis threshold (noise floor must not clock it;
    // raised, only loud material gets to be the clock).
    clock_mode: u8,
    clock_src: u8,
    clock_div: u32,
    sens: f32,
    level: f32,      // 0..2 return level
    fx_send: f32,
    rev_send: f32,
    del_send: f32,
  },
  LoopParams {
    speed: f32,
    pitch: f32,
    loop_lock: bool,
    loop_level: f32,
    grain_level: f32,
    fx_send: f32,
    rev_send: f32,
    del_send: f32,
    size: f32,
    random: f32,
    grains: u32,
    spawn_frames: f32,
    rate_synced: bool,
    size_dev: f32,
    pitch_dev: f32,
    rate_dev: f32,
  },
}

#[derive(Clone, Copy)]
pub(crate) struct EnvelopeSpec {
  attack_secs: f32,
  decay_secs: f32,
  sustain_level: f32,
  release_secs: f32,
  hold_secs: f32, // gate × stepDuration (computed JS-side)
}

// Holds a voice-ready trigger that hasn't fired yet. Pan, rate, etc.
// are pre-computed at queue time so the firing path only has to copy
// into a slot. target_frame is an absolute ENGINE_FRAMES deadline; a
// trigger that arrives "late" (target already behind the current
// block, from IPC + block-boundary latency) fires at the top of the
// block via saturating_sub.
struct PendingTrigger {
  sample: Arc<SampleData>,
  rate: f64,
  gain: f32,
  pan_left: f32,
  pan_right: f32,
  pan_base: f32,
  out_first: usize,
  out_stereo: bool,
  track_params: Option<Arc<TrackParams>>,
  monophonic: bool,
  choke_group: u32,
  section: u8,
  is_texture: bool,
  envelope: Option<EnvelopeSpec>,
  target_frame: u64,
  note_id: u64,
  // Sample window in frames (resolved from the 0..1 fractions at queue
  // time) + loop mode (0 off · 1 fwd · 2 bwd · 3 pingpong · 4 rev one-shot).
  // play_end is the read position the voice stops/loops at; play_start the start.
  play_start: f64,
  play_end: f64,
  loop_mode: u8,
  // Per-instrument filter: on flag + prebuilt biquad coefficients (computed
  // at queue time so the audio thread just copies them into the voice).
  inst_filter_on: bool,
  inst_filter: Biquad,
  // Base filter params kept for live LFO recompute (type 1 lp · 2 hp · 3 bp;
  // cutoff normalized 0..1; q the resolved biquad Q). When the LFO is active
  // the voice recomputes coefficients from cutoff_norm + LFO offset.
  inst_filter_type: u8,
  inst_cutoff_norm: f32,
  inst_q: f32,
  // Per-instrument saturation drive (0 = bypass), applied post-filter.
  sat_drive: f32,
  // Per-instrument bit crush, 4..16 (>=16 = bypass), after saturation.
  bit_depth: u8,
  // Cutoff LFO: on flag + shape + rate (Hz) + depth (0..1 bipolar).
  lfo_on: bool,
  lfo_shape: u8,
  lfo_rate_hz: f32,
  lfo_depth: f32,
  // Generic modulator grid.
  mods: [Modulator; MOD_SLOTS],
  // Granular (editor Phase C). gran_grain_frames resolved from ms at queue time.
  gran_on: bool,
  gran_grain_frames: f64,
  gran_pos_norm: f32,
  gran_shape: u8,
  gran_dir: u8,
  gran_spray: f32,
  // Wavetable (editor Phase D). wt_window_frames resolved (snapped, clamped) at
  // queue time; wt_hz = played note fundamental.
  wt_on: bool,
  wt_window_frames: f64,
  wt_pos_norm: f32,
  wt_morph: bool,
  wt_hz: f32,
  wt_smooth: bool, // sample is the baked variant → circular in-window read
}

// --- shared state ---

struct SharedState {
  channels: AtomicU32,
  sample_rate: AtomicU32,
  test_tone_enabled: AtomicBool,
  test_tone_channel: AtomicUsize,
  test_tone_freq_mhz: AtomicU32, // freq Hz * 1000
  // Producer for the audio callback's command queue. Lives behind a
  // Mutex so command threads can push, but the audio thread holds the
  // matching consumer side directly and never blocks.
  trigger_producer: Mutex<Option<HeapProd<MixerCommand>>>,
  // Mix routing. multi_out=false collapses every voice + FX bus to
  // channels 0+1 regardless of per-voice routing config (graceful
  // headphone-monitor mode). multi_out=true honors per-voice
  // out_first/out_stereo and fx_out_first/fx_out_stereo. fx_bypass
  // skips the entire FX chain (currently just reverb); voices' wet
  // contributions are treated as zero so dry passes through full
  // level with no energy loss.
  multi_out: AtomicBool,
  fx_out_first: AtomicU32,
  fx_out_stereo: AtomicBool,
  fx_bypass: AtomicBool,
}

impl SharedState {
  fn new() -> Self {
    Self {
      channels: AtomicU32::new(0),
      sample_rate: AtomicU32::new(0),
      test_tone_enabled: AtomicBool::new(false),
      test_tone_channel: AtomicUsize::new(0),
      test_tone_freq_mhz: AtomicU32::new(440_000),
      trigger_producer: Mutex::new(None),
      multi_out: AtomicBool::new(false),
      fx_out_first: AtomicU32::new(0),
      fx_out_stereo: AtomicBool::new(true),
      fx_bypass: AtomicBool::new(false),
    }
  }
}

enum EngineCommand {
  Open {
    device_name: String,
    channels: u32,
    sample_rate: u32,
    buffer_size: Option<u32>,
    reply: Sender<Result<OpenedInfo, String>>,
  },
  Close {
    reply: Sender<Result<(), String>>,
  },
  #[allow(dead_code)]
  Shutdown,
}

pub struct AudioEngine {
  cmd_tx: Sender<EngineCommand>,
  state: Arc<SharedState>,
}

static ENGINE: OnceLock<AudioEngine> = OnceLock::new();

pub fn engine() -> &'static AudioEngine {
  ENGINE.get_or_init(AudioEngine::start)
}

impl AudioEngine {
  fn start() -> Self {
    let (cmd_tx, cmd_rx) = channel();
    let state = Arc::new(SharedState::new());
    let state_clone = state.clone();
    // 16 MB stack — the Faust-generated reverb DSP struct contains
    // several large delay/feedback buffers (~600 KB total) and is
    // constructed on this thread inside ReverbBus::new(). Default
    // thread stack (~2 MB on macOS) overflows during struct-literal
    // initialization. Bumping here so the closure has headroom.
    thread::Builder::new()
      .name("sequence-audio-control".into())
      .stack_size(16 * 1024 * 1024)
      .spawn(move || control_thread(cmd_rx, state_clone))
      .expect("spawn audio control thread");
    Self { cmd_tx, state }
  }

  pub fn open(
    &self,
    device_name: String,
    channels: u32,
    sample_rate: u32,
    buffer_size: Option<u32>,
  ) -> Result<OpenedInfo, String> {
    let (tx, rx) = channel();
    self
      .cmd_tx
      .send(EngineCommand::Open {
        device_name,
        channels,
        sample_rate,
        buffer_size,
        reply: tx,
      })
      .map_err(|e| format!("send open: {}", e))?;
    rx.recv().map_err(|e| format!("recv open: {}", e))?
  }

  pub fn close(&self) -> Result<(), String> {
    let (tx, rx) = channel();
    self
      .cmd_tx
      .send(EngineCommand::Close { reply: tx })
      .map_err(|e| format!("send close: {}", e))?;
    rx.recv().map_err(|e| format!("recv close: {}", e))?
  }

  pub fn set_test_tone(&self, channel: Option<usize>, frequency_hz: f32) {
    if let Some(ch) = channel {
      let freq_mhz = (frequency_hz.max(1.0).min(20000.0) * 1000.0) as u32;
      self.state.test_tone_freq_mhz.store(freq_mhz, Ordering::Relaxed);
      self.state.test_tone_channel.store(ch, Ordering::Relaxed);
      self.state.test_tone_enabled.store(true, Ordering::Release);
    } else {
      self.state.test_tone_enabled.store(false, Ordering::Release);
    }
  }

  pub fn current_channels(&self) -> u32 {
    self.state.channels.load(Ordering::Acquire)
  }
  pub fn current_sample_rate(&self) -> u32 {
    self.state.sample_rate.load(Ordering::Acquire)
  }

  pub fn load_sample(&self, path: String) -> Result<SampleLoadInfo, String> {
    if let Some(info) = self.cached_sample_info(&path)? {
      return Ok(info);
    }
    let sample = load_wav(&path)?;
    Ok(self.register_sample(path, sample)?)
  }

  pub fn load_sample_from_bytes(
    &self,
    path: String,
    bytes: Vec<u8>,
  ) -> Result<SampleLoadInfo, String> {
    if let Some(info) = self.cached_sample_info(&path)? {
      return Ok(info);
    }
    let sample = load_wav_from_bytes(&bytes)?;
    Ok(self.register_sample(path, sample)?)
  }

  // Load a bundled sample from its real filesystem path, but register
  // it under its URL-style key so trigger lookups (which use the URL)
  // continue to match. Cache check stays in the calling command — the
  // resolved fs path isn't known until the command runs.
  pub fn load_bundled_sample(
    &self,
    url_key: String,
    fs_path: &std::path::Path,
  ) -> Result<SampleLoadInfo, String> {
    if let Some(info) = self.cached_sample_info(&url_key)? {
      return Ok(info);
    }
    let sample = load_wav(
      fs_path.to_str().ok_or_else(|| "bundled path not utf-8".to_string())?,
    )?;
    self.register_sample(url_key, sample)
  }

  fn cached_sample_info(&self, path: &str) -> Result<Option<SampleLoadInfo>, String> {
    let registry = samples_registry()
      .lock()
      .map_err(|e| format!("registry lock: {}", e))?;
    if let Some(existing) = registry.get(path) {
      let fc = existing.frame_count();
      Ok(Some(SampleLoadInfo {
        path: path.to_string(),
        channels: existing.channels,
        sample_rate: existing.sample_rate,
        frames: fc as u32,
        duration_secs: if existing.sample_rate > 0 {
          fc as f32 / existing.sample_rate as f32
        } else {
          0.0
        },
      }))
    } else {
      Ok(None)
    }
  }

  fn register_sample(
    &self,
    path: String,
    sample: SampleData,
  ) -> Result<SampleLoadInfo, String> {
    let fc = sample.frame_count();
    let info = SampleLoadInfo {
      path: path.clone(),
      channels: sample.channels,
      sample_rate: sample.sample_rate,
      frames: fc as u32,
      duration_secs: fc as f32 / sample.sample_rate as f32,
    };
    let mut registry = samples_registry()
      .lock()
      .map_err(|e| format!("registry lock: {}", e))?;
    registry.insert(path, Arc::new(sample));
    Ok(info)
  }

  #[allow(clippy::too_many_arguments)]
  pub fn trigger_sample(
    &self,
    path: String,
    gain: f32,
    pan: f32,
    pitch: f32,
    out_first: u32,
    out_stereo: bool,
    track_id: Option<String>,
    delay_secs: f32,
    target_frame: u64,
    monophonic: bool,
    choke_group: Option<String>,
    section: u8,
    is_texture: bool,
    envelope: Option<EnvelopeSpec>,
    note_id: u64,
    start_frac: f32,
    end_frac: f32,
    loop_mode: u8,
    inst_filter_type: u8,
    inst_cutoff: f32,
    inst_resonance: f32,
    sat_drive: f32,
    bit_depth: u8,
    lfo_shape: u8,
    lfo_rate_hz: f32,
    lfo_depth: f32,
    mod_specs: Vec<ModSpecIpc>,
    gran_on: bool,
    gran_grain_ms: f32,
    gran_position: f32,
    gran_shape: u8,
    gran_dir: u8,
    gran_spray: f32,
    wt_on: bool,
    wt_window_frames: f32,
    wt_pos_norm: f32,
    wt_morph: bool,
    wt_hz: f32,
    wt_smooth: bool,
  ) -> Result<(), String> {
    let sample = {
      let registry = samples_registry()
        .lock()
        .map_err(|e| format!("registry lock: {}", e))?;
      registry
        .get(&path)
        .cloned()
        .ok_or_else(|| format!("sample not loaded: {}", path))?
    };
    // Wavetable smoother: swap in the baked variant (cached; first trigger
    // per sample+window bakes on this command thread — the audio thread
    // never sees anything but a normal Arc<SampleData>).
    let sample = if wt_on && wt_smooth {
      wavetable_smoothed(&sample, wt_window_frames)
    } else {
      sample
    };
    let track_params = track_id
      .as_deref()
      .map(get_or_create_track_params);
    // Choke group crosses IPC as the manifest's group name; hash it here
    // (command thread) so only a Copy u32 rides the ring into the audio
    // callback — no String alloc/drop on the realtime path. 0 is reserved
    // for "no group"; an (unlikely) zero hash nudges to 1.
    let choke_group = choke_group
      .as_deref()
      .filter(|g| !g.is_empty())
      .map(|g| {
        let h = fnv1a_32(g.as_bytes());
        if h == 0 { 1 } else { h }
      })
      .unwrap_or(0);
    // Convert delay seconds → frames at the device sample rate. The
    // audio callback dequeues by frame count, so seconds is the
    // unit-agnostic value to cross IPC; sample rate is owned by Rust.
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    let delay_samples = if sr == 0 || !delay_secs.is_finite() || delay_secs <= 0.0 {
      0u32
    } else {
      (delay_secs * sr as f32).round().max(0.0).min(u32::MAX as f32) as u32
    };
    // Build the generic modulator array here (command thread) so env stage
    // lengths are resolved to samples and the audio thread just copies a Copy
    // array — no heap on the realtime path.
    let mods = build_mod_array(&mod_specs, if sr == 0 { 48_000.0 } else { sr as f32 });
    let cmd = MixerCommand::Trigger {
      sample,
      gain,
      pan,
      pitch,
      out_first,
      out_stereo,
      track_params,
      monophonic,
      choke_group,
      section,
      is_texture,
      envelope,
      target_frame,
      delay_samples,
      note_id,
      start_frac,
      end_frac,
      loop_mode,
      inst_filter_type,
      inst_cutoff,
      inst_resonance,
      sat_drive,
      bit_depth,
      lfo_shape,
      lfo_rate_hz,
      lfo_depth,
      mods,
      gran_on,
      gran_grain_ms,
      gran_position,
      gran_shape,
      gran_dir,
      gran_spray,
      wt_on,
      wt_window_frames,
      wt_pos_norm,
      wt_morph,
      wt_hz,
      wt_smooth,
    };
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(cmd)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  // Phase 6: cutoff arrives normalized (0..1) so LFO modulation can
  // operate in the same space as the web `modulated()` helper. Rust
  // converts to Hz via the same log curve as `cutoffNormToHz`.
  pub fn set_track_filter(&self, track_id: String, cutoff_norm: f32, resonance: f32) {
    let params = get_or_create_track_params(&track_id);
    params.set_filter_norm(cutoff_norm.clamp(0.0, 1.0), resonance.clamp(0.0, 1.0));
  }

  // Reverb DSP params + global wet-bus gain. Held in atomics inside the
  // shared ReverbState so the audio callback can read them lock-free
  // each block. The DSP's internal mix is pinned to 1.0 (fully wet) at
  // construction — the `wet_gain` here is the post-reverb bus gain.
  pub fn set_reverb_params(
    &self,
    size: f32,
    wet_gain: f32,
    diffusion: f32,
    damping: f32,
  ) {
    reverb_state().ipc_set(
      size.clamp(0.0, 1.0),
      wet_gain.clamp(0.0, 4.0),
      diffusion.clamp(0.0, 0.85),
      damping.clamp(0.0, 1.0),
    );
  }

  // Global ping-pong delay params. `delay_seconds` is the tempo-synced time
  // (JS computes it from the note division + bpm); `feedback` 0..1.1;
  // `pingpong` 0..1 (straight stereo → full cross-feed); `lofi` 0..1 (feedback
  // degradation).
  pub fn set_delay_params(
    &self,
    delay_seconds: f32,
    feedback: f32,
    pingpong: f32,
    lofi: f32,
  ) {
    delay_state().ipc_set(
      delay_seconds.max(0.0),
      feedback.clamp(0.0, 1.1),
      pingpong.clamp(0.0, 1.0),
      lofi.clamp(0.0, 1.0),
    );
  }

  // Pre-saturation drive (in the wet bus, ahead of reverb).
  pub fn set_saturation_params(&self, pre_drive: f32) {
    saturation_state().ipc_set(pre_drive.clamp(0.0, 1.0));
  }

  // Glitch mix knob. Chance dice live in JS (scheduler.onStep handles
  // the beat clock); `glitch_fire` is the one-shot trigger.
  pub fn set_glitch_params(&self, mix: f32) {
    glitch_state().ipc_set(mix.clamp(0.0, 1.0));
  }

  // Fire the glitch stage. target_frame == 0 → ASAP (next block);
  // otherwise an absolute ENGINE_FRAMES deadline — the stutter starts
  // in the block containing that frame, aligning the fire with the
  // audible beat the scheduler targeted.
  pub fn glitch_fire(&self, target_frame: u64) {
    let g = glitch_state();
    if target_frame == 0 {
      g.fire_requested.store(true, Ordering::Release);
    } else {
      g.fire_at_frame.store(target_frame, Ordering::Release);
    }
  }

  // Master stage params (phase 7e-1: input gain + lo-cut index + hi-cut
  // norm + trim). Comp/dist/gate atomics land in later phases.
  pub fn set_master_filters(
    &self,
    input: f32,
    lo_cut: u32,
    hi_cut: f32,
    trim: f32,
  ) {
    master_state().ipc_set_filters(
      input.clamp(0.0, 1.0),
      lo_cut.min(MASTER_LO_CUT_FREQS.len() as u32 - 1),
      hi_cut.clamp(0.0, 1.0),
      trim.clamp(0.0, 1.0),
    );
  }

  // Gate (phase 7e-4). `enabled` toggles passthrough; `threshold` 0..1
  // maps to -30..0 dB.
  pub fn set_master_gate(&self, enabled: bool, threshold: f32) {
    master_state().ipc_set_gate(enabled, threshold.clamp(0.0, 1.0));
  }

  // Master bypass (phase 7e-5). Smoothly crossfades the master output
  // toward the dry input over ~5ms; chain state continues to run so
  // toggling back finds the comp / dist / gate envelopes intact.
  pub fn set_master_bypass(&self, bypass: bool) {
    master_state().bypass.store(bypass, Ordering::Release);
  }

  // Combined recording (phase 7f-1). Creates the WAV file, spins up a
  // worker thread to drain the audio queue, and hands the producer to
  // the audio callback via the MixerCommand queue (avoids any locking
  // on the audio thread). AppHandle is captured by the worker so it
  // can emit `recorder:finalized` for the success toast.
  pub fn start_recording_combined(
    &self,
    app: tauri::AppHandle,
    path: String,
    start_frame: u64,
  ) -> Result<(), String> {
    let r = recorder_state();
    if r.combined_enabled.load(Ordering::Acquire) {
      return Err("combined recording already in progress".to_string());
    }
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    if sr == 0 {
      return Err("audio device not open".to_string());
    }
    // ~5s of headroom at 48k stereo (480_000 f32 samples = 1.9 MB).
    // Worker drains every 5ms so this is far more than ever needed
    // in practice; keeps the audio thread's push side from blocking.
    const QUEUE_SAMPLES: usize = 480_000;
    let (prod, cons) = HeapRb::<f32>::new(QUEUE_SAMPLES).split();

    let spec = hound::WavSpec {
      channels: 2,
      sample_rate: sr,
      bits_per_sample: 32,
      sample_format: hound::SampleFormat::Float,
    };
    let writer = hound::WavWriter::create(&path, spec)
      .map_err(|e| format!("create wav '{}': {}", path, e))?;

    r.combined_stop.store(false, Ordering::Release);
    spawn_recorder_worker(
      app.clone(),
      "combined",
      path.clone(),
      writer,
      cons,
      Arc::clone(&r.combined_stop),
    );

    // Push the producer to the audio thread via the existing command queue.
    // On failure past this point the worker is already spinning — set the
    // stop flag so it finalizes (an empty WAV) and exits, instead of idling
    // forever holding an open file no stop path can reach.
    let arm = (|| -> Result<(), String> {
      let mut guard = self
        .state
        .trigger_producer
        .lock()
        .map_err(|e| format!("producer lock: {}", e))?;
      let producer = guard
        .as_mut()
        .ok_or_else(|| "audio device not open".to_string())?;
      producer
        .try_push(MixerCommand::StartCombinedRecording {
          producer: prod,
          start_frame,
        })
        .map_err(|_| "command queue full (start recording)".to_string())
    })();
    if let Err(e) = arm {
      r.combined_stop.store(true, Ordering::Release);
      return Err(e);
    }

    r.combined_enabled.store(true, Ordering::Release);
    Ok(())
  }

  pub fn stop_recording_combined(&self) -> Result<(), String> {
    let r = recorder_state();
    if !r.combined_enabled.swap(false, Ordering::AcqRel) {
      // Idempotent — stopping a non-running recorder is fine.
      return Ok(());
    }
    // Flags FIRST, producer push best-effort after. The worker finalizes
    // off the stop flag alone; if the device was closed (or switched) in
    // the meantime the callback-side producer already died with the old
    // stream, and erroring out here would leave the worker spinning
    // forever with an unfinalized WAV and the enabled flag stuck true.
    r.combined_stop.store(true, Ordering::Release);
    if let Ok(mut guard) = self.state.trigger_producer.lock() {
      if let Some(producer) = guard.as_mut() {
        let _ = producer.try_push(MixerCommand::StopCombinedRecording);
      }
    }
    Ok(())
  }

  pub fn is_recording_combined(&self) -> bool {
    recorder_state().combined_enabled.load(Ordering::Acquire)
  }

  // Splits recording (phase 7f-2). Two WAV files written in parallel —
  // rhythm (drum-section voices + count-in clicks) + melody (melodic-
  // section voices + count-in clicks). Pre-FX, pre-master raw signal
  // matches the web splits convention so DAWs can do their own master
  // tone-shaping on the stems.
  pub fn start_recording_splits(
    &self,
    app: tauri::AppHandle,
    rhythm_path: String,
    melody_path: String,
  ) -> Result<(), String> {
    let r = recorder_state();
    if r.splits_enabled.load(Ordering::Acquire) {
      return Err("splits recording already in progress".to_string());
    }
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    if sr == 0 {
      return Err("audio device not open".to_string());
    }
    const QUEUE_SAMPLES: usize = 480_000;
    let spec = hound::WavSpec {
      channels: 2,
      sample_rate: sr,
      bits_per_sample: 32,
      sample_format: hound::SampleFormat::Float,
    };
    let rhythm_writer = hound::WavWriter::create(&rhythm_path, spec)
      .map_err(|e| format!("create rhythm wav '{}': {}", rhythm_path, e))?;
    let melody_writer = hound::WavWriter::create(&melody_path, spec)
      .map_err(|e| format!("create melody wav '{}': {}", melody_path, e))?;
    let (rhythm_prod, rhythm_cons) = HeapRb::<f32>::new(QUEUE_SAMPLES).split();
    let (melody_prod, melody_cons) = HeapRb::<f32>::new(QUEUE_SAMPLES).split();

    r.splits_stop.store(false, Ordering::Release);

    // One worker per file. Identical drain loop pattern as combined.
    spawn_recorder_worker(
      app.clone(),
      "rhythm",
      rhythm_path.clone(),
      rhythm_writer,
      rhythm_cons,
      Arc::clone(&r.splits_stop),
    );
    spawn_recorder_worker(
      app.clone(),
      "melody",
      melody_path.clone(),
      melody_writer,
      melody_cons,
      Arc::clone(&r.splits_stop),
    );

    // On failure past this point both workers are already spinning — set
    // the stop flag so they finalize and exit (see start_recording_combined).
    let arm = (|| -> Result<(), String> {
      let mut guard = self
        .state
        .trigger_producer
        .lock()
        .map_err(|e| format!("producer lock: {}", e))?;
      let producer = guard
        .as_mut()
        .ok_or_else(|| "audio device not open".to_string())?;
      producer
        .try_push(MixerCommand::StartSplitsRecording {
          rhythm: rhythm_prod,
          melody: melody_prod,
        })
        .map_err(|_| "command queue full (start splits)".to_string())
    })();
    if let Err(e) = arm {
      r.splits_stop.store(true, Ordering::Release);
      return Err(e);
    }

    r.splits_enabled.store(true, Ordering::Release);
    Ok(())
  }

  pub fn stop_recording_splits(&self) -> Result<(), String> {
    let r = recorder_state();
    if !r.splits_enabled.swap(false, Ordering::AcqRel) {
      return Ok(());
    }
    // Flags first, producer push best-effort — see stop_recording_combined.
    r.splits_stop.store(true, Ordering::Release);
    if let Ok(mut guard) = self.state.trigger_producer.lock() {
      if let Some(producer) = guard.as_mut() {
        let _ = producer.try_push(MixerCommand::StopSplitsRecording);
      }
    }
    Ok(())
  }

  pub fn is_recording_splits(&self) -> bool {
    recorder_state().splits_enabled.load(Ordering::Acquire)
  }

  // Full-stems recording. Writes, in one sample-locked take: master (post-
  // master mix), fx (mangler bus), reverb + delay (the wet returns), and one
  // dry WAV per track. Every producer installs on the same audio block via a
  // single StartStemsRecording command, so all files share a sample origin.
  // Per-track dry taps carry dry_scale, so Σ(tracks) + fx + reverb + delay
  // reconstructs the pre-master mix. All files land in `stem_dir`.
  #[allow(clippy::too_many_arguments)]
  pub fn start_recording_stems(
    &self,
    app: tauri::AppHandle,
    stem_dir: String,
    master_path: String,
    fx_path: String,
    reverb_path: String,
    delay_path: String,
    track_ids: Vec<String>,
    track_paths: Vec<String>,
    start_frame: u64,
  ) -> Result<(), String> {
    let r = recorder_state();
    if r.stems_enabled.load(Ordering::Acquire) {
      return Err("stems recording already in progress".to_string());
    }
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    if sr == 0 {
      return Err("audio device not open".to_string());
    }
    if track_ids.len() != track_paths.len() {
      return Err("track_ids / track_paths length mismatch".to_string());
    }
    let n = track_paths.len().min(MAX_STEMS);
    // WavWriter::create won't mkdir — ensure the take's subfolder exists.
    std::fs::create_dir_all(&stem_dir)
      .map_err(|e| format!("create stem dir '{}': {}", stem_dir, e))?;

    const QUEUE_SAMPLES: usize = 480_000;
    let spec = hound::WavSpec {
      channels: 2,
      sample_rate: sr,
      bits_per_sample: 32,
      sample_format: hound::SampleFormat::Float,
    };

    // Assign fresh 1-based slots to the recorded tracks; wipe any stale
    // indices first so a prior take's ordering can't leak in.
    reset_all_rec_tracks();
    for (i, tid) in track_ids.iter().take(MAX_STEMS).enumerate() {
      get_or_create_track_params(tid).set_rec_track((i + 1) as u8);
    }

    r.stems_stop.store(false, Ordering::Release);

    // Create a WAV + ring + worker for one labeled stream. Any failure
    // after the first worker spawns sets the stop flag (below) so the
    // already-running workers finalize their empty WAVs and exit.
    let make = |label: &'static str, path: String| -> Result<HeapProd<f32>, String> {
      let writer = hound::WavWriter::create(&path, spec)
        .map_err(|e| format!("create wav '{}': {}", path, e))?;
      let (prod, cons) = HeapRb::<f32>::new(QUEUE_SAMPLES).split();
      spawn_recorder_worker(
        app.clone(),
        label,
        path,
        writer,
        cons,
        Arc::clone(&r.stems_stop),
      );
      Ok(prod)
    };

    let arm = (|| -> Result<(), String> {
      let master = make("master", master_path)?;
      let fx = make("fx", fx_path)?;
      let reverb = make("reverb", reverb_path)?;
      let delay = make("delay", delay_path)?;

      let mut tracks: Box<[Option<HeapProd<f32>>; MAX_STEMS]> =
        Box::new(std::array::from_fn(|_| None));
      for i in 0..n {
        tracks[i] = Some(make(STEM_LABELS[i], track_paths[i].clone())?);
      }

      let mut guard = self
        .state
        .trigger_producer
        .lock()
        .map_err(|e| format!("producer lock: {}", e))?;
      let producer = guard
        .as_mut()
        .ok_or_else(|| "audio device not open".to_string())?;
      producer
        .try_push(MixerCommand::StartStemsRecording {
          master: Some(master),
          fx: Some(fx),
          reverb: Some(reverb),
          delay: Some(delay),
          tracks,
          start_frame,
        })
        .map_err(|_| "command queue full (start stems)".to_string())
    })();
    if let Err(e) = arm {
      r.stems_stop.store(true, Ordering::Release);
      reset_all_rec_tracks();
      return Err(e);
    }

    r.stems_enabled.store(true, Ordering::Release);
    Ok(())
  }

  pub fn stop_recording_stems(&self) -> Result<(), String> {
    let r = recorder_state();
    if !r.stems_enabled.swap(false, Ordering::AcqRel) {
      return Ok(());
    }
    // Flag first, command best-effort — same closed-device tolerance as
    // stop_recording_combined.
    r.stems_stop.store(true, Ordering::Release);
    if let Ok(mut guard) = self.state.trigger_producer.lock() {
      if let Some(producer) = guard.as_mut() {
        let _ = producer.try_push(MixerCommand::StopStemsRecording);
      }
    }
    Ok(())
  }

  pub fn is_recording_stems(&self) -> bool {
    recorder_state().stems_enabled.load(Ordering::Acquire)
  }

  // Distortion (phase 7e-3). `mode` 0..3, `drive` + `bias` + `mix` 0..1.
  pub fn set_master_dist(
    &self,
    mode: u32,
    drive: f32,
    bias: f32,
    mix: f32,
  ) {
    master_state().ipc_set_dist(
      mode.min(MASTER_DIST_NUM_MODES - 1),
      drive.clamp(0.0, 1.0),
      bias.clamp(0.0, 0.2),
      mix.clamp(0.0, 1.0),
    );
  }

  // Compressor (phase 7e-2). `amount` 0..1 is the one-knob;
  // attack/release are integer indices 0..5 into the ms tables.
  pub fn set_master_comp(
    &self,
    amount: f32,
    attack_idx: u32,
    release_idx: u32,
  ) {
    master_state().ipc_set_comp(
      amount.clamp(0.0, 1.0),
      attack_idx.min(MASTER_COMP_ATTACK_MS.len() as u32 - 1),
      release_idx.min(MASTER_COMP_RELEASE_MS.len() as u32 - 1),
    );
  }

  // Tape params (in the wet bus, ahead of drive + reverb). Phase 3+4:
  // both bed layers + hold + crossfade-on-wrap + grain spawner.
  // Phase 6: position/length/mix/grain_rate/grain_mix are LFO-modulated
  // — write both base and effective so the no-LFO path works.
  #[allow(clippy::too_many_arguments)]
  pub fn set_tape_params(
    &self,
    position: f32,
    length: f32,
    stretch1: f32,
    gain1: f32,
    stretch2: f32,
    gain2: f32,
    mix: f32,
    reverse: bool,
    hold: bool,
    grain_rate: f32,
    grain_mix: f32,
  ) {
    let t = tape_state();
    let p = position.clamp(0.0, 1.0).to_bits();
    t.position_base.store(p, Ordering::Release);
    t.position.store(p, Ordering::Release);
    let l = length.clamp(0.0, 1.0).to_bits();
    t.length_base.store(l, Ordering::Release);
    t.length.store(l, Ordering::Release);
    t.stretch1
      .store(stretch1.clamp(0.25, 4.0).to_bits(), Ordering::Release);
    t.gain1
      .store(gain1.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    t.stretch2
      .store(stretch2.clamp(0.25, 4.0).to_bits(), Ordering::Release);
    t.gain2
      .store(gain2.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    let m = mix.clamp(0.0, 1.0).to_bits();
    t.mix_base.store(m, Ordering::Release);
    t.mix.store(m, Ordering::Release);
    t.reverse.store(reverse, Ordering::Release);
    t.hold.store(hold, Ordering::Release);
    let gr = grain_rate.clamp(0.0, 1.0).to_bits();
    t.grain_rate_base.store(gr, Ordering::Release);
    t.grain_rate.store(gr, Ordering::Release);
    let gm = grain_mix.clamp(0.0, 1.0).to_bits();
    t.grain_mix_base.store(gm, Ordering::Release);
    t.grain_mix.store(gm, Ordering::Release);
  }

  // Global mix routing — see SharedState comments.
  pub fn set_mix_routing(
    &self,
    multi_out: bool,
    fx_out_first: u32,
    fx_out_stereo: bool,
    fx_bypass: bool,
  ) {
    self.state.multi_out.store(multi_out, Ordering::Release);
    self.state.fx_out_first.store(fx_out_first, Ordering::Release);
    self.state.fx_out_stereo.store(fx_out_stereo, Ordering::Release);
    self.state.fx_bypass.store(fx_bypass, Ordering::Release);
  }

  pub fn stop_all_voices(&self) -> Result<(), String> {
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(MixerCommand::StopAll)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  pub fn panic(&self) -> Result<(), String> {
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(MixerCommand::Panic)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  // Perform punch edges — drop queued triggers with deadline >= min_frame
  // so the JS dispatcher can re-emit the scheduling horizon under the new
  // perform state. Sounding voices ring on untouched.
  pub fn flush_pending(&self, min_frame: u64) -> Result<(), String> {
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(MixerCommand::FlushPending { min_frame })
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  // Loop/resample capture unit — see MixerCommand::LoopCapture.
  fn push_command(&self, cmd: MixerCommand) -> Result<(), String> {
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(cmd)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  pub fn loop_capture(&self, start_frame: u64, end_frame: u64) -> Result<(), String> {
    self.push_command(MixerCommand::LoopCapture { start_frame, end_frame })
  }

  pub fn loop_stop(&self) -> Result<(), String> {
    self.push_command(MixerCommand::LoopStop)
  }

  pub fn loop_gain(&self, gain: f32) -> Result<(), String> {
    self.push_command(MixerCommand::LoopGain { gain })
  }

  pub fn noise_capture(&self, start_frame: u64, end_frame: u64) -> Result<(), String> {
    self.push_command(MixerCommand::NoiseCapture { start_frame, end_frame })
  }

  pub fn noise_stop(&self) -> Result<(), String> {
    self.push_command(MixerCommand::NoiseStop)
  }

  #[allow(clippy::too_many_arguments)]
  pub fn noise_params(
    &self,
    source: u8,
    speed: f32,
    drive: f32,
    cutoff: f32,
    res: f32,
    width: f32,
    mode: u8,
    noise: f32,
    cv: f32,
    clock_frames: f32,
    clock_synced: bool,
    clock_mode: u8,
    clock_src: u8,
    clock_div: u32,
    sens: f32,
    level: f32,
    fx_send: f32,
    rev_send: f32,
    del_send: f32,
  ) -> Result<(), String> {
    self.push_command(MixerCommand::NoiseParams {
      source,
      speed,
      drive,
      cutoff,
      res,
      width,
      mode,
      noise,
      cv,
      clock_frames,
      clock_synced,
      clock_mode,
      clock_src,
      clock_div,
      sens,
      level,
      fx_send,
      rev_send,
      del_send,
    })
  }

  // Save-to-library bounce — mirrors start-combined-recording: rb + hound
  // writer + recorder worker, but fed by the loop unit's output tap and
  // self-stopping after `frames`.
  pub fn loop_bounce(
    &self,
    app: tauri::AppHandle,
    path: String,
    frames: u64,
    align_frames: u64,
  ) -> Result<(), String> {
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    if sr == 0 {
      return Err("audio device not open".to_string());
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| format!("create dir '{}': {}", parent.display(), e))?;
    }
    const QUEUE_SAMPLES: usize = 480_000;
    let (prod, cons) = HeapRb::<f32>::new(QUEUE_SAMPLES).split();
    let spec = hound::WavSpec {
      channels: 2,
      sample_rate: sr,
      bits_per_sample: 32,
      sample_format: hound::SampleFormat::Float,
    };
    let writer = hound::WavWriter::create(&path, spec)
      .map_err(|e| format!("create wav '{}': {}", path, e))?;
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut g) = loop_bounce_teardown().lock() {
      if let Some(prev) = g.replace(Arc::clone(&stop)) {
        prev.store(true, Ordering::Release);
      }
    }
    spawn_recorder_worker(
      app,
      "loop",
      path.clone(),
      writer,
      cons,
      Arc::clone(&stop),
    );
    match self.push_command(MixerCommand::LoopBounce {
      producer: prod,
      frames,
      align_frames,
      stop: Arc::clone(&stop),
    }) {
      Ok(()) => Ok(()),
      Err(e) => {
        // Worker is already spinning — finalize the empty take so it
        // exits instead of idling on an open file forever.
        stop.store(true, Ordering::Release);
        Err(e)
      }
    }
  }

  #[allow(clippy::too_many_arguments)]
  pub fn loop_params(
    &self,
    speed: f32,
    pitch: f32,
    loop_lock: bool,
    loop_level: f32,
    grain_level: f32,
    size: f32,
    random: f32,
    grains: u32,
    spawn_frames: f32,
    rate_synced: bool,
    size_dev: f32,
    pitch_dev: f32,
    rate_dev: f32,
    fx_send: f32,
    rev_send: f32,
    del_send: f32,
  ) -> Result<(), String> {
    self.push_command(MixerCommand::LoopParams {
      speed,
      pitch,
      loop_lock,
      loop_level,
      grain_level,
      fx_send,
      rev_send,
      del_send,
      size,
      random,
      grains,
      spawn_frames,
      rate_synced,
      size_dev,
      pitch_dev,
      rate_dev,
    })
  }

  // Transport-stop texture fade. Fade time arrives in seconds; convert
  // to frames at the device sample rate (the audio thread counts down in
  // frames). Only texture-role voices are affected.
  pub fn fade_textures(&self, fade_secs: f32) -> Result<(), String> {
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    let fade_frames = if sr == 0 || !fade_secs.is_finite() || fade_secs <= 0.0 {
      0
    } else {
      (fade_secs * sr as f32).round().max(0.0).min(u32::MAX as f32) as u32
    };
    let cmd = MixerCommand::FadeTextures { fade_frames };
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(cmd)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  // Release a single tagged voice — live-input monitoring note-off. Fade
  // time arrives in seconds; convert to frames at the device sample rate.
  // A zero/non-finite fade falls back to a short default so a note-off
  // never hard-cuts (which would click).
  pub fn release_note(&self, note_id: u64, fade_secs: f32) -> Result<(), String> {
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    let secs = if !fade_secs.is_finite() || fade_secs <= 0.0 {
      0.08
    } else {
      fade_secs
    };
    let fade_frames = if sr == 0 {
      0
    } else {
      (secs * sr as f32).round().max(1.0).min(u32::MAX as f32) as u32
    };
    let cmd = MixerCommand::ReleaseNote { note_id, fade_frames };
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(cmd)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  // Live re-pitch of a tagged voice (see MixerCommand::RepitchNote). `ratio`
  // is the playback-rate multiplier (2^(semitones/12)). No-op if the device
  // is closed or the voice has already ended.
  pub fn repitch_note(&self, note_id: u64, ratio: f32) -> Result<(), String> {
    // ~20ms portamento glide so the re-pitch doesn't tick. Computed here (like
    // ReleaseNote's fade_frames) since the audio thread doesn't own the SR.
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    let glide_frames = if sr == 0 {
      0
    } else {
      (sr as f32 * 0.02).round().max(1.0).min(u32::MAX as f32) as u32
    };
    let cmd = MixerCommand::RepitchNote { note_id, ratio, glide_frames };
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(cmd)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }

  // Freeze in-flight voice DSP params (see MixerCommand::FreezeVoiceParams).
  // Called on every scene/bank/song swap.
  pub fn freeze_voice_params(&self) -> Result<(), String> {
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(MixerCommand::FreezeVoiceParams)
      .map_err(|_| "trigger queue full".to_string())?;
    Ok(())
  }
}

// Dropping (or replacing) the audio stream also drops the callback-local
// recorder producers — without signalling the recorder workers first, a
// recording in flight across a device Open/Close leaves its worker thread
// spinning forever on an unfinalized WAV (and the enabled flag stuck true,
// blocking any new take). Called at the top of Open and Close so an
// in-flight take cleanly finalizes with everything captured so far.
fn stop_recorders_for_stream_teardown() {
  if let Ok(mut g) = loop_bounce_teardown().lock() {
    if let Some(stop) = g.take() {
      stop.store(true, Ordering::Release);
    }
  }
  let r = recorder_state();
  if r.combined_enabled.swap(false, Ordering::AcqRel) {
    r.combined_stop.store(true, Ordering::Release);
  }
  if r.splits_enabled.swap(false, Ordering::AcqRel) {
    r.splits_stop.store(true, Ordering::Release);
  }
  if r.stems_enabled.swap(false, Ordering::AcqRel) {
    r.stems_stop.store(true, Ordering::Release);
  }
}

fn control_thread(rx: Receiver<EngineCommand>, state: Arc<SharedState>) {
  // _stream holds the cpal output stream for the duration of an open
  // device; cpal::Stream is !Send on macOS so its lifetime stays here.
  let mut _stream: Option<Stream> = None;
  while let Ok(cmd) = rx.recv() {
    match cmd {
      EngineCommand::Open {
        device_name,
        channels,
        sample_rate,
        buffer_size,
        reply,
      } => {
        // Drop any existing stream + producer before opening a new one.
        // A recording in flight finalizes first (worker signalled before
        // its producer dies with the stream). Explicit pause() before the
        // drop: on macOS a dropped cpal stream's callback has been
        // observed to keep running (2026-07-05, two live streams after a
        // double open) — stop the AudioUnit explicitly rather than
        // trusting Drop alone.
        stop_recorders_for_stream_teardown();
        if let Some(s) = _stream.take() {
          let _ = s.pause();
        }
        if let Ok(mut prod) = state.trigger_producer.lock() {
          *prod = None;
        }
        state.channels.store(0, Ordering::Release);
        state.sample_rate.store(0, Ordering::Release);
        state.test_tone_enabled.store(false, Ordering::Release);

        // Fresh trigger queue per open. Audio thread takes the consumer
        // side; producer goes into shared state for command pushes.
        let rb = HeapRb::<MixerCommand>::new(TRIGGER_QUEUE_CAPACITY);
        let (prod, cons) = rb.split();

        match build_stream(
          &device_name,
          channels,
          sample_rate,
          buffer_size,
          state.clone(),
          cons,
        ) {
          Ok((s, info)) => {
            if let Err(e) = s.play() {
              let _ = reply.send(Err(format!("stream play: {}", e)));
              continue;
            }
            state.channels.store(info.channels, Ordering::Release);
            state.sample_rate.store(info.sample_rate, Ordering::Release);
            if let Ok(mut guard) = state.trigger_producer.lock() {
              *guard = Some(prod);
            }
            _stream = Some(s);
            // Synthesize the count-in click samples at the freshly-
            // opened device sample rate so `triggerSample` plays them
            // at native pitch (no resampling artifacts). Registry
            // overwrites cleanly on subsequent device reopens.
            register_click_samples(info.sample_rate);
            let _ = reply.send(Ok(info));
          }
          Err(e) => {
            let _ = reply.send(Err(e));
          }
        }
      }
      EngineCommand::Close { reply } => {
        stop_recorders_for_stream_teardown();
        if let Some(s) = _stream.take() {
          let _ = s.pause();
        }
        if let Ok(mut prod) = state.trigger_producer.lock() {
          *prod = None;
        }
        state.channels.store(0, Ordering::Release);
        state.sample_rate.store(0, Ordering::Release);
        state.test_tone_enabled.store(false, Ordering::Release);
        let _ = reply.send(Ok(()));
      }
      EngineCommand::Shutdown => break,
    }
  }
}

// Monophonic-choke release window. ~20ms at any sample rate; matches
// the web path's STEAL_RELEASE (samplePlayer.ts).
const MONOPHONIC_CHOKE_MS: f32 = 20.0;

// FNV-1a (32-bit) — hashes manifest choke-group names to the u32 tag that
// rides the trigger command (see Voice::choke_group). Collision odds across
// a handful of group names per kit are negligible, and a collision merely
// over-chokes. Runs on the IPC command thread, never the audio callback.
fn fnv1a_32(bytes: &[u8]) -> u32 {
  let mut h: u32 = 0x811c_9dc5;
  for b in bytes {
    h ^= *b as u32;
    h = h.wrapping_mul(0x0100_0193);
  }
  h
}

// Loop-unit read helpers (P2). Linear interpolation is deliberate — the
// loop unit is a mangler, and interp artifacts at extreme vari-speed are
// character (same stance as the tape/grain reads).
#[inline]
fn loop_wrap(pos: f64, len: f64) -> f64 {
  let mut p = pos % len;
  if p < 0.0 {
    p += len;
  }
  p
}

#[inline]
fn loop_read(buf: &[f32], len: usize, pos: f64) -> f32 {
  let i0 = (pos as usize).min(len - 1);
  let frac = (pos - i0 as f64) as f32;
  let i1 = if i0 + 1 >= len { 0 } else { i0 + 1 };
  buf[i0] + (buf[i1] - buf[i0]) * frac
}

// Drops a PendingTrigger into a voice slot — picks an inactive slot,
// or steals one round-robin via steal_cursor if all are busy. Used by
// both the immediate-fire path (no target frame) and the
// sample-accurate dispatch path (target frame reached this block).
// When the trigger is flagged monophonic, all OTHER currently-active
// voices sharing the same `track_params` Arc get a soft ~20ms release
// ramp before this trigger claims its slot.
fn claim_voice_slot(
  voices: &mut [Voice],
  _steal_cursor: &mut usize,
  p: PendingTrigger,
  start_frame: usize,
  sample_rate_f: f32,
) {
  if p.monophonic {
    if let Some(track_arc) = p.track_params.as_ref() {
      let release_frames =
        (MONOPHONIC_CHOKE_MS * 0.001 * sample_rate_f).max(1.0) as u32;
      for v in voices.iter_mut() {
        if !v.active || v.release_remaining > 0 {
          continue;
        }
        let matches = v
          .track_params
          .as_ref()
          .map(|tp| Arc::ptr_eq(tp, track_arc))
          .unwrap_or(false);
        if matches {
          v.release_remaining = release_frames;
          v.release_total = release_frames;
        }
      }
    }
  }
  // Choke group — cross-track choke keyed by the manifest group tag
  // (closed hat chokes open hat on a different track). Same soft ~20ms
  // ramp as the monophonic choke; the web path hard-stops instead, but
  // an unfaded cut clicks on sustained samples, and the ramp is this
  // engine's established choke idiom.
  if p.choke_group != 0 {
    let release_frames =
      (MONOPHONIC_CHOKE_MS * 0.001 * sample_rate_f).max(1.0) as u32;
    for v in voices.iter_mut() {
      if v.active && v.release_remaining == 0 && v.choke_group == p.choke_group
      {
        v.release_remaining = release_frames;
        v.release_total = release_frames;
      }
    }
  }
  let slot = (0..VOICE_POOL_SIZE)
    .find(|i| !voices[*i].active)
    .unwrap_or_else(|| {
      // Pool exhausted → steal the OLDEST voice (most frames played, so most
      // likely decayed toward its tail). Cutting the quietest candidate makes
      // the smallest step, which the new voice's declick fade-in then masks.
      // Round-robin stealing cut arbitrary mid-transient voices, which popped
      // on dense 16th-note slice sequencing that overflowed the pool.
      let mut oldest = 0usize;
      let mut most = 0u32;
      for (i, v) in voices.iter().enumerate() {
        if v.frames_played >= most {
          most = v.frames_played;
          oldest = i;
        }
      }
      oldest
    });
  let v = &mut voices[slot];
  v.sample = Some(p.sample);
  v.choke_group = p.choke_group;
  // Sample window + loop. Backward readers (bwd loop = 2, rev one-shot = 4)
  // start at the window end and read toward the start; everything else starts
  // at the window start. play_dir is the per-frame read direction (multiplies
  // rate); pingpong flips it at the edges, backward readers hold -1,
  // forward/one-shot hold +1.
  v.play_start = p.play_start;
  v.play_end = p.play_end;
  v.loop_mode = p.loop_mode;
  let reads_backward = p.loop_mode == 2 || p.loop_mode == 4;
  v.play_dir = if reads_backward { -1.0 } else { 1.0 };
  v.position = if reads_backward { p.play_end } else { p.play_start };
  // Per-instrument filter: copy the prebuilt coefficients into both channels
  // and clear their delay lines so a reused slot doesn't carry stale state.
  v.inst_filter_on = p.inst_filter_on;
  v.inst_filter_l = p.inst_filter;
  v.inst_filter_r = p.inst_filter;
  v.inst_filter_l.reset_state();
  v.inst_filter_r.reset_state();
  // Cutoff LFO + base filter params for live recompute. Phase resets per note
  // (note-synced); rng seeded off the slot so different voices don't lock to
  // the same Random sequence.
  v.inst_filter_type = p.inst_filter_type;
  v.inst_cutoff_norm = p.inst_cutoff_norm;
  v.inst_q = p.inst_q;
  v.sat_drive = p.sat_drive;
  v.bit_depth = p.bit_depth;
  v.lfo_on = p.lfo_on;
  v.lfo_shape = p.lfo_shape;
  v.lfo_rate_hz = p.lfo_rate_hz;
  v.lfo_depth = p.lfo_depth;
  v.lfo_phase = 0.0;
  v.lfo_recompute_ctr = 0;
  v.lfo_rng = 0x9e37_79b9 ^ (slot as u32).wrapping_mul(2654435761);
  v.lfo_rand = lfo_rand_bipolar(&mut v.lfo_rng);
  v.rate = p.rate;
  v.rate_target = p.rate;
  v.rate_glide_inc = 0.0;
  v.rate_glide_remaining = 0;
  v.gain = p.gain;
  v.pan_left = p.pan_left;
  v.pan_base = p.pan_base;
  v.pan_right = p.pan_right;
  v.out_first = p.out_first;
  v.out_stereo = p.out_stereo;
  v.track_params = p.track_params;
  // Snapshot the track's stem-recording slot (0 when no stems recording is
  // armed) so the per-track dry tap reads a plain field, not an atomic.
  v.rec_track = v
    .track_params
    .as_ref()
    .map(|tp| tp.rec_track())
    .unwrap_or(0);
  v.filter.reset();
  v.start_frame = start_frame;
  v.active = true;
  v.release_remaining = 0;
  v.release_total = 0;
  v.section = p.section;
  v.is_texture = p.is_texture;
  v.frozen_params = None;
  v.frames_played = 0;
  v.note_id = p.note_id;
  if let Some(spec) = p.envelope {
    // Convert seconds → sample counts. attack/release/hold have a 1ms
    // floor so a zero-length phase doesn't divide by zero in the ramp.
    let attack_secs = spec.attack_secs.max(0.001);
    let release_secs = spec.release_secs.max(0.001);
    let decay_secs = spec.decay_secs.max(0.0);
    let hold_secs = spec.hold_secs.max(0.001);
    v.env_active = true;
    v.env_level = 0.0;
    v.env_elapsed = 0;
    v.env_attack_samples = (attack_secs * sample_rate_f).max(1.0) as u32;
    v.env_decay_samples = (decay_secs * sample_rate_f) as u32;
    v.env_hold_samples = (hold_secs * sample_rate_f).max(1.0) as u32;
    v.env_release_samples = (release_secs * sample_rate_f).max(1.0) as u32;
    v.env_sustain_level = spec.sustain_level.clamp(0.0, 1.0);
    v.env_release_start_level = -1.0;
  } else {
    v.env_active = false;
    v.env_level = 1.0; // flat-gain voices: multiplier stays at 1
    v.env_elapsed = 0;
    v.env_release_start_level = -1.0;
  }
  // Generic modulators: copy the prebuilt slot array. Mod envelopes release
  // on the same note hold as the amp env when there is one; otherwise they
  // sustain until the voice ends (u32::MAX).
  v.mods = p.mods;
  v.mod_hold_samples = if v.env_active { v.env_hold_samples } else { u32::MAX };
  // Granular: copy the params and reset the grain read-head to the start of a
  // fresh grain (forward for pingpong's first grain).
  v.gran_on = p.gran_on;
  v.gran_grain_frames = p.gran_grain_frames;
  v.gran_pos_norm = p.gran_pos_norm;
  v.gran_shape = p.gran_shape;
  v.gran_dir = p.gran_dir;
  v.gran_read = 0.0;
  v.gran_ping_fwd = true;
  // Seed the first grain's latched start at the base position (no automation
  // offset yet at note onset).
  let gran_fc = v.sample.as_ref().map(|s| s.frame_count()).unwrap_or(0) as f64;
  v.gran_base_latched = (p.gran_pos_norm.clamp(0.0, 1.0) as f64) * (gran_fc - 2.0).max(0.0);
  v.gran_spray = p.gran_spray;
  v.gran_rng = 0x1234_5678 ^ (slot as u32).wrapping_mul(0x9e37_79b9);
  // Wavetable: copy params and reset the in-window read phase to the start of
  // the first cycle.
  v.wt_on = p.wt_on;
  v.wt_window_frames = p.wt_window_frames;
  v.wt_pos_norm = p.wt_pos_norm;
  v.wt_morph = p.wt_morph;
  v.wt_hz = p.wt_hz;
  v.wt_phase = 0.0;
  v.wt_track_scan = f64::NAN; // seed from the first block's LFO value
  v.wt_wi_cur = -1.0; // stepped mode latches from the live scan on first frame
  v.wt_wi_next = -1.0;
  v.wt_smooth = p.wt_smooth;
}

fn build_stream(
  device_name: &str,
  channels: u32,
  sample_rate: u32,
  buffer_size: Option<u32>,
  state: Arc<SharedState>,
  mut consumer: HeapCons<MixerCommand>,
) -> Result<(Stream, OpenedInfo), String> {
  let host = cpal::default_host();
  let device = if device_name.is_empty() || device_name == "default" {
    host
      .default_output_device()
      .ok_or_else(|| "no default output device".to_string())?
  } else {
    host
      .output_devices()
      .map_err(|e| format!("enumerate: {}", e))?
      .find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
      .ok_or_else(|| format!("device not found: {}", device_name))?
  };

  let config = StreamConfig {
    channels: channels as cpal::ChannelCount,
    sample_rate: SampleRate(sample_rate),
    buffer_size: match buffer_size {
      Some(b) if b > 0 => BufferSize::Fixed(b),
      _ => BufferSize::Default,
    },
  };

  let actual_name = device.name().unwrap_or_else(|_| "unknown".to_string());

  // Claim the engine clock for this stream — see ENGINE_STREAM_GEN.
  let stream_gen = ENGINE_STREAM_GEN.fetch_add(1, Ordering::AcqRel) + 1;
  let mut logged_first_block = false;

  // Callback-local state — only the audio thread touches these.
  let mut phase: f32 = 0.0;
  let mut last_ch: usize = usize::MAX;
  let mut voices: Vec<Voice> = vec![Voice::default(); VOICE_POOL_SIZE];
  let mut steal_cursor: usize = 0;
  // Pending triggers — sample-accurate dispatch queue. Triggers with a
  // future deadline land here at drain time (absolute ENGINE_FRAMES
  // target); each block we scan and fire any whose target_frame falls
  // inside this block.
  //
  // Bounded at PENDING_TRIGGERS_CAP. Pre-allocated to that size so the
  // audio thread never reallocates; pushes past the cap drop with the
  // global `PENDING_TRIGGER_DROPS` counter incremented for diagnostics.
  // Cap chosen well above any realistic burst (dense 32nd-note patterns
  // × multiple sections at long lookahead).
  let mut pending_triggers: Vec<PendingTrigger> =
    Vec::with_capacity(PENDING_TRIGGERS_CAP);
  // Audio-thread-local recorder producers. None when idle; populated
  // by Start*Recording, cleared by Stop*Recording. Holding them in the
  // callback closure avoids any locking on the audio thread.
  let mut combined_rec_producer: Option<HeapProd<f32>> = None;
  let mut rhythm_rec_producer: Option<HeapProd<f32>> = None;
  let mut melody_rec_producer: Option<HeapProd<f32>> = None;
  // Full-stems recording producers. master = post-master buf (like combined);
  // fx = mangler bus (pre reverb/delay fold); reverb/delay = the wet returns;
  // stems[i] = per-track dry (dry_scale applied — sums with the buses to the
  // master). All None when no stems take is armed.
  let mut master_rec_producer: Option<HeapProd<f32>> = None;
  let mut fx_rec_producer: Option<HeapProd<f32>> = None;
  let mut reverb_rec_producer: Option<HeapProd<f32>> = None;
  let mut delay_rec_producer: Option<HeapProd<f32>> = None;
  let mut stem_rec_producers: [Option<HeapProd<f32>>; MAX_STEMS] =
    std::array::from_fn(|_| None);
  // Absolute ENGINE_FRAMES at which the current take should begin capturing,
  // so WAV frame 0 lands on the first musical downbeat (no leading dead-space).
  // Set by the Start*Recording commands; 0 = capture immediately.
  let mut rec_start_frame: u64 = 0;
  // Per-track dry scratch (accumulated in the voice loop). fx_stem is a
  // snapshot of the mangler bus taken before reverb/delay fold in (overwritten
  // via copy, so no per-block clear). Allocated once here, never on the hot
  // path.
  let mut stem_l: Vec<Vec<f32>> =
    (0..MAX_STEMS).map(|_| vec![0.0; REVERB_SCRATCH]).collect();
  let mut stem_r: Vec<Vec<f32>> =
    (0..MAX_STEMS).map(|_| vec![0.0; REVERB_SCRATCH]).collect();
  let mut fx_stem_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut fx_stem_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  // Section scratch buffers (stereo interleaved? no — separate L/R for
  // matching the bus accumulation pattern of fxbus_l/r). Sized at
  // REVERB_SCRATCH for the same chunked-large-block reasoning.
  let mut rhythm_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut rhythm_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut melody_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut melody_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  // Loop/resample capture unit (P1): a pre-master ring the callback always
  // writes (indexed by absolute frame — a capture span is a modular slice),
  // plus the loop buffer it plays back from. Allocated once here; the
  // capture copy is a ≤2-segment memcpy (~ms worst case for a full-ring
  // span), nothing on the hot path resizes. State is callback-local, so a
  // stream reopen (device change) drops any held loop — accepted for P1.
  let loop_ring_frames = (sample_rate as usize) * LOOP_RING_SECONDS;
  let mut loop_ring_l: Vec<f32> = vec![0.0; loop_ring_frames];
  let mut loop_ring_r: Vec<f32> = vec![0.0; loop_ring_frames];
  let mut loop_buf_l: Vec<f32> = vec![0.0; loop_ring_frames];
  let mut loop_buf_r: Vec<f32> = vec![0.0; loop_ring_frames];
  let mut loop_len: usize = 0;
  let mut loop_anchor: u64 = 0;
  let mut loop_gain: f32 = 0.8;
  let mut loop_active = false;
  // P2 manipulation state (Morphagene/ADDAC flavor). The playhead is a
  // fractional position integrated at `speed` per frame — at exactly 1.0
  // it reproduces P1's bar-locked phase; anywhere else the unit detaches
  // from the grid and becomes an instrument. Grain slots are fixed (4),
  // spawned on a countdown, each a windowed read whose rate carries the
  // vari-speed pitch (thru-zero: negative = reverse grains).
  let mut loop_pos: f64 = 0.0;
  let mut loop_speed: f32 = 1.0;
  let mut loop_size: f32 = 1.0; // 1.0 = whole-loop tape mode
  let mut loop_random: f32 = 0.0;
  let mut loop_pitch: f32 = 0.0; // 0 = follow speed
  let mut loop_tape_level: f32 = 1.0; // tape-layer return level
  let mut loop_grain_level: f32 = 0.0; // grain-layer return level
  let mut loop_lock: bool = false; // pitch-locked (OLA) tape layer
  // OLA stretcher heads for the locked tape layer: (position, phase).
  // phase < 0 = idle. Two heads at 50% hop, triangular windows (sum = 1).
  let mut loop_ola: [(f64, f64); 2] = [(0.0, -1.0), (0.0, -1.0)];
  let mut loop_ola_next: usize = 0;
  let mut loop_ola_countdown: f64 = 0.0;
  let mut loop_size_dev: f32 = 0.0;
  let mut loop_pitch_dev: f32 = 0.0;
  let mut loop_rate_dev: f32 = 0.0;
  let mut loop_grain_count: usize = 4;
  let mut loop_spawn_frames: f32 = 6000.0;
  let mut loop_rate_synced: bool = false;
  // Absolute engine frame of the next grain spawn (f64 — carries jitter).
  let mut loop_next_spawn: f64 = 0.0;
  #[derive(Clone, Copy, Default)]
  struct LoopGrain {
    active: bool,
    start: f64,  // loop-buffer position at spawn (frames)
    phase: f64,  // frames elapsed within the grain (0..dur)
    dur: f64,    // grain length in frames
    rate: f64,   // signed read rate (vari-speed pitch)
  }
  let mut loop_grains: [LoopGrain; LOOP_GRAIN_SLOTS] =
    [LoopGrain::default(); LOOP_GRAIN_SLOTS];
  // In-flight loop bounce: (producer, remaining, total, align, stop flag).
  let mut loop_bounce: Option<(HeapProd<f32>, u64, u64, u64, Arc<AtomicBool>)> =
    None;
  let mut loop_bounce_started = false;
  // NOISE unit (Mörser-shaped). Own capture buffer off the shared ring; a
  // plain vari-speed head (no grains — that's the LOOP unit's vocabulary).
  let mut noise_buf_l: Vec<f32> = vec![0.0; loop_ring_frames];
  let mut noise_buf_r: Vec<f32> = vec![0.0; loop_ring_frames];
  let mut noise_len: usize = 0;
  let mut noise_anchor: u64 = 0;
  let mut noise_capture_active = false;
  let mut noise_pos: f64 = 0.0;
  let mut noise_speed: f32 = 1.0;
  let mut noise_drive: f32 = 0.25;
  let mut noise_cutoff: f32 = 0.6;
  let mut noise_res: f32 = 0.4;
  let mut noise_width: f32 = 0.0;
  let mut noise_mode: u8 = 0;
  let mut noise_amt: f32 = 0.3;
  let mut noise_cv: f32 = 0.2;
  let mut noise_clock_frames: f32 = 6000.0;
  let mut noise_clock_synced: bool = false;
  let mut noise_level: f32 = 0.0; // unit silent until raised
  // Clock + sample&hold state: held cutoff jitter, absolute next-tick
  // frame, SVF states per channel, current filter coefficient
  // (recomputed on clock ticks / param pushes).
  let mut noise_source: u8 = 0; // 0 INS · 1 PAR · 2 CAP (own capture) · 3 OFF
  let mut noise_clock_mode: u8 = 0; // 0 timer (sync/free) · 1 signal
  let mut noise_clock_src: u8 = 0; // 0 self-input · 1 loop A · 2 mix
  let mut noise_clock_div: u32 = 8;
  let mut noise_sens: f32 = 0.2;
  // Signal-clock detector: hysteresis sign state (+1/-1/0 unarmed) and
  // the crossing divider counter.
  let mut noise_xing_sign: i8 = 0;
  let mut noise_xing_count: u32 = 0;
  let mut noise_next_clock: f64 = 0.0;
  // Edge-ping state: the noise hits the filter as TRANSITIONS, not held
  // levels — each bit flip fires a short decaying pulse that pings the
  // resonance (the Mörser morse-code mechanic). Runs of unchanged bits =
  // silence gaps; the cv step retunes each ping.
  let mut noise_bit_l: bool = false;
  let mut noise_bit_r: bool = false;
  let mut noise_ping_l: f32 = 0.0;
  let mut noise_ping_r: f32 = 0.0;
  let mut noise_jit: f32 = 0.0; // held cutoff jitter, bipolar
  let mut noise_rng: u32 = 0x51f0_beef;
  let mut noise_svf: [(f32, f32); 2] = [(0.0, 0.0); 2]; // (lp, bp) per ch
  // DC blocker per channel (x1, y1) — the asymmetric in-loop clipper
  // generates DC, which would otherwise latch the lp integrator under
  // drive and pin the unit silent (the "level turns off the output" bug).
  let mut noise_dcb: [(f32, f32); 2] = [(0.0, 0.0); 2];
  // Scope decimator accumulators (min/max over NOISE_SCOPE_DECIM frames).
  let mut noise_scope_min: f32 = 0.0;
  let mut noise_scope_max: f32 = 0.0;
  let mut noise_scope_n: u32 = 0;
  // Block scratch carrying the loop unit's output into the noise unit
  // (insert routing) and onward to the bounce tap — the bounce always
  // prints the FINAL signal (post-noise when inserted).
  let mut loop_send_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut loop_send_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  // Unit → FX-bus sends, ONE BLOCK DEFERRED: the units run downstream of
  // the FX section (pre-master, where the capture ring lives), so their
  // sends accumulate here and enter the mangler/reverb/delay inputs at the
  // TOP of the next block (~block of latency — inaudible on send material).
  // Consequence, deliberate: unit FX tails re-enter the pre-master mix and
  // therefore future captures — generational resampling through the buses.
  let mut units_fx_carry_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut units_fx_carry_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut units_rev_carry_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut units_rev_carry_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut units_del_carry_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut units_del_carry_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut loop_fx_send: f32 = 0.0;
  let mut loop_rev_send: f32 = 0.0;
  let mut loop_del_send: f32 = 0.0;
  let mut noise_fx_send: f32 = 0.0;
  let mut noise_rev_send: f32 = 0.0;
  let mut noise_del_send: f32 = 0.0;
  // Cheap grain-spray randomness (xorshift) — never allocates.
  let mut loop_rng: u32 = 0x9e37_79b9;
  let nominal_channels = channels as usize;
  let nominal_sr = sample_rate as f32;
  let device_sr_f64 = sample_rate as f64;
  // Reverb bus + scratch buffers. 8192 frames is well above the typical
  // cpal block size (256–2048); chunked processing kicks in if the
  // device ever calls back with a larger buffer.
  const REVERB_SCRATCH: usize = 8192;
  let mut reverb_bus = ReverbBus::new(sample_rate);
  let mut delay_bus = DelayBus::new(sample_rate);
  // Mangler FX bus (fed by fx_send: tape → glitch → drive). Reverb left this
  // bus — it's now a parallel aux fed by its own per-instrument send buffer.
  let mut fxbus_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut fxbus_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  // Reverb send bus (fed additively by per-instrument reverb_send) → reverb.
  let mut rev_send_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut rev_send_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut reverb_out_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut reverb_out_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  // Delay send bus (fed additively by per-instrument delay_send) → ping-pong delay.
  let mut delay_send_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut delay_send_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut delay_out_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut delay_out_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut tape_buffer = TapeBuffer::new(sample_rate);
  let mut glitch_machine = GlitchMachine::new(sample_rate);
  let mut master_stage = MasterStage::new(sample_rate);
  // Audio-thread-safe RNG (seeded once at stream construction, then
  // never touches the OS again). Used for per-trigger ±3-cent detune
  // jitter so stacked voices don't lock in tune and phase out. Mirrors
  // src/audio/samplePlayer.ts:460 web-side; applied to every trigger
  // because the IPC doesn't carry chord-vs-single context and ±3 cents
  // is below the JND for single notes anyway.
  let rng_seed = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos() as u64)
    .unwrap_or(0xCAFE_BABE_DEAD_BEEF);
  let mut rng = SmallRng::seed_from_u64(rng_seed);
  // Phase 6: per-LFO phase state, closure-local so each open-stream
  // session restarts phases at 0. Advanced once per audio block from
  // the snapshot's rate array. Wraps at 2π so f64 precision stays
  // stable over long sessions (years of phase accumulation).
  let mut lfo_phases: [f64; LFO_COUNT] = [0.0; LFO_COUNT];

  // Engine clock restarts at 0 for every stream open — absolute frame
  // targets only make sense against the stream they were scheduled on.
  // JS re-seeds its extrapolator when it sees the counter jump backward.
  ENGINE_FRAMES.store(0, Ordering::Release);

  let cb_state = state.clone();
  let stream = device
    .build_output_stream(
      &config,
      move |buf: &mut [f32], _info: &cpal::OutputCallbackInfo| {
        // Start every block with silence; all sources are additive.
        for s in buf.iter_mut() {
          *s = 0.0;
        }

        let n_ch = {
          let v = cb_state.channels.load(Ordering::Acquire) as usize;
          if v == 0 {
            nominal_channels.max(1)
          } else {
            v
          }
        };
        let sr_f32 = {
          let v = cb_state.sample_rate.load(Ordering::Acquire) as f32;
          if v == 0.0 {
            nominal_sr
          } else {
            v
          }
        };

        // Engine-clock block window. ENGINE_FRAMES holds the absolute
        // frame index of this block's first sample for the whole
        // callback (it advances at the end); absolute-target dispatch
        // below compares against [block_start_frame, block_end_frame).
        let is_current_stream =
          ENGINE_STREAM_GEN.load(Ordering::Relaxed) == stream_gen;
        let block_start_frame = ENGINE_FRAMES.load(Ordering::Relaxed);
        let block_frames_total = (buf.len() / n_ch.max(1)) as u64;
        let block_end_frame = block_start_frame + block_frames_total;
        // One line per stream lifetime — this is what surfaces a zombie
        // stream (a gen that isn't current, or more gens than opens).
        if !logged_first_block {
          logged_first_block = true;
          log::info!(
            "[engine-clock] stream gen {} first block: buf.len={} n_ch={} frames={} current={}",
            stream_gen,
            buf.len(),
            n_ch,
            block_frames_total,
            is_current_stream
          );
        }

        // 0) Phase 6 — advance LFO phases and write modulated values to
        // each routed destination's `_eff` atomic. Reads the current
        // snapshot wait-free via ArcSwap::load (no Mutex, no Arc::clone
        // on the audio thread); iterates groups (already pre-resolved
        // to TrackParams handles where applicable) and applies
        // `apply_lfo` to base. With no LFOs routed the `groups` Vec is
        // empty and this is just an atomic load + a phase update.
        {
          let frames_in_block = buf.len() / n_ch.max(1);
          let dt = (frames_in_block as f64) / (sr_f32 as f64).max(1.0);
          let snap = lfo_snapshot_cell().load();
          // Advance all phases first so the loop below reads coherent
          // outputs even when multiple LFOs share a destination.
          let two_pi = std::f64::consts::TAU;
          let mut outputs = [0.0_f32; LFO_COUNT];
          for i in 0..LFO_COUNT {
            let rate = snap.rate[i] as f64;
            if rate > 0.0 {
              lfo_phases[i] += two_pi * rate * dt;
              if lfo_phases[i] >= two_pi {
                lfo_phases[i] %= two_pi;
              }
            }
            outputs[i] = lfo_phases[i].sin() as f32;
          }
          for group in &snap.groups {
            // Sum contributions weighted by depth, matching the JS
            // `modulated()` reducer: out = Σ(sin·depth) / Σ(depth).
            let mut summed = 0.0_f32;
            let mut total_depth = 0.0_f32;
            for &lfo_id in &group.contributors {
              let d = snap.depth[lfo_id as usize];
              summed += outputs[lfo_id as usize] * d;
              total_depth += d;
            }
            if total_depth <= 0.0 {
              continue;
            }
            let out = summed / total_depth;
            match group.kind {
              LfoDestKind::TrackFilterCutoff => {
                if let Some(tp) = group.track_params.as_ref() {
                  let base = tp.cutoff_norm_base();
                  tp.write_cutoff_norm_eff(apply_lfo(base, total_depth, out));
                }
              }
              LfoDestKind::TrackFilterResonance => {
                if let Some(tp) = group.track_params.as_ref() {
                  let base = tp.resonance_base();
                  tp.write_resonance_eff(apply_lfo(base, total_depth, out));
                }
              }
              LfoDestKind::TrackFxSend => {
                if let Some(tp) = group.track_params.as_ref() {
                  let base = tp.fx_send_base();
                  tp.write_fx_send_eff(apply_lfo(base, total_depth, out));
                }
              }
              LfoDestKind::TrackReverbSend => {
                if let Some(tp) = group.track_params.as_ref() {
                  let base = tp.reverb_send_base();
                  tp.write_reverb_send_eff(apply_lfo(base, total_depth, out));
                }
              }
              LfoDestKind::TrackDelaySend => {
                if let Some(tp) = group.track_params.as_ref() {
                  let base = tp.delay_send_base();
                  tp.write_delay_send_eff(apply_lfo(base, total_depth, out));
                }
              }
              // Tuning dests write the DEVIATION in semitones (apply_lfo result
              // minus the static base), since the static tune is already in the
              // voice rate. Coarse spans ±24 st (norm×48), fine ±1 st (norm×2).
              LfoDestKind::TrackTune => {
                if let Some(tp) = group.track_params.as_ref() {
                  let base = tp.tune_base_norm();
                  let modded = apply_lfo(base, total_depth, out);
                  tp.write_tune_mod_semis((modded - base) * 48.0);
                }
              }
              LfoDestKind::TrackFineTune => {
                if let Some(tp) = group.track_params.as_ref() {
                  let base = tp.finetune_base_norm();
                  let modded = apply_lfo(base, total_depth, out);
                  tp.write_finetune_mod_semis((modded - base) * 2.0);
                }
              }
              // Wavetable scan: a bipolar deviation around 0 (added to the
              // voice's scan every frame). Swings around a 0.5 center. The raw
              // swing (∝ depth) maps onto a big chunk of the table, so a little
              // depth already crossed many windows — scale the swing by
              // total_depth again (→ ∝ depth²) so low depths are gentle while
              // full depth still reaches ±half the table (a full-table sweep).
              LfoDestKind::TrackWtPosition => {
                if let Some(tp) = group.track_params.as_ref() {
                  let modded = apply_lfo(0.5, total_depth, out);
                  tp.write_wt_pos_mod((modded - 0.5) * total_depth);
                }
              }
              LfoDestKind::ReverbSize => {
                let r = reverb_state();
                r.write_size_eff(apply_lfo(r.size_base(), total_depth, out));
              }
              LfoDestKind::ReverbMix => {
                let r = reverb_state();
                r.write_wet_gain_eff(apply_lfo(
                  r.wet_gain_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::ReverbDiffusion => {
                let r = reverb_state();
                r.write_diffusion_eff(apply_lfo(
                  r.diffusion_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::ReverbDamping => {
                let r = reverb_state();
                r.write_damping_eff(apply_lfo(
                  r.damping_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::PreSaturationDrive => {
                let s = saturation_state();
                s.write_pre_drive_eff(apply_lfo(
                  s.pre_drive_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::GlitchMix => {
                let g = glitch_state();
                g.write_mix_eff(apply_lfo(g.mix_base(), total_depth, out));
              }
              LfoDestKind::TapePosition => {
                let t = tape_state();
                t.write_position_eff(apply_lfo(
                  t.position_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::TapeLength => {
                let t = tape_state();
                t.write_length_eff(apply_lfo(
                  t.length_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::TapeMix => {
                let t = tape_state();
                t.write_mix_eff(apply_lfo(t.mix_base(), total_depth, out));
              }
              LfoDestKind::TapeGrainRate => {
                let t = tape_state();
                t.write_grain_rate_eff(apply_lfo(
                  t.grain_rate_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::TapeGrainMix => {
                let t = tape_state();
                t.write_grain_mix_eff(apply_lfo(
                  t.grain_mix_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::MasterInput => {
                let m = master_state();
                m.write_input_eff(apply_lfo(m.input_base(), total_depth, out));
              }
              LfoDestKind::MasterHiCut => {
                let m = master_state();
                m.write_hi_cut_eff(apply_lfo(m.hi_cut_base(), total_depth, out));
              }
              LfoDestKind::MasterTrim => {
                let m = master_state();
                m.write_trim_eff(apply_lfo(m.trim_base(), total_depth, out));
              }
              LfoDestKind::MasterComp => {
                let m = master_state();
                m.write_comp_amount_eff(apply_lfo(
                  m.comp_amount_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::MasterDrive => {
                let m = master_state();
                m.write_dist_drive_eff(apply_lfo(
                  m.dist_drive_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::MasterBias => {
                // Bias is stored in its natural 0..0.2 range; LFO depth
                // is in 0..1 normalized space. Normalize before
                // `apply_lfo`, scale back after — matches the web
                // `bias/0.2 → modulate → ×0.2` pattern.
                let m = master_state();
                let norm_base = m.dist_bias_base() / 0.2;
                let modded = apply_lfo(norm_base, total_depth, out) * 0.2;
                m.write_dist_bias_eff(modded);
              }
              LfoDestKind::MasterMix => {
                let m = master_state();
                m.write_dist_mix_eff(apply_lfo(
                  m.dist_mix_base(),
                  total_depth,
                  out,
                ));
              }
              LfoDestKind::MasterGateThreshold => {
                let m = master_state();
                m.write_gate_threshold_eff(apply_lfo(
                  m.gate_threshold_base(),
                  total_depth,
                  out,
                ));
              }
            }
          }
        }

        // 1) Drain the trigger queue. Immediate triggers (no absolute
        // target, no delay) claim a voice slot at start_frame=0.
        // Everything else resolves to an absolute ENGINE_FRAMES target
        // (target_frame as-is, or block start + delay_samples for the
        // relative fallback) and queues in pending_triggers for
        // sample-accurate dispatch in step 1.5.
        while let Some(cmd) = consumer.try_pop() {
          match cmd {
            MixerCommand::Trigger {
              sample,
              gain,
              pan,
              pitch,
              out_first,
              out_stereo,
              track_params,
              monophonic,
              choke_group,
              section,
              is_texture,
              envelope,
              target_frame,
              delay_samples,
              note_id,
              start_frac,
              end_frac,
              loop_mode,
              inst_filter_type,
              inst_cutoff,
              inst_resonance,
              sat_drive,
              bit_depth,
              lfo_shape,
              lfo_rate_hz,
              lfo_depth,
              mods,
              gran_on,
              gran_grain_ms,
              gran_position,
              gran_shape,
              gran_dir,
              gran_spray,
              wt_on,
              wt_window_frames,
              wt_pos_norm,
              wt_morph,
              wt_hz,
              wt_smooth,
            } => {
              let pan_clamped = pan.clamp(-1.0, 1.0);
              let angle =
                (pan_clamped + 1.0) * 0.5 * std::f32::consts::FRAC_PI_2;
              let pan_left = angle.cos();
              let pan_right = angle.sin();
              let base_rate = sample.sample_rate as f64 / device_sr_f64;
              let cents_jitter: f64 = rng.gen_range(-3.0..3.0);
              let jitter_mul = 2.0_f64.powf(cents_jitter / 1200.0);
              let rate = base_rate * (pitch.max(0.001) as f64) * jitter_mul;
              // Resolve the 0..1 window fractions to frame positions. Clamp
              // so the interpolator stays in bounds (it reads i0+1) and so
              // start < end with at least a 1-frame span.
              // Clamp the window so the read head — including a backward
              // loop that *starts* at play_end — never trips the
              // interpolator's `i0 + 1 >= frame_count` bound (it reads
              // i0+1 and i0+2). Hence play_end <= fc - 2.
              let fc = sample.frame_count() as f64;
              let last = (fc - 2.0).max(0.0);
              let mut play_start =
                (start_frac.clamp(0.0, 1.0) as f64 * fc).clamp(0.0, last);
              let mut play_end = (end_frac.clamp(0.0, 1.0) as f64 * fc)
                .clamp(play_start + 1.0, last.max(play_start + 1.0));
              // Zero-crossing snap of INTERIOR slice/trim cuts (not the sample's
              // true start/end) so one-shot boundaries land on zero and don't
              // pop. Slice mode chops a break into mid-waveform windows, so this
              // is where the clicks come from; ~2ms search window. Full-length
              // playback (start 0 / end 1) is left alone so a kick keeps its
              // attack. Pairs with the existing declick fade further down.
              let zc_window = ((sample.sample_rate as f64) * 0.002) as usize;
              if start_frac > 0.0001 {
                play_start = snap_zero_crossing_back(sample.as_ref(), play_start, zc_window)
                  .clamp(0.0, last);
              }
              if end_frac < 0.9999 {
                play_end = snap_zero_crossing_back(sample.as_ref(), play_end, zc_window)
                  .clamp(play_start + 1.0, last.max(play_start + 1.0));
              }
              // Per-instrument filter — build the biquad once here so the
              // audio thread just copies coefficients into the voice.
              let inst_filter_on = inst_filter_type >= 1 && inst_filter_type <= 3;
              let inst_q = resonance_norm_to_q(inst_resonance);
              let mut inst_filter = Biquad::new_unity();
              if inst_filter_on {
                let fc_hz = cutoff_norm_to_hz(inst_cutoff);
                match inst_filter_type {
                  1 => inst_filter.set_lowpass(sr_f32, fc_hz, inst_q),
                  2 => inst_filter.set_highpass(sr_f32, fc_hz, inst_q),
                  _ => inst_filter.set_bandpass(sr_f32, fc_hz, inst_q),
                }
              }
              // Cutoff LFO only runs when the filter is on and depth/rate are
              // meaningful — otherwise there's nothing to modulate.
              let lfo_on =
                inst_filter_on && lfo_depth > 0.0001 && lfo_rate_hz > 0.0001;
              // Granular: resolve grain length (ms → source frames at the
              // device rate) and clamp to [2, sample length]. Position 0..1.
              let gran_grain_frames = ((gran_grain_ms.max(1.0) as f64) * 0.001
                * device_sr_f64)
                .clamp(2.0, (fc - 2.0).max(2.0));
              // Wavetable: clamp the window to [2, sample length] frames. A
              // window larger than the sample yields a single-window table (one
              // fixed cycle), which is fine. Device rate is irrelevant here — the
              // window is a frame count, and pitch comes from wt_hz.
              let wt_window_frames =
                (wt_window_frames.max(2.0) as f64).min((fc - 2.0).max(2.0));
              // Resolve the firing deadline to an absolute engine frame.
              // 0 = immediate (claim below); relative delays anchor to
              // THIS block's start so they keep their old semantics.
              let resolved_target = if target_frame > 0 {
                target_frame
              } else if delay_samples > 0 {
                block_start_frame + delay_samples as u64
              } else {
                0
              };
              let pending = PendingTrigger {
                sample,
                rate,
                gain,
                pan_left,
                pan_right,
                pan_base: pan_clamped,
                out_first: out_first as usize,
                out_stereo,
                track_params,
                monophonic,
                choke_group,
                section,
                is_texture,
                envelope,
                target_frame: resolved_target,
                note_id,
                play_start,
                play_end,
                loop_mode,
                inst_filter_on,
                inst_filter,
                inst_filter_type,
                inst_cutoff_norm: inst_cutoff,
                inst_q,
                sat_drive: sat_drive.clamp(0.0, 1.0),
                // Floor 1, not 4: the low end is where the destruction
                // lives (2 bits = five levels, 1 bit = full square) — the
                // perform bits punch and the instrument editor's bits
                // ladder both use it (2026-07-07). .pti export clamps back
                // to the Tracker hardware's 4.
                bit_depth: bit_depth.clamp(1, 16),
                lfo_on,
                lfo_shape,
                lfo_rate_hz,
                lfo_depth,
                mods,
                gran_on,
                gran_grain_frames,
                gran_pos_norm: gran_position.clamp(0.0, 1.0),
                gran_shape,
                gran_dir,
                gran_spray: gran_spray.clamp(0.0, 1.0),
                wt_on,
                wt_window_frames,
                wt_pos_norm: wt_pos_norm.clamp(0.0, 1.0),
                wt_morph,
                wt_hz: wt_hz.max(0.0),
                wt_smooth,
              };
              if pending.target_frame == 0 {
                claim_voice_slot(
                  &mut voices,
                  &mut steal_cursor,
                  pending,
                  0,
                  sr_f32,
                );
              } else if pending_triggers.len() < PENDING_TRIGGERS_CAP {
                pending_triggers.push(pending);
              } else {
                // Queue full — drop and bump the diagnostic counter.
                // The push is the only realloc risk on the audio
                // thread; the guard keeps us in pre-allocated space.
                PENDING_TRIGGER_DROPS.fetch_add(1, Ordering::Relaxed);
              }
            }
            MixerCommand::StopAll => {
              // Ramp voices out over ~7ms instead of a hard cut. An instant
              // active=false steps the output to zero mid-waveform and clicks
              // (the pop on transport Stop). The release machinery fades each
              // voice and self-deactivates + cleans up when it reaches zero
              // (see the per-frame release counter). Voices already releasing
              // keep their ramp. pending_triggers still clears immediately so
              // nothing new fires after Stop.
              let fade_frames = (sr_f32 * 0.007).max(1.0) as u32;
              for v in voices.iter_mut() {
                if v.active && v.release_remaining == 0 {
                  v.release_remaining = fade_frames;
                  v.release_total = fade_frames;
                }
              }
              pending_triggers.clear();
            }
            MixerCommand::Panic => {
              for v in voices.iter_mut() {
                v.active = false;
                v.sample = None;
                v.track_params = None;
                v.filter.reset();
                v.start_frame = 0;
                v.release_remaining = 0;
                v.release_total = 0;
                v.is_texture = false;
              }
              pending_triggers.clear();
              // Kill the FX tails too — StopAll only stops sources; a self-
              // oscillating reverb/delay keeps ringing without these clears.
              reverb_bus.clear();
              delay_bus.clear();
              // And flush the master chain's running state — a runaway that
              // reached inf/NaN upstream latches in the master biquads and
              // detector envelopes, leaving the output dead even after the
              // FX buses are cleared. Coefficients are untouched.
              master_stage.reset_state();
              // Panic also drops a held resample loop — it's a sounding
              // source like any other.
              loop_active = false;
              loop_len = 0;
              if let Some((_, _, _, _, stop)) = loop_bounce.take() {
                stop.store(true, Ordering::Release);
                loop_bounce_started = false;
              }
              noise_capture_active = false;
              noise_len = 0;
              // Panic silences the NOISE unit outright — a self-sounding
              // filter is a runaway source like any FX tail.
              noise_level = 0.0;
              noise_svf = [(0.0, 0.0); 2];
              noise_dcb = [(0.0, 0.0); 2];
              LOOP_VIZ_POS.store((-1.0f32).to_bits(), Ordering::Relaxed);
              LOOP_VIZ_BOUNCE.store((-1.0f32).to_bits(), Ordering::Relaxed);
            }
            MixerCommand::ReleaseNote { note_id, fade_frames } => {
              if note_id != 0 && fade_frames > 0 {
                for v in voices.iter_mut() {
                  // Match the tagged voice only. Skip one already in
                  // release (a re-issued note-off, or a monophonic choke
                  // that beat us to it) so we never re-lengthen its ramp.
                  if !v.active || v.note_id != note_id || v.release_remaining > 0 {
                    continue;
                  }
                  v.release_remaining = fade_frames;
                  v.release_total = fade_frames;
                }
              }
            }
            MixerCommand::RepitchNote { note_id, ratio, glide_frames } => {
              if note_id != 0 && ratio.is_finite() && ratio > 0.0 {
                for v in voices.iter_mut() {
                  // Match the tagged voice only; skip frozen tails (belong to
                  // an outgoing scene) and voices already releasing.
                  if !v.active
                    || v.note_id != note_id
                    || v.release_remaining > 0
                    || v.frozen_params.is_some()
                  {
                    continue;
                  }
                  // Base the new target on the IN-FLIGHT target (not the
                  // mid-glide rate) so chained re-pitches compose correctly —
                  // the JS side tracks tone pitch target-to-target, so each
                  // ratio is relative to the last target, not wherever the
                  // glide currently sits.
                  let base = if v.rate_glide_remaining > 0 { v.rate_target } else { v.rate };
                  let target = base * ratio as f64;
                  if glide_frames == 0 {
                    v.rate = target;
                    v.rate_target = target;
                    v.rate_glide_remaining = 0;
                    v.rate_glide_inc = 0.0;
                  } else {
                    v.rate_target = target;
                    v.rate_glide_remaining = glide_frames;
                    v.rate_glide_inc = (target - v.rate) / glide_frames as f64;
                  }
                }
              }
            }
            MixerCommand::FreezeVoiceParams => {
              for v in voices.iter_mut() {
                if !v.active || v.frozen_params.is_some() {
                  continue;
                }
                // Snapshot the live values the voice is currently reading.
                // No track_params (manual panel trigger) → nothing to
                // freeze; it doesn't read filter/fx_send anyway.
                if let Some(tp) = v.track_params.as_ref() {
                  v.frozen_params = Some((
                    tp.cutoff(),
                    tp.resonance(),
                    tp.fx_send(),
                    tp.reverb_send(),
                    tp.delay_send(),
                  ));
                }
              }
            }
            MixerCommand::LoopCapture { start_frame, end_frame } => {
              // Copy the requested span out of the pre-master ring.
              // ENGINE_FRAMES here = this block's start = exactly how far
              // the ring has been written, so end_frame <= now guarantees
              // the whole span exists; the oldest check guards wrap-around
              // overwrite. The JS side quantizes to rendered bar
              // boundaries, so rejects only happen on clock skew or spans
              // longer than the ring — both silently ignored.
              let now = ENGINE_FRAMES.load(Ordering::Relaxed);
              let len = end_frame.saturating_sub(start_frame) as usize;
              let ring_len = loop_ring_l.len();
              let oldest = now.saturating_sub(ring_len as u64);
              if len > 0
                && len <= ring_len
                && start_frame >= oldest
                && end_frame <= now
              {
                let s0 = (start_frame % ring_len as u64) as usize;
                let first = (ring_len - s0).min(len);
                loop_buf_l[..first].copy_from_slice(&loop_ring_l[s0..s0 + first]);
                loop_buf_r[..first].copy_from_slice(&loop_ring_r[s0..s0 + first]);
                if first < len {
                  let rest = len - first;
                  loop_buf_l[first..len].copy_from_slice(&loop_ring_l[..rest]);
                  loop_buf_r[first..len].copy_from_slice(&loop_ring_r[..rest]);
                }
                loop_len = len;
                loop_anchor = end_frame;
                loop_active = true;
                // Fresh capture: playhead re-anchors to the capture end so
                // speed=1 playback stays bar-phase-locked (P1 semantics).
                // Params are STICKY across captures — a performance stance:
                // recapturing under a mangled setting keeps the mangle.
                loop_pos = 0.0;
                for g in loop_grains.iter_mut() {
                  g.active = false;
                }
                loop_next_spawn = 0.0; // spawn immediately, on-grid
                // Viz peaks — subsampled min/max per column (≤64 reads
                // each; a picture, not a measurement). Version bump tells
                // JS to re-fetch.
                let per = (len as f64) / (LOOP_PEAK_COLS as f64);
                for col in 0..LOOP_PEAK_COLS {
                  let i0 = (col as f64 * per) as usize;
                  let i1 =
                    ((((col + 1) as f64) * per) as usize).min(len).max(i0 + 1);
                  let step = ((i1 - i0) / 64).max(1);
                  let mut mn = f32::MAX;
                  let mut mx = f32::MIN;
                  let mut i = i0;
                  while i < i1 {
                    let s = 0.5 * (loop_buf_l[i] + loop_buf_r[i]);
                    if s < mn {
                      mn = s;
                    }
                    if s > mx {
                      mx = s;
                    }
                    i += step;
                  }
                  if mn > mx {
                    mn = 0.0;
                    mx = 0.0;
                  }
                  LOOP_VIZ_PEAKS[col * 2].store(mn.to_bits(), Ordering::Relaxed);
                  LOOP_VIZ_PEAKS[col * 2 + 1]
                    .store(mx.to_bits(), Ordering::Relaxed);
                }
                LOOP_VIZ_VERSION.fetch_add(1, Ordering::Release);
              }
            }
            MixerCommand::LoopStop => {
              loop_active = false;
              loop_len = 0;
              for g in loop_grains.iter_mut() {
                g.active = false;
              }
              if let Some((_, _, _, _, stop)) = loop_bounce.take() {
                stop.store(true, Ordering::Release);
                loop_bounce_started = false;
              }
              LOOP_VIZ_POS.store((-1.0f32).to_bits(), Ordering::Relaxed);
              LOOP_VIZ_BOUNCE.store((-1.0f32).to_bits(), Ordering::Relaxed);
            }
            MixerCommand::LoopGain { gain } => {
              if gain.is_finite() {
                loop_gain = gain.clamp(0.0, 1.5);
              }
            }
            MixerCommand::NoiseCapture { start_frame, end_frame } => {
              // Same retroactive modular-slice copy as LoopCapture, into
              // the NOISE unit's own buffer.
              let now = ENGINE_FRAMES.load(Ordering::Relaxed);
              let len = end_frame.saturating_sub(start_frame) as usize;
              let ring_len = loop_ring_l.len();
              let oldest = now.saturating_sub(ring_len as u64);
              if len > 0
                && len <= ring_len
                && start_frame >= oldest
                && end_frame <= now
              {
                let s0 = (start_frame % ring_len as u64) as usize;
                let first = (ring_len - s0).min(len);
                noise_buf_l[..first]
                  .copy_from_slice(&loop_ring_l[s0..s0 + first]);
                noise_buf_r[..first]
                  .copy_from_slice(&loop_ring_r[s0..s0 + first]);
                if first < len {
                  let rest = len - first;
                  noise_buf_l[first..len].copy_from_slice(&loop_ring_l[..rest]);
                  noise_buf_r[first..len].copy_from_slice(&loop_ring_r[..rest]);
                }
                noise_len = len;
                noise_anchor = end_frame;
                noise_capture_active = true;
                noise_pos = 0.0;
              }
            }
            MixerCommand::NoiseStop => {
              noise_capture_active = false;
              noise_len = 0;
            }
            MixerCommand::NoiseParams {
              source,
              speed,
              drive,
              cutoff,
              res,
              width,
              mode,
              noise,
              cv,
              clock_frames,
              clock_synced,
              clock_mode,
              clock_src,
              clock_div,
              sens,
              level,
              fx_send,
              rev_send,
              del_send,
            } => {
              noise_source = source.min(3);
              if speed.is_finite() {
                noise_speed = speed.clamp(-4.0, 4.0);
              }
              if drive.is_finite() {
                noise_drive = drive.clamp(0.0, 1.0);
              }
              if cutoff.is_finite() {
                noise_cutoff = cutoff.clamp(0.0, 1.0);
              }
              if res.is_finite() {
                noise_res = res.clamp(0.0, 1.0);
              }
              if width.is_finite() {
                noise_width = width.clamp(0.0, 1.0);
              }
              noise_mode = mode.min(1);
              if noise.is_finite() {
                noise_amt = noise.clamp(0.0, 1.0);
              }
              if cv.is_finite() {
                noise_cv = cv.clamp(0.0, 1.0);
              }
              if clock_frames.is_finite() {
                // Floor 4 frames — audio-rate clocks turn the LFSR into
                // pitched digital hash (the Mörser noise color range).
                noise_clock_frames = clock_frames.clamp(4.0, 4_000_000.0);
              }
              noise_clock_synced = clock_synced;
              noise_clock_mode = clock_mode.min(1);
              noise_clock_src = clock_src.min(2);
              noise_clock_div = clock_div.clamp(1, 256);
              if sens.is_finite() {
                noise_sens = sens.clamp(0.0, 1.0);
              }
              if level.is_finite() {
                noise_level = level.clamp(0.0, 2.0);
              }
              if fx_send.is_finite() {
                noise_fx_send = fx_send.clamp(0.0, 1.0);
              }
              if rev_send.is_finite() {
                noise_rev_send = rev_send.clamp(0.0, 1.0);
              }
              if del_send.is_finite() {
                noise_del_send = del_send.clamp(0.0, 1.0);
              }
            }
            MixerCommand::LoopBounce { producer, frames, align_frames, stop } => {
              // Replace any bounce in flight — finalize it first.
              if let Some((_, _, _, _, old_stop)) = loop_bounce.take() {
                old_stop.store(true, Ordering::Release);
              }
              loop_bounce_started = false;
              if loop_active && loop_len > 0 && frames > 0 {
                loop_bounce =
                  Some((producer, frames, frames, align_frames.max(1), stop));
              } else {
                // Unit empty (JS guards this) — finalize an empty take.
                stop.store(true, Ordering::Release);
              }
            }
            MixerCommand::LoopParams {
              speed,
              pitch,
              loop_lock: lock,
              loop_level,
              grain_level,
              fx_send,
              rev_send,
              del_send,
              size,
              random,
              grains,
              spawn_frames,
              rate_synced,
              size_dev,
              pitch_dev,
              rate_dev,
            } => {
              if speed.is_finite() {
                loop_speed = speed.clamp(-4.0, 4.0);
              }
              if pitch.is_finite() {
                loop_pitch = pitch.clamp(-4.0, 4.0);
              }
              loop_lock = lock;
              if loop_level.is_finite() {
                loop_tape_level = loop_level.clamp(0.0, 2.0);
              }
              if grain_level.is_finite() {
                loop_grain_level = grain_level.clamp(0.0, 2.0);
              }
              if fx_send.is_finite() {
                loop_fx_send = fx_send.clamp(0.0, 1.0);
              }
              if rev_send.is_finite() {
                loop_rev_send = rev_send.clamp(0.0, 1.0);
              }
              if del_send.is_finite() {
                loop_del_send = del_send.clamp(0.0, 1.0);
              }
              if size.is_finite() {
                loop_size = size.clamp(0.0, 1.0);
              }
              if random.is_finite() {
                loop_random = random.clamp(0.0, 1.0);
              }
              loop_grain_count = (grains as usize).clamp(1, loop_grains.len());
              if spawn_frames.is_finite() {
                loop_spawn_frames = spawn_frames.clamp(32.0, 4_000_000.0);
              }
              loop_rate_synced = rate_synced;
              if size_dev.is_finite() {
                loop_size_dev = size_dev.clamp(0.0, 1.0);
              }
              if pitch_dev.is_finite() {
                loop_pitch_dev = pitch_dev.clamp(0.0, 1.0);
              }
              if rate_dev.is_finite() {
                loop_rate_dev = rate_dev.clamp(0.0, 1.0);
              }
            }
            MixerCommand::FadeTextures { fade_frames } => {
              if fade_frames > 0 {
                for v in voices.iter_mut() {
                  // Only texture voices fade. Everything else — and the
                  // pending-trigger queue — is intentionally left alone.
                  if !v.active || !v.is_texture {
                    continue;
                  }
                  // Don't re-lengthen a ramp already shorter than this
                  // (e.g. a texture mid-choke) — only start or extend
                  // toward the stop fade.
                  let already =
                    v.release_remaining > 0 && v.release_remaining <= fade_frames;
                  if !already {
                    v.release_remaining = fade_frames;
                    v.release_total = fade_frames;
                  }
                }
              }
            }
            MixerCommand::FlushPending { min_frame } => {
              // retain() shifts in place within the pre-allocated Vec — no
              // realloc on the audio thread.
              pending_triggers.retain(|p| p.target_frame < min_frame);
            }
            MixerCommand::StartCombinedRecording {
              producer,
              start_frame,
            } => {
              // Drop any prior producer (worker thread observes via
              // try_pop returning None once it's gone). Install the
              // new one — pushes begin once ENGINE_FRAMES >= start_frame.
              combined_rec_producer = Some(producer);
              rec_start_frame = start_frame;
            }
            MixerCommand::StopCombinedRecording => {
              // Dropping the producer signals end-of-stream to the
              // worker, which drains the remaining queue and finalizes
              // the WAV.
              combined_rec_producer = None;
            }
            MixerCommand::StartSplitsRecording { rhythm, melody } => {
              rhythm_rec_producer = Some(rhythm);
              melody_rec_producer = Some(melody);
              // Splits keep the legacy "capture immediately" behaviour.
              rec_start_frame = 0;
            }
            MixerCommand::StopSplitsRecording => {
              rhythm_rec_producer = None;
              melody_rec_producer = None;
            }
            MixerCommand::StartStemsRecording {
              master,
              fx,
              reverb,
              delay,
              tracks,
              start_frame,
            } => {
              // Move the boxed per-track producer array into audio-thread
              // state (the emptied box frees once, off the hot path). All
              // producers land on this same block → sample-locked files.
              master_rec_producer = master;
              fx_rec_producer = fx;
              reverb_rec_producer = reverb;
              delay_rec_producer = delay;
              stem_rec_producers = *tracks;
              rec_start_frame = start_frame;
            }
            MixerCommand::StopStemsRecording => {
              // Drop every producer → each worker drains + finalizes.
              master_rec_producer = None;
              fx_rec_producer = None;
              reverb_rec_producer = None;
              delay_rec_producer = None;
              for p in stem_rec_producers.iter_mut() {
                *p = None;
              }
            }
          }
        }

        let frames = buf.len() / n_ch.max(1);

        // 1.5) Sample-accurate dispatch — scan pending triggers and
        // fire any whose deadline falls inside the current block. Uses
        // swap_remove for O(1) deletion. Order changes but that's fine
        // (each trigger carries its own absolute deadline; the JS
        // scheduler already computed pan/rate/etc. at push time).
        // Deadlines are absolute ENGINE_FRAMES targets — no per-block
        // countdown, so fire times don't smear with block boundaries.
        // A late trigger (target behind this block) fires at frame 0.
        let mut i = 0;
        while i < pending_triggers.len() {
          if pending_triggers[i].target_frame < block_end_frame {
            let p = pending_triggers.swap_remove(i);
            let start_frame =
              p.target_frame.saturating_sub(block_start_frame) as usize;
            claim_voice_slot(&mut voices, &mut steal_cursor, p, start_frame, sr_f32);
          } else {
            i += 1;
          }
        }

        // 2) Test tone (additive).
        if cb_state.test_tone_enabled.load(Ordering::Acquire) {
          let target_ch = cb_state.test_tone_channel.load(Ordering::Relaxed);
          if target_ch < n_ch {
            if target_ch != last_ch {
              phase = 0.0;
              last_ch = target_ch;
            }
            let freq =
              cb_state.test_tone_freq_mhz.load(Ordering::Relaxed) as f32 / 1000.0;
            let dphase = std::f32::consts::TAU * freq / sr_f32;
            for frame in 0..frames {
              let s = phase.sin() * 0.2;
              buf[frame * n_ch + target_ch] += s;
              phase += dphase;
              if phase > std::f32::consts::TAU {
                phase -= std::f32::consts::TAU;
              }
            }
          }
        }

        // Mix-routing snapshot for this block. Read once so all the
        // per-frame routing in the loop sees a consistent state.
        let multi_out_now = cb_state.multi_out.load(Ordering::Acquire);
        let fx_bypass_now = cb_state.fx_bypass.load(Ordering::Acquire);
        let fx_out_first = cb_state.fx_out_first.load(Ordering::Acquire) as usize;
        let fx_out_stereo = cb_state.fx_out_stereo.load(Ordering::Acquire);

        // Clear the reverb input bus + section scratches for this
        // block. Voices accumulate their wet contribution + section
        // tap into these during the voice loop below.
        let rev_frames = frames.min(REVERB_SCRATCH);
        for i in 0..rev_frames {
          // Seed the buses with LAST block's unit sends (loop/noise →
          // mangler/reverb/delay, one block deferred), then clear the
          // carries for this block's accumulation.
          fxbus_l[i] = units_fx_carry_l[i];
          fxbus_r[i] = units_fx_carry_r[i];
          rev_send_l[i] = units_rev_carry_l[i];
          rev_send_r[i] = units_rev_carry_r[i];
          delay_send_l[i] = units_del_carry_l[i];
          delay_send_r[i] = units_del_carry_r[i];
          units_fx_carry_l[i] = 0.0;
          units_fx_carry_r[i] = 0.0;
          units_rev_carry_l[i] = 0.0;
          units_rev_carry_r[i] = 0.0;
          units_del_carry_l[i] = 0.0;
          units_del_carry_r[i] = 0.0;
          rhythm_l[i] = 0.0;
          rhythm_r[i] = 0.0;
          melody_l[i] = 0.0;
          melody_r[i] = 0.0;
        }
        // Per-track dry stem scratches — cleared only for armed slots, and
        // only when a stems take is running, so the idle path never touches
        // these 16 buffers. (fx_stem is a snapshot via copy, no clear needed;
        // reverb/delay push their process_block outputs directly.)
        let stems_recording = master_rec_producer.is_some()
          || fx_rec_producer.is_some()
          || reverb_rec_producer.is_some()
          || delay_rec_producer.is_some()
          || stem_rec_producers.iter().any(|p| p.is_some());
        if stems_recording {
          for idx in 0..MAX_STEMS {
            if stem_rec_producers[idx].is_some() {
              for i in 0..rev_frames {
                stem_l[idx][i] = 0.0;
                stem_r[idx][i] = 0.0;
              }
            }
          }
        }

        // 3) Voices — per-voice routing.
        //   • Stereo voice: writes interpolated L/R to out_first / out_first+1
        //     with equal-power pan, channel bounds checked.
        //   • Mono voice:  writes 0.5×(L+R) sum to out_first only; pan is
        //     ignored (it's a stereo concept — on a mono out it would just
        //     attenuate). Bass / kick / centered leads ride mono pairs.
        //   • Per-track ladder filter applied between interpolation and
        //     output write when track_params is present. cutoff_hz +
        //     resonance read once per FRAME (not per voice per frame
        //     redundantly) — knob twists land at audio-block resolution.
        //   • Per-track fx_send routes (signal × fx_send × gain × pan) into
        //     the reverb input bus. Voice's dry output to assigned
        //     channels is attenuated by (1 - fx_send). For mono routing
        //     the wet contribution still uses the post-pan stereo signal
        //     (reverb sums L+R internally before processing anyway).
        // Per-channel buffer-index math stays inside the per-voice branch so
        // we never blindly write past n_ch on a smaller-than-expected device.
        for v in voices.iter_mut() {
          if !v.active {
            continue;
          }
          // Borrow the sample + track params instead of Arc-cloning each
          // voice each block: disjoint field borrows let us still mutate
          // v.position / v.env_* / v.active through the same &mut Voice.
          // Avoids the per-voice atomic inc/dec and — more importantly —
          // ensures the final Arc::drop never lands on the audio thread.
          if v.sample.is_none() {
            v.active = false;
            continue;
          }
          // Borrow sample frames + channel count for the duration of
          // the per-frame loop. We MUST NOT mutate v.sample or
          // v.track_params inside this loop — defer those writes to
          // the post-loop block using `deactivate_reason`.
          let (frames_slice, sample_channels, frame_count) = {
            let s = v.sample.as_ref().expect("active voice has sample");
            (s.frames.as_slice(), s.channels, s.frame_count())
          };
          let track_params_ref = v.track_params.as_ref();
          // Catmull-Rom read at an arbitrary fractional position. Captures
          // frames_slice (an immutable borrow of v.sample, disjoint from the
          // v.position/env mutations below) so it can serve both the primary
          // read head and the loop-seam crossfade head. Clamps i0 so the
          // inner pair stays in bounds; outer neighbours repeat the edge.
          let read_at = |p: f64| -> (f32, f32) {
            let i0 = (p.floor() as usize).min(frame_count.saturating_sub(2));
            let frac = (p - i0 as f64) as f32;
            let im1 = if i0 >= 1 { i0 - 1 } else { i0 };
            let ip2 = if i0 + 2 < frame_count { i0 + 2 } else { i0 + 1 };
            if sample_channels == 1 {
              let s = catmull(
                frames_slice[im1],
                frames_slice[i0],
                frames_slice[i0 + 1],
                frames_slice[ip2],
                frac,
              );
              (s, s)
            } else {
              let l = catmull(
                frames_slice[im1 * 2],
                frames_slice[i0 * 2],
                frames_slice[(i0 + 1) * 2],
                frames_slice[ip2 * 2],
                frac,
              );
              let r = catmull(
                frames_slice[im1 * 2 + 1],
                frames_slice[i0 * 2 + 1],
                frames_slice[(i0 + 1) * 2 + 1],
                frames_slice[ip2 * 2 + 1],
                frac,
              );
              (l, r)
            }
          };
          // Anti-aliased read: a box-average of `n` source frames centred on
          // `p`. Used by the wavetable oscillator when it DOWNSAMPLES — a big
          // window read as one cycle steps many source frames per output sample
          // (e.g. a 2048-frame window at C3 ≈ 5.5 frames/sample), so point
          // sampling aliases the window content into broadband crunch. Averaging
          // ~`step` frames is a cheap box low-pass that kills most of it. n<=1
          // falls back to the interpolating read (upsampling / near-unity).
          let read_avg = |p: f64, n: usize| -> (f32, f32) {
            if n <= 1 {
              return read_at(p);
            }
            // CONTINUOUS box average: the window edges get fractional weights,
            // so the average slides smoothly with `p`. The previous version
            // truncated the bounds to integers — as the read head strided,
            // whole frames popped in/out of the average, stepping the output
            // by ~|frame|/n at content-dependent positions (measured ≈0.1 FS
            // on hot pad material ≈100/s — the residual wavetable "crunch",
            // random-feeling because it tracks content, not notes or blocks).
            let half = n as f64 * 0.5;
            let lo = (p - half).max(0.0);
            let hi = (p + half).min(frame_count.saturating_sub(1) as f64);
            if hi - lo < 1.0 {
              return read_at(p);
            }
            let i0 = lo.ceil() as usize; // first fully-covered frame
            let i1 = (hi.floor() as usize).min(frame_count.saturating_sub(1));
            let mut suml = 0.0f32;
            let mut sumr = 0.0f32;
            let mut weight = (i1 + 1 - i0) as f32;
            for i in i0..=i1 {
              if sample_channels == 1 {
                let s = frames_slice[i];
                suml += s;
                sumr += s;
              } else {
                suml += frames_slice[i * 2];
                sumr += frames_slice[i * 2 + 1];
              }
            }
            let wl = (i0 as f64 - lo) as f32; // partial coverage of frame i0-1
            if wl > 0.0 && i0 >= 1 {
              let i = i0 - 1;
              if sample_channels == 1 {
                let s = frames_slice[i] * wl;
                suml += s;
                sumr += s;
              } else {
                suml += frames_slice[i * 2] * wl;
                sumr += frames_slice[i * 2 + 1] * wl;
              }
              weight += wl;
            }
            let wr = (hi - i1 as f64) as f32; // partial coverage of frame i1+1
            if wr > 0.0 && i1 + 1 < frame_count {
              let i = i1 + 1;
              if sample_channels == 1 {
                let s = frames_slice[i] * wr;
                suml += s;
                sumr += s;
              } else {
                suml += frames_slice[i * 2] * wr;
                sumr += frames_slice[i * 2 + 1] * wr;
              }
              weight += wr;
            }
            (suml / weight, sumr / weight)
          };
          // Per-track tuning LFO deviation (semitones), read once per block —
          // it's k-rate (the LFO compute writes it once per block). Folded into
          // the per-frame pitch_factor below alongside the mod-grid pitch. A
          // frozen voice (caught mid-tail by a scene/bank/song swap) keeps its
          // pitch — the incoming scene must not retune the ring-out.
          let track_tune_semis: f32 = if v.frozen_params.is_some() {
            0.0
          } else {
            track_params_ref
              .map(|p| p.tune_mod_semis() + p.finetune_mod_semis())
              .unwrap_or(0.0)
          };
          // Continuous wavetable-scan deviation from a routed global LFO
          // (TrackWtPosition). k-rate (LFO compute updates it per block); added
          // to the wt voice's scan below so the window sweeps through held notes.
          // Frozen (swap-caught) voices keep their scan — no incoming-LFO retune.
          let track_wtpos: f32 = if v.frozen_params.is_some() {
            0.0
          } else {
            track_params_ref.map(|p| p.wt_pos_mod()).unwrap_or(0.0)
          };
          // One-pole coefficient (~4ms time constant) for the per-frame
          // smoothing of track_wtpos inside the wt read: the LFO compute lands
          // once per block, and adding the step raw jumps the scan at every
          // block edge. Computed once per block (exp is off the per-sample path).
          let wt_track_k: f64 =
            1.0 - (-1.0_f64 / (0.004 * (sr_f32 as f64).max(1.0))).exp();
          // Loop geometry is constant across the block. xf = seam crossfade
          // length, capped at half the span so short loops still blend.
          let span = v.play_end - v.play_start;
          let xf = ((sr_f32 * LOOP_XFADE_SECS) as f64).min(span * 0.5).max(0.0);
          // Honor sample-accurate dispatch — voice may have been queued
          // to start partway into this block. Reset start_frame after
          // the loop so subsequent blocks emit from frame 0.
          let start = v.start_frame;
          let mut deactivate = false;
          for frame in start..frames {
            // Generic modulators (B2 grid): advance LFO phases, then read each
            // target's offset. Computed at the TOP of the frame so the granular
            // read below can use the position offset (slots 6/7). Envelope mods
            // clock off frames_played + the note hold; LFO mods off their phase.
            // Slots: 0 vol-LFO (tremolo) · 1 pan-env · 2 pan-LFO · 3 cutoff-env ·
            // 4 pitch-env · 5 pitch-LFO · 6 granPos-LFO · 7 granPos-env.
            for m in v.mods.iter_mut() {
              m.tick(sr_f32);
            }
            let mod_elapsed = v.frames_played;
            let mod_hold = v.mod_hold_samples;
            let mod_tremolo = 1.0 + v.mods[0].value(mod_elapsed, mod_hold);
            let mod_pan = v.mods[1].value(mod_elapsed, mod_hold)
              + v.mods[2].value(mod_elapsed, mod_hold);
            let mod_cutoff = v.mods[3].value(mod_elapsed, mod_hold);
            let cutoff_mod_on = v.mods[3].on;
            let mod_pitch_semis = v.mods[4].value(mod_elapsed, mod_hold)
              + v.mods[5].value(mod_elapsed, mod_hold)
              + track_tune_semis;
            let pitch_factor = if mod_pitch_semis != 0.0 {
              2.0_f64.powf((mod_pitch_semis / 12.0) as f64)
            } else {
              1.0
            };
            // Granular-position offset is UNIPOLAR/forward (matches the Tracker
            // "amount" — the read scans forward from the set position, not a
            // bipolar wobble around it like the pan/pitch/cutoff depths). The
            // envelope (slot 7) is already a positive 0..depth ramp; the LFO
            // (slot 6) is remapped from its bipolar shape to a 0..1 sweep ×
            // depth so it pushes the position forward only.
            let granpos_lfo = if v.mods[6].on {
              ((lfo_eval(v.mods[6].shape, v.mods[6].phase, v.mods[6].rand) + 1.0) * 0.5)
                * v.mods[6].depth
            } else {
              0.0
            };
            let mod_granpos = granpos_lfo + v.mods[7].value(mod_elapsed, mod_hold);
            // Wavetable-position offset (slots 8/9). Same unipolar-forward
            // shaping as granular position: the LFO is remapped to a 0..1 sweep
            // × depth so it scans the table forward from the set position; the
            // envelope (slot 9) is already a positive ramp.
            let wtpos_lfo = if v.mods[8].on {
              ((lfo_eval(v.mods[8].shape, v.mods[8].phase, v.mods[8].rand) + 1.0) * 0.5)
                * v.mods[8].depth
            } else {
              0.0
            };
            let mod_wtpos = wtpos_lfo + v.mods[9].value(mod_elapsed, mod_hold);
            // Pan modulation: recompute equal-power gains around the base pan.
            if mod_pan != 0.0 {
              let pan_eff = (v.pan_base + mod_pan).clamp(-1.0, 1.0);
              let angle = (pan_eff + 1.0) * 0.5 * std::f32::consts::FRAC_PI_2;
              v.pan_left = angle.cos();
              v.pan_right = angle.sin();
            }

            // Read one frame. Granular (Phase C) uses a single windowed
            // read-head; everything else uses the trim/loop reader. Both yield
            // (ls, rs) + the read position `pos` (used for the playhead +
            // declick out-fade). The normal branch may `break` to deactivate a
            // finished one-shot; granular voices never end by position (they
            // ring until the envelope/note-off/voice-steal stops them).
            let pos;
            let (mut ls, mut rs);
            if v.wt_on {
              // Wavetable: single-cycle oscillator. The sample is a bank of
              // `wf`-frame windows (each one cycle); the played note (wt_hz) sets
              // the pitch by advancing the in-window phase wf·hz/sr per output
              // sample (one window = one cycle), and the scan position (+ the
              // wtPos mods, slots 8/9) picks which window is read. `morph`
              // crossfades the two nearest windows so a sweep glides; off snaps
              // to the nearest window. The scan doesn't advance with playback
              // (it's a table lookup, not a read-through), so the voice never
              // ends by position — it rings until the envelope / note-off / steal.
              let wf = v.wt_window_frames.max(2.0);
              let last = (frame_count as f64 - 2.0).max(0.0);
              let window_count = (frame_count as f64 / wf).floor().max(1.0);
              // Smooth the k-rate TrackWtPosition deviation per frame (one-pole,
              // ~4ms). The global LFO writes wt_pos_mod once per BLOCK; added
              // raw, a swept scan STEPS at every block edge — a hard waveform
              // jump (up to ~0.6 FS, ~25-90/s measured offline) heard as
              // intermittent crunch. Smoothed, the sweep glides through the
              // table. A static scan is bit-identical: state == target from the
              // seed on. (The instrument wtPos mods, slots 8/9, are already
              // evaluated per frame — only the track write is k-rate.)
              if v.wt_track_scan.is_nan() {
                v.wt_track_scan = track_wtpos as f64;
              }
              v.wt_track_scan +=
                (track_wtpos as f64 - v.wt_track_scan) * wt_track_k;
              let scan = ((v.wt_pos_norm + mod_wtpos) as f64 + v.wt_track_scan)
                .clamp(0.0, 1.0);
              // Publish the live scan for the editor's visualizer when this is the
              // monitored voice (so the zoomed window tracks deviation + automation).
              if v.note_id != 0 && v.note_id == MONITOR_NOTE_ID.load(Ordering::Relaxed) {
                MONITOR_WT_SCAN.store((scan as f32).to_bits(), Ordering::Relaxed);
              }
              let wpos = scan * (window_count - 1.0);
              let ph = v.wt_phase.min(wf); // in-window read offset (frames)
              // Crossfade between adjacent windows when morph is on: a moving
              // scan (LFO / automation) read in stepped mode jumps a whole window
              // at each boundary — a hard discontinuity that reads as roughness.
              // Morph keeps every read at the same phase (pitch = wt_hz) and just
              // blends waveform content, so a swept scan stays clean. Stepped
              // (morph off) is the lo-fi character choice for a static window.
              let smooth = v.wt_morph && window_count > 1.0;
              // Frames the read head steps per output sample = wf·hz/sr. When
              // > ~1 the window is DOWNSAMPLED (a big window crammed into one
              // period), so box-average ~step frames to band-limit and kill the
              // aliasing crunch; ≤1.5 uses the interpolating read (bright).
              let step = wf * (v.wt_hz as f64) / (sr_f32 as f64).max(1.0);
              let aa_n = if step > 1.5 {
                (step.round() as usize).min(64)
              } else {
                1
              };
              // Read ONE cycle of window `base`, looped seamlessly. Looping a
              // wf-frame slice wraps sample[base+wf-1] → sample[base] every
              // cycle; those rarely match, so the raw wrap clicks at the
              // fundamental — the buzzy "crunch" heard even on small windows.
              // Fix = the loop-seam crossfade the regular loop path already uses:
              // over the last `xf` frames, fade the window's tail into the frames
              // just before it (base-xf..base), which are contiguous with base —
              // so the wrap (base⁻ → base) is sample-continuous. Composes with the
              // anti-alias read. Wider xf = smoother but more neighbour bleed.
              let xf = (wf * WT_SEAM_FRAC).clamp(1.0, wf * 0.5);
              // Baked (smoother) tables: each window is circularly smoothed +
              // gain-matched INDEPENDENTLY, so windows are periodic but
              // mutually discontinuous at their edges. Read with in-window
              // WRAPPED Catmull — taps never cross into a neighbor, the wrap
              // is exactly continuous, and the AA box is unnecessary (the
              // bake band-limits to ~16 harmonics).
              let wt_baked = v.wt_smooth;
              let wf_u = (wf as usize).max(2);
              let read_cycle_baked = |base: f64| -> (f32, f32) {
                let b = base as usize;
                let i0 = (ph.floor() as usize).min(wf_u - 1);
                let frac = (ph - i0 as f64) as f32;
                let i = i0 as isize;
                let tap_idx = |j: isize| -> usize {
                  let m = j.rem_euclid(wf_u as isize) as usize;
                  (b + m).min(frame_count.saturating_sub(1))
                };
                if sample_channels == 1 {
                  let s = catmull(
                    frames_slice[tap_idx(i - 1)],
                    frames_slice[tap_idx(i)],
                    frames_slice[tap_idx(i + 1)],
                    frames_slice[tap_idx(i + 2)],
                    frac,
                  );
                  (s, s)
                } else {
                  let l = catmull(
                    frames_slice[tap_idx(i - 1) * 2],
                    frames_slice[tap_idx(i) * 2],
                    frames_slice[tap_idx(i + 1) * 2],
                    frames_slice[tap_idx(i + 2) * 2],
                    frac,
                  );
                  let r = catmull(
                    frames_slice[tap_idx(i - 1) * 2 + 1],
                    frames_slice[tap_idx(i) * 2 + 1],
                    frames_slice[tap_idx(i + 1) * 2 + 1],
                    frames_slice[tap_idx(i + 2) * 2 + 1],
                    frac,
                  );
                  (l, r)
                }
              };
              // `seam_base` is the window whose START the wrap will land on:
              // the same window for morph/static reads (today's behavior), the
              // PENDING window in stepped mode so a window switch splices
              // sample-continuously at the wrap instead of mid-cycle. Baked
              // tables fade A(ph)→B(ph) instead — both circular, so the wrap
              // lands exactly on B's continuation.
              let read_cycle = |base: f64, seam_base: f64| -> (f32, f32) {
                if wt_baked {
                  let main = read_cycle_baked(base);
                  if seam_base != base && ph > wf - xf {
                    let t = ((ph - (wf - xf)) / xf) as f32;
                    let seam = read_cycle_baked(seam_base);
                    return (
                      main.0 + (seam.0 - main.0) * t,
                      main.1 + (seam.1 - main.1) * t,
                    );
                  }
                  return main;
                }
                let main = read_avg((base + ph).clamp(0.0, last), aa_n);
                if ph > wf - xf {
                  let t = ((ph - (wf - xf)) / xf) as f32;
                  let seam =
                    read_avg((seam_base + ph - wf).clamp(0.0, last), aa_n);
                  (main.0 + (seam.0 - main.0) * t, main.1 + (seam.1 - main.1) * t)
                } else {
                  main
                }
              };
              let wi_target = wpos.round().min(window_count - 1.0);
              if smooth {
                let wi0 = wpos.floor();
                let wi1 = (wi0 + 1.0).min(window_count - 1.0);
                let t = (wpos - wi0) as f32;
                let (l0, r0) = read_cycle(wi0 * wf, wi0 * wf);
                let (l1, r1) = read_cycle(wi1 * wf, wi1 * wf);
                ls = l0 + (l1 - l0) * t;
                rs = r0 + (r1 - r0) * t;
                pos = (wi0 * wf + ph).clamp(0.0, last);
              } else {
                // Stepped (morph off): the cycle in flight keeps ITS window —
                // re-picking per frame flips content mid-cycle whenever the
                // scan moves, a hard splice (the measured swept-scan clicks).
                // The destination window is latched at seam ENTRY (a target
                // that moves mid-blend also clicks), the tail crossfades
                // toward the destination's pre-start frames, and the switch
                // lands exactly on the phase wrap. Static scan: cur == next ==
                // target, identical to the plain read.
                if v.wt_wi_cur < 0.0 {
                  v.wt_wi_cur = wi_target;
                }
                if ph > wf - xf && v.wt_wi_next < 0.0 {
                  v.wt_wi_next = wi_target;
                }
                let seam_wi = if v.wt_wi_next >= 0.0 {
                  v.wt_wi_next
                } else {
                  wi_target
                };
                let (l, r) = read_cycle(v.wt_wi_cur * wf, seam_wi * wf);
                ls = l;
                rs = r;
                pos = (v.wt_wi_cur * wf + ph).clamp(0.0, last);
              }
              v.position = pos; // publish for the editor playhead readback
              // Advance the single-cycle phase; wrap at one window. Higher notes
              // sweep the window faster (higher pitch), matching an oscillator.
              v.wt_phase += step;
              if v.wt_phase >= wf {
                v.wt_phase %= wf;
                // The seam just faded the tail onto the pending window's start —
                // promote it. No pending: track the live target so a stale
                // window can't stick across cycles.
                v.wt_wi_cur = if v.wt_wi_next >= 0.0 {
                  v.wt_wi_next
                } else {
                  wi_target
                };
                v.wt_wi_next = -1.0;
              }
            } else if v.gran_on {
              // `gran_read` advances through the grain at the playback rate
              // (rate·pitch) and wraps at `grain_len` SOURCE frames, so the grain
              // RATE tracks pitch — higher notes fire grains faster, lower notes
              // slower (confirmed against the hardware: grain speed changes with
              // pitch). Each grain reads from a LATCHED start, shaped by gran_shape,
              // read in gran_dir, repeating to sustain. The start is fixed per
              // grain; the position automation (slots 6/7, unipolar fwd) + scatter
              // only take effect at the next grain boundary — the discrete-grain
              // texture.
              let grain_len = v.gran_grain_frames.max(2.0);
              let target_base = ((v.gran_pos_norm + mod_granpos).clamp(0.0, 1.0) as f64)
                * ((frame_count as f64) - 2.0).max(0.0);
              let base = v.gran_base_latched;
              let fwd = match v.gran_dir {
                0 => true,
                1 => false,
                _ => v.gran_ping_fwd,
              };
              let off = if fwd { v.gran_read } else { grain_len - v.gran_read };
              let read_pos = (base + off).clamp(0.0, (frame_count as f64 - 2.0).max(0.0));
              let (gl, gr) = read_at(read_pos);
              let w = grain_window(v.gran_shape, (v.gran_read / grain_len) as f32);
              ls = gl * w;
              rs = gr * w;
              pos = base;
              v.position = base; // publish for the editor playhead readback
              // Advance the in-grain read head at the playback rate; wrap
              // (re-trigger the grain) at grain_len. On wrap, LATCH the next grain's
              // start to the automated position (± scatter) and flip pingpong dir.
              v.gran_read += v.rate * pitch_factor;
              if v.gran_read >= grain_len {
                v.gran_read -= grain_len;
                if v.gran_read >= grain_len {
                  v.gran_read = 0.0; // extreme rate overshoot guard
                }
                // Latch the next grain's start at the automated position ± a
                // random scatter (spray), so successive grains jump around the
                // point instead of all reading the same forward span.
                let scatter = if v.gran_spray > 0.0 {
                  (lfo_rand_bipolar(&mut v.gran_rng) as f64)
                    * (v.gran_spray as f64)
                    * ((frame_count as f64) - 2.0).max(0.0)
                } else {
                  0.0
                };
                v.gran_base_latched =
                  (target_base + scatter).clamp(0.0, ((frame_count as f64) - 2.0).max(0.0));
                if v.gran_dir == 2 {
                  v.gran_ping_fwd = !v.gran_ping_fwd;
                }
              }
            } else {
              // Loop-window handling (A3). Keep the read position inside
              // [play_start, play_end]: forward/backward loops wrap to the
              // opposite edge, pingpong bounces (flipping play_dir). The
              // one-shots — forward (loop_mode 0) and reverse (loop_mode 4) —
              // never wrap; they run to their far edge and stop (handled below).
              let is_loop = v.loop_mode == 1 || v.loop_mode == 2 || v.loop_mode == 3;
              if is_loop && span > 1.0 {
                if v.loop_mode == 3 {
                  if v.position >= v.play_end {
                    v.position = v.play_end;
                    v.play_dir = -1.0;
                  } else if v.position <= v.play_start {
                    v.position = v.play_start;
                    v.play_dir = 1.0;
                  }
                } else if v.play_dir > 0.0 {
                  while v.position >= v.play_end {
                    v.position -= span;
                  }
                } else {
                  while v.position <= v.play_start {
                    v.position += span;
                  }
                }
              }
              pos = v.position;
              let i0 = pos.floor() as usize;
              // Terminate one-shots at their far edge (or the sample's last
              // interpolatable frame, as a safety bound): forward one-shots stop
              // at play_end, reverse one-shots (loop_mode 4) at play_start.
              // Looped voices stay alive — the wrap above keeps them in range.
              if i0 + 1 >= frame_count
                || (v.loop_mode == 0 && pos >= v.play_end)
                || (v.loop_mode == 4 && pos <= v.play_start)
              {
                deactivate = true;
                break;
              }
              let (l0, r0) = read_at(pos);
              ls = l0;
              rs = r0;
              // Loop-seam crossfade — fwd/bwd loops jump at the seam, so blend
              // the tail (approaching the jump edge) with the material we're
              // about to wrap to, over `xf` frames, equal-power (constant
              // energy). Pingpong (mode 3) reverses continuously — no jump, no
              // blend. One-shots (mode 0) never reach here. This is what keeps
              // loops from clicking when start/end aren't on zero crossings.
              if xf > 1.0 && (v.loop_mode == 1 || v.loop_mode == 2) {
                // t = 0 at the zone entry (pure tail) → 1 at the seam (head).
                let t = if v.loop_mode == 1 {
                  // forward: seam at play_end, head is one span back
                  ((pos - (v.play_end - xf)) / xf).clamp(0.0, 1.0)
                } else {
                  // backward: seam at play_start, head is one span forward
                  (((v.play_start + xf) - pos) / xf).clamp(0.0, 1.0)
                };
                if t > 0.0 {
                  let head_pos = if v.loop_mode == 1 {
                    (pos - span).max(0.0)
                  } else {
                    (pos + span).min(frame_count as f64 - 2.0)
                  };
                  let (hl, hr) = read_at(head_pos);
                  // Equal-power: tail cos, head sin over the quarter circle.
                  let angle = (t as f32) * std::f32::consts::FRAC_PI_2;
                  let (tail_g, head_g) = (angle.cos(), angle.sin());
                  ls = ls * tail_g + hl * head_g;
                  rs = rs * tail_g + hr * head_g;
                }
              }
            }
            // Per-instrument filter (B1) — applied on the reconstructed
            // sample, ahead of the per-track mixer ladder below, so it's part
            // of the instrument's voice rather than the channel strip. Cutoff
            // is swept live by the cutoff LFO (B2, bespoke) and/or the cutoff
            // envelope (generic slot 3), recomputed every LFO_RECOMPUTE_SAMPLES
            // — coeffs only, so the delay line keeps running (click-free).
            if v.inst_filter_on {
              if v.lfo_on || cutoff_mod_on {
                if v.lfo_on {
                  v.lfo_phase += v.lfo_rate_hz / sr_f32;
                  if v.lfo_phase >= 1.0 {
                    v.lfo_phase -= v.lfo_phase.floor();
                    v.lfo_rand = lfo_rand_bipolar(&mut v.lfo_rng);
                  }
                }
                if v.lfo_recompute_ctr == 0 {
                  let lfo_amt = if v.lfo_on {
                    v.lfo_depth * lfo_eval(v.lfo_shape, v.lfo_phase, v.lfo_rand)
                  } else {
                    0.0
                  };
                  let mod_norm =
                    (v.inst_cutoff_norm + lfo_amt + mod_cutoff).clamp(0.0, 1.0);
                  let fc_hz = cutoff_norm_to_hz(mod_norm);
                  match v.inst_filter_type {
                    1 => {
                      v.inst_filter_l.set_lowpass(sr_f32, fc_hz, v.inst_q);
                      v.inst_filter_r.set_lowpass(sr_f32, fc_hz, v.inst_q);
                    }
                    2 => {
                      v.inst_filter_l.set_highpass(sr_f32, fc_hz, v.inst_q);
                      v.inst_filter_r.set_highpass(sr_f32, fc_hz, v.inst_q);
                    }
                    _ => {
                      v.inst_filter_l.set_bandpass(sr_f32, fc_hz, v.inst_q);
                      v.inst_filter_r.set_bandpass(sr_f32, fc_hz, v.inst_q);
                    }
                  }
                }
                v.lfo_recompute_ctr += 1;
                if v.lfo_recompute_ctr >= LFO_RECOMPUTE_SAMPLES {
                  v.lfo_recompute_ctr = 0;
                }
              }
              ls = v.inst_filter_l.process(ls);
              rs = v.inst_filter_r.process(rs);
            }
            // Per-instrument saturation — post-filter so a cranked
            // resonance screams into the shaper. Same tanh curve as the
            // mangler-bus pre-drive (warm to 0.5, crushing past it,
            // level-compensated). No oversampling: aliasing at extreme
            // drive is accepted character, same call as the bus stage.
            if v.sat_drive > 0.001 {
              ls = pre_saturate_sample(ls, v.sat_drive);
              rs = pre_saturate_sample(rs, v.sat_drive);
            }
            // Per-instrument bit crush — after saturation (drive → crush),
            // matching the Tracker instrument order. Quantizes to 2^(bits-1)
            // levels per polarity; 16 = bypass. No dither, hard steps —
            // the grit IS the feature.
            if v.bit_depth < 16 {
              let q = (1u32 << (v.bit_depth.max(1) - 1)) as f32;
              ls = (ls * q).round() / q;
              rs = (rs * q).round() / q;
            }
            // Tremolo (vol-LFO, slot 0) — amplitude scale around unity.
            ls *= mod_tremolo;
            rs *= mod_tremolo;
            // Filter coefficients: frozen snapshot (detached on a swap) if
            // present, else live from track_params.
            let filt_coeffs = match v.frozen_params {
              Some((fc, res, _, _, _)) => Some((fc, res)),
              None => track_params_ref.map(|p| (p.cutoff(), p.resonance())),
            };
            if let Some((fc, res)) = filt_coeffs {
              let (fl, fr) = v.filter.process_stereo(ls, rs, fc, res, sr_f32);
              ls = fl;
              rs = fr;
            }
            // Per-voice ADSR envelope. Linear ramps in each phase, so
            // release reaches 0 exactly at hold + release samples and
            // the voice deactivates cleanly on that frame — no asymptotic
            // tail. Release ramps from whatever level was captured on
            // entering release (handles gates that end mid-attack).
            if v.env_active {
              let attack_end = v.env_attack_samples;
              let decay_end = attack_end + v.env_decay_samples;
              let hold_end = v.env_hold_samples;
              let release_end = hold_end + v.env_release_samples;
              if v.env_elapsed < attack_end {
                v.env_level = (v.env_elapsed + 1) as f32
                  / attack_end.max(1) as f32;
              } else if v.env_elapsed < decay_end && v.env_decay_samples > 0 {
                let t = (v.env_elapsed - attack_end + 1) as f32
                  / v.env_decay_samples as f32;
                v.env_level = 1.0 + t * (v.env_sustain_level - 1.0);
              } else if v.env_elapsed < hold_end {
                v.env_level = v.env_sustain_level;
              } else if v.env_elapsed < release_end {
                if v.env_release_start_level < 0.0 {
                  v.env_release_start_level = v.env_level;
                }
                let t = (v.env_elapsed - hold_end + 1) as f32
                  / v.env_release_samples.max(1) as f32;
                v.env_level =
                  v.env_release_start_level * (1.0 - t.min(1.0));
              } else {
                v.env_level = 0.0;
              }
              v.env_elapsed = v.env_elapsed.saturating_add(1);
              ls *= v.env_level;
              rs *= v.env_level;
              // Deactivate on the frame after release ends. We can't
              // null out v.sample / v.track_params here because their
              // borrows are still live in this loop body — defer the
              // cleanup to the post-loop block via `deactivate`.
              if v.env_elapsed >= release_end {
                v.env_active = false;
                deactivate = true;
                break;
              }
            }
            // Declick: flat (non-enveloped) voices get a ~3ms raised-cosine
            // fade at the trigger and at the natural sample end, so samples
            // not trimmed to a zero-crossing don't click on start / cutoff.
            // Enveloped voices skip this — their ADSR already ramps both
            // ends. fade_in tracks output frames since trigger; fade_out
            // tracks output frames until the sample runs out (rate-scaled,
            // so it holds at pitched playback). Overlap on a very short
            // sample just yields a gentle bell — still click-free. Pairs with
            // the zero-crossing snap at trigger time (which starts us in the
            // pre-onset quiet), so this length costs almost no transient punch.
            if !v.env_active {
              let declick = (sr_f32 * 0.003).max(1.0);
              let fade_in = (v.frames_played as f32 / declick).min(1.0);
              // Fade toward the window end for one-shots; looped AND granular
              // voices have no natural end, so they skip the out-fade (the loop
              // wrap / grain repeat is continuous and a fade there would dip).
              // Forward one-shot (0) heads for play_end; reverse one-shot (4)
              // reads backward, so its end is play_start.
              let to_end = if !v.gran_on && !v.wt_on && (v.loop_mode == 0 || v.loop_mode == 4) {
                let frames = if v.loop_mode == 4 {
                  pos - v.play_start
                } else {
                  v.play_end - pos
                };
                ((frames / v.rate.max(1e-9)) as f32).max(0.0)
              } else {
                f32::INFINITY
              };
              let fade_out = (to_end / declick).min(1.0);
              // Raised-cosine (Hann half-window) shaping: a bare linear ramp has
              // slope corners at 0 and 1 that themselves tick on transient-rich
              // material — the S-curve has zero slope at both ends, so it fades
              // silently. 0.5-0.5cos(π·t): 0→0, 1→1.
              let lin = fade_in.min(fade_out);
              let g = 0.5 - 0.5 * (lin * std::f32::consts::PI).cos();
              ls *= g;
              rs *= g;
            }
            // Monophonic-choke release ramp. release_remaining counts
            // down per sample; voice gets scaled linearly toward zero
            // and deactivates when it hits 0. Skipped (scale=1) when
            // no release is in flight.
            if v.release_remaining > 0 && v.release_total > 0 {
              let scale = v.release_remaining as f32 / v.release_total as f32;
              ls *= scale;
              rs *= scale;
            }
            // Section split tap — post-pan, post-filter, post-envelope,
            // pre-FX-bus. Drum voices land in rhythm_l/r; melodic in
            // melody_l/r; click (SECTION_CLICK) lands in BOTH so the
            // count-in serves as a DAW alignment marker in either
            // split file. Matches the web `samplePlayer.trigger`
            // busHead → rhythm/melodyBus tap point.
            if frame < REVERB_SCRATCH && v.section != SECTION_NONE {
              let s_l = ls * v.gain * v.pan_left;
              let s_r = rs * v.gain * v.pan_right;
              match v.section {
                SECTION_DRUM => {
                  rhythm_l[frame] += s_l;
                  rhythm_r[frame] += s_r;
                }
                SECTION_MELODIC => {
                  melody_l[frame] += s_l;
                  melody_r[frame] += s_r;
                }
                SECTION_CLICK => {
                  rhythm_l[frame] += s_l;
                  rhythm_r[frame] += s_r;
                  melody_l[frame] += s_l;
                  melody_r[frame] += s_r;
                }
                _ => {}
              }
            }
            // Wet/dry crossfade: fx_send=0 → pure dry, no FX bus
            // contribution. fx_send=0.5 → 50/50 dry+wet. fx_send=1.0 →
            // pure wet (no dry voice in the output, only the FX bus
            // return). FX bypass collapses fx_send to 0 (dry only) so
            // the wet bus stays silent; voice's stored fx_send is
            // preserved in TrackParams so turning bypass off restores
            // the prior amount with no discontinuity.
            let raw_fx_send = match v.frozen_params {
              Some((_, _, fx, _, _)) => fx,
              None => track_params_ref.map(|p| p.fx_send()).unwrap_or(0.0),
            };
            let fx_send = if fx_bypass_now { 0.0 } else { raw_fx_send };
            let dry_scale = 1.0 - fx_send;
            // Per-track dry stem tap — the voice's actual dry contribution to
            // the master (ls·gain·pan·dry_scale, identical to the buf write
            // below). Sends are additive, so Σ(track stems) + fx + reverb +
            // delay reconstructs the pre-master mix exactly. Gated by
            // `stems_recording` so a voice carrying a stale rec_track (set on a
            // prior take, not yet overwritten) can't accumulate into an
            // un-cleared, un-pushed scratch after the take ends.
            if stems_recording && v.rec_track > 0 && frame < REVERB_SCRATCH {
              let idx = (v.rec_track - 1) as usize;
              if idx < MAX_STEMS {
                stem_l[idx][frame] += ls * v.gain * v.pan_left * dry_scale;
                stem_r[idx][frame] += rs * v.gain * v.pan_right * dry_scale;
              }
            }
            // Mangler bus input is post-gain + post-pan so the wet bus
            // matches the dry path's positioning.
            if fx_send > 0.0 && frame < REVERB_SCRATCH {
              let wet_l = ls * v.gain * v.pan_left * fx_send;
              let wet_r = rs * v.gain * v.pan_right * fx_send;
              fxbus_l[frame] += wet_l;
              fxbus_r[frame] += wet_r;
            }
            // Reverb send — ADDITIVE: taps the voice's full post-gain/pan
            // signal (NOT scaled by dry_scale), so dialing reverb in doesn't
            // thin the dry. Independent of fx_send and fx_bypass; the parallel
            // reverb return sums these below. Reverb mono-sums L+R internally,
            // so pan only sets relative wet level, not tail placement.
            let raw_reverb_send = match v.frozen_params {
              Some((_, _, _, rev, _)) => rev,
              None => track_params_ref.map(|p| p.reverb_send()).unwrap_or(0.0),
            };
            if raw_reverb_send > 0.0 && frame < REVERB_SCRATCH {
              rev_send_l[frame] += ls * v.gain * v.pan_left * raw_reverb_send;
              rev_send_r[frame] += rs * v.gain * v.pan_right * raw_reverb_send;
            }
            // Delay send — same additive aux as reverb (taps the full voice
            // signal, dry untouched), into the global ping-pong delay.
            let raw_delay_send = match v.frozen_params {
              Some((_, _, _, _, dly)) => dly,
              None => track_params_ref.map(|p| p.delay_send()).unwrap_or(0.0),
            };
            if raw_delay_send > 0.0 && frame < REVERB_SCRATCH {
              delay_send_l[frame] += ls * v.gain * v.pan_left * raw_delay_send;
              delay_send_r[frame] += rs * v.gain * v.pan_right * raw_delay_send;
            }
            // Voice routing — multi_out OFF collapses everything to
            // channels 0+1 stereo (graceful headphone fold). Per-voice
            // out_* config is preserved in voice state for when
            // multi_out flips back on.
            //
            // Also fold to 0/1 when the voice's assigned channel pair
            // falls off the end of the current device (e.g., user
            // swapped from an 8ch interface to 2ch and a track was
            // routed to ch 4). Without this fallback the voice would
            // silently drop; the existing `< n_ch` guards below would
            // still bounds-check but no audio reaches any output. The
            // UI surfaces the misrouting separately.
            let needed_channels = if v.out_stereo { 2 } else { 1 };
            let voice_in_range =
              v.out_first.saturating_add(needed_channels) <= n_ch;
            let (route_first, route_stereo) = if multi_out_now && voice_in_range {
              (v.out_first, v.out_stereo)
            } else {
              (0usize, true)
            };
            if route_stereo {
              let l_idx = route_first;
              let r_idx = route_first + 1;
              if l_idx < n_ch {
                buf[frame * n_ch + l_idx] += ls * v.gain * v.pan_left * dry_scale;
              }
              if r_idx < n_ch {
                buf[frame * n_ch + r_idx] += rs * v.gain * v.pan_right * dry_scale;
              }
            } else if route_first < n_ch {
              let mono = 0.5 * (ls + rs);
              buf[frame * n_ch + route_first] += mono * v.gain * dry_scale;
            }
            // Granular advances its own in-grain read head above; the base
            // position is mod-swept, not playback-advanced, so skip the normal
            // position advance for granular voices. Wavetable likewise scans by
            // position (its phase advances in the branch above), not read-through.
            if !v.gran_on && !v.wt_on {
              v.position += v.rate * pitch_factor * v.play_dir;
            }
            // Advance the rate glide (portamento) one frame. Linear ramp of
            // `rate` toward `rate_target` — spreads a re-pitch over ~20ms so
            // there's no slope-discontinuity tick.
            if v.rate_glide_remaining > 0 {
              v.rate += v.rate_glide_inc;
              v.rate_glide_remaining -= 1;
              if v.rate_glide_remaining == 0 {
                v.rate = v.rate_target;
              }
            }
            v.frames_played = v.frames_played.saturating_add(1);
            // Decrement release counter at frame-end. Hitting zero ends
            // the voice cleanly — no more samples emitted this block.
            // Cleanup happens in the post-loop deactivation block.
            if v.release_remaining > 0 {
              v.release_remaining -= 1;
              if v.release_remaining == 0 {
                v.release_total = 0;
                deactivate = true;
                break;
              }
            }
          }
          // Block-end reset — subsequent blocks emit from frame 0.
          v.start_frame = 0;
          // Editor playhead: publish this voice's normalized read position
          // once per block if it's the one the instrument editor is
          // monitoring. -1 on deactivation so the UI knows the note ended.
          if v.note_id != 0 && v.note_id == MONITOR_NOTE_ID.load(Ordering::Relaxed) {
            let norm = if deactivate || frame_count <= 1 {
              -1.0_f32
            } else {
              (v.position / (frame_count as f64 - 1.0)).clamp(0.0, 1.0) as f32
            };
            MONITOR_POS.store(norm.to_bits(), Ordering::Relaxed);
          }
          // Deferred deactivation: cleared here so the borrows of
          // v.sample / v.track_params don't conflict with the per-frame
          // loop's reads. Either the sample ran past its end OR a
          // monophonic choke ran out OR the ADSR release tail
          // completed; any of those flips `deactivate`.
          if deactivate {
            v.active = false;
            v.sample = None;
            v.track_params = None;
          }
        }

        // 4) Mangler FX bus (tape → glitch → drive) + parallel reverb
        // send/return. fx_send feeds the mangler (a wet/dry crossfade,
        // dry_scale = 1 - fx_send above); reverb is NO LONGER on this bus —
        // it's a separate aux fed by the per-instrument reverb_send tap.
        // The mangler is skipped when fx_bypass is on; the reverb return is
        // independent of fx_bypass. Output channel pair depends on multi_out:
        // OFF → 0+1 stereo (monitor fold); ON → fx_out_first / fx_out_stereo.
        let r = reverb_state();
        let size = f32::from_bits(r.size.load(Ordering::Relaxed));
        let diffusion = f32::from_bits(r.diffusion.load(Ordering::Relaxed));
        let damping = f32::from_bits(r.damping.load(Ordering::Relaxed));
        reverb_bus.set_size(size);
        reverb_bus.set_diffusion(diffusion);
        reverb_bus.set_damping(damping);
        // 100% wet at unity return — reverb is a pure send/return now, no wet/dry
        // and no return-level control. Per-instrument reverb_send is the only
        // amount control. (ReverbState.wet_gain is no longer read here; the
        // master "mix" knob was removed.)
        reverb_bus.set_mix(1.0);

        // Tape stage (first in the mangler bus, ahead of drive). Always
        // captures the bus input even at mix=0 so the ring stays warm.
        // Replaces fxbus_l/r in place with the (1-mix)·input + mix·bed
        // blend — the downstream drive then operates on what tape emitted.
        if !fx_bypass_now && rev_frames > 0 {
          let t = tape_state();
          let position = f32::from_bits(t.position.load(Ordering::Relaxed));
          let length = f32::from_bits(t.length.load(Ordering::Relaxed));
          let stretches = [
            f32::from_bits(t.stretch1.load(Ordering::Relaxed)),
            f32::from_bits(t.stretch2.load(Ordering::Relaxed)),
          ];
          let gains = [
            f32::from_bits(t.gain1.load(Ordering::Relaxed)),
            f32::from_bits(t.gain2.load(Ordering::Relaxed)),
          ];
          let tape_mix = f32::from_bits(t.mix.load(Ordering::Relaxed));
          let reverse = t.reverse.load(Ordering::Acquire);
          let hold = t.hold.load(Ordering::Acquire);
          let grain_rate = f32::from_bits(t.grain_rate.load(Ordering::Relaxed));
          let grain_mix = f32::from_bits(t.grain_mix.load(Ordering::Relaxed));
          tape_buffer.process_block(
            &mut fxbus_l[..rev_frames],
            &mut fxbus_r[..rev_frames],
            rev_frames,
            position,
            length,
            stretches,
            gains,
            tape_mix,
            reverse,
            hold,
            grain_rate,
            grain_mix,
          );
        }

        // Glitch stage — sits between tape and drive. Stutters /
        // reverses / pitch-shifts the FX bus signal in random modes
        // on beat-aligned fire commands from JS. AcqRel swap on the
        // shared flag so multiple fires queued faster than blocks
        // can land collapse to one (acceptable — beats >> blocks).
        if !fx_bypass_now && rev_frames > 0 {
          let g = glitch_state();
          let glitch_mix = f32::from_bits(g.mix.load(Ordering::Relaxed));
          // One-shot fire flags are consumed by the CURRENT stream only —
          // a zombie callback stealing the swap would eat the fire.
          let mut fired = is_current_stream
            && g.fire_requested.swap(false, Ordering::AcqRel);
          // Beat-aligned fire: consume the absolute deadline once the
          // block containing it arrives. A stale/late deadline (behind
          // this block) still fires — better late by a block than never.
          if is_current_stream {
            let fire_at = g.fire_at_frame.load(Ordering::Acquire);
            if fire_at != GLITCH_FIRE_NONE && fire_at < block_end_frame {
              g.fire_at_frame.store(GLITCH_FIRE_NONE, Ordering::Release);
              fired = true;
            }
          }
          glitch_machine.process_block(
            &mut fxbus_l[..rev_frames],
            &mut fxbus_r[..rev_frames],
            rev_frames,
            glitch_mix,
            fired,
          );
        }

        // Mangler drive — tanh waveshaper colouring the mangler bus, same
        // curve as web saturation.ts. (No longer "pre-reverb": reverb is its
        // own send now and isn't fed by this.)
        if !fx_bypass_now && rev_frames > 0 {
          let sat = saturation_state();
          let drive = f32::from_bits(sat.pre_drive.load(Ordering::Relaxed));
          if drive > 0.001 {
            for frame in 0..rev_frames {
              fxbus_l[frame] = pre_saturate_sample(fxbus_l[frame], drive);
              fxbus_r[frame] = pre_saturate_sample(fxbus_r[frame], drive);
            }
          }
        }

        // Stems: snapshot the mangler bus (tape → glitch → drive) NOW, before
        // the reverb/delay returns fold in below, so the fx stem is the
        // mangler contribution alone. copy overwrites — no per-block clear.
        if fx_rec_producer.is_some() {
          fx_stem_l[..rev_frames].copy_from_slice(&fxbus_l[..rev_frames]);
          fx_stem_r[..rev_frames].copy_from_slice(&fxbus_r[..rev_frames]);
        }

        // Reverb send/return — parallel aux, independent of the mangler's
        // fx_bypass. Process the per-instrument send bus fully wet and fold the
        // tail INTO the mangler bus at unity so a single routing pass below
        // places both into the fx-out pair. Always runs (no return-level gate)
        // so tails ring out after the sending voices stop; the reverb DSP is
        // cheap on silence once a tail has decayed.
        if rev_frames > 0 {
          reverb_bus.process_block(
            &rev_send_l[..rev_frames],
            &rev_send_r[..rev_frames],
            &mut reverb_out_l[..rev_frames],
            &mut reverb_out_r[..rev_frames],
          );
          // The tank is recursive — one non-finite sample latches it dead
          // until Panic (delay + master already self-heal; this was the
          // last unguarded feedback path). Probe the block head and flush
          // the bus on poison instead of folding it into the mix.
          if !(reverb_out_l[0].is_finite() && reverb_out_r[0].is_finite()) {
            reverb_bus.clear();
            reverb_out_l[..rev_frames].fill(0.0);
            reverb_out_r[..rev_frames].fill(0.0);
          }
          for frame in 0..rev_frames {
            fxbus_l[frame] += reverb_out_l[frame];
            fxbus_r[frame] += reverb_out_r[frame];
          }
        }

        // Delay send/return — sibling of the reverb aux. Process the
        // per-instrument delay send bus through the global ping-pong delay
        // (100% wet) and fold the wet output INTO the mangler bus at unity for
        // the single routing pass below. Time is the synced seconds JS pushed.
        if rev_frames > 0 {
          let d = delay_state();
          delay_bus.process_block(
            &delay_send_l[..rev_frames],
            &delay_send_r[..rev_frames],
            &mut delay_out_l[..rev_frames],
            &mut delay_out_r[..rev_frames],
            rev_frames,
            d.delay_seconds(),
            d.feedback(),
            d.pingpong(),
            d.lofi(),
          );
          for frame in 0..rev_frames {
            fxbus_l[frame] += delay_out_l[frame];
            fxbus_r[frame] += delay_out_r[frame];
          }
        }

        // Output the fx bus (mangler + folded-in reverb return) at unit gain.
        // Runs whenever there are frames — NOT gated by fx_bypass — so a reverb
        // tail still rings out even with the mangler bypassed (fx_send=0 under
        // bypass already leaves the mangler contribution silent).
        if rev_frames > 0 {
          // Same multi-out fallback as voice routing: if the fx-out pair
          // falls off the end of the device, fold to 0/1 so the bus stays
          // audible on a smaller interface than the config was authored for.
          let needed_channels = if fx_out_stereo { 2 } else { 1 };
          let fx_in_range = fx_out_first.saturating_add(needed_channels) <= n_ch;
          let (out_first, out_stereo) = if multi_out_now && fx_in_range {
            (fx_out_first, fx_out_stereo)
          } else {
            (0usize, true)
          };
          if out_stereo {
            let l_idx = out_first;
            let r_idx = out_first + 1;
            if l_idx < n_ch {
              for frame in 0..rev_frames {
                buf[frame * n_ch + l_idx] += fxbus_l[frame];
              }
            }
            if r_idx < n_ch {
              for frame in 0..rev_frames {
                buf[frame * n_ch + r_idx] += fxbus_r[frame];
              }
            }
          } else if out_first < n_ch {
            // Mono fx out — sum L+R*0.5 into a single channel.
            for frame in 0..rev_frames {
              let mono = 0.5 * (fxbus_l[frame] + fxbus_r[frame]);
              buf[frame * n_ch + out_first] += mono;
            }
          }
        }

        // 5) Loop/resample capture unit. ORDER MATTERS: the ring taps
        // the pre-master mix FIRST, then loop playback injects — so the
        // ring never contains the loops themselves (output-only, like the
        // Bluebox: captures can't eat earlier captures). Injection lands
        // BEFORE the master stage and the recorder taps below, so the
        // units get mastered and recordings include them. Gen-guarded
        // like the engine clock — a zombie stream must not write the
        // ring.
        if is_current_stream {
          let ring_len = loop_ring_l.len();
          for frame in 0..frames {
            let abs = block_start_frame + frame as u64;
            let w = (abs % ring_len as u64) as usize;
            let l = buf[frame * n_ch];
            let r = if n_ch >= 2 { buf[frame * n_ch + 1] } else { l };
            loop_ring_l[w] = l;
            loop_ring_r[w] = r;
          }
          // Loop→noise routing, decided per block. INS = Loop A routes
          // THROUGH the noise chain (direct injection suppressed; the
          // bounce prints the post-noise signal). PAR feeds the chain the
          // same way but leaves the direct injection alone — send/return
          // instead of insert. noise level 0 = implicit bypass (loop
          // injects direct again).
          let noise_inserted = noise_source == 0 && noise_level > 0.001;
          let sframes = frames.min(REVERB_SCRATCH);
          loop_send_l[..sframes].fill(0.0);
          loop_send_r[..sframes].fill(0.0);
          if loop_active && loop_len > 0 {
            // P2 read engine (Morphagene/ADDAC flavor). Two regimes:
            //  - TAPE (size ≥ 0.98): vari-speed head at `speed`, thru-zero
            //    (negative = reverse, |speed| < 0.02 = stopped tape =
            //    silence), pitch follows speed. At exactly 1.0 this is
            //    P1's bar-locked playback.
            //  - GRAIN (size < 0.98): the playhead crawls at `speed`;
            //    windowed grains (parabolic window — no trig on the hot
            //    path) spawn on a countdown at the playhead + scan offset,
            //    each reading at rate `speed` (thru-zero pitch). At
            //    stopped speed grains read at native pitch — the frozen
            //    drone. Morph = overlap (1..4 voices) + position spray
            //    past 0.5.
            let len_f = loop_len as f64;
            let stopped = loop_speed.abs() < 0.02;
            // Grain size is FULL-RANGE (mix owns the tape↔grain balance):
            // exponential 20ms..~1.8s, clamped to the loop and floored so
            // a window always has shape.
            let grain_dur = {
              let t = loop_size.clamp(0.0, 1.0) as f64;
              let secs = 0.02 * 90.0_f64.powf(t);
              (secs * sr_f32 as f64).min(len_f).max(64.0)
            };
            // Independent layer levels — tape loop and grain cloud are
            // two modules over the same capture, each with its own return.
            let g_tape = loop_tape_level;
            let g_grain = loop_grain_level;
            let tape_on = g_tape > 0.001;
            let grains_on = g_grain > 0.001;
            // Position deviation: ±half-loop at full — wrap makes the
            // start point truly uniform over the loop at random = 1.
            let random_amt = (loop_random as f64) * 0.5 * len_f;
            let spawn_interval = loop_spawn_frames.max(32.0) as f64;
            // Overlap gain compensation — estimate concurrent grains from
            // duration/interval, capped by the voice count; stacked windows
            // otherwise pump the level way past the source.
            let concurrent =
              (grain_dur / spawn_interval).clamp(1.0, loop_grain_count as f64);
            let grain_norm = (1.0 / concurrent.sqrt()) as f32;
            for frame in 0..frames {
              let abs = block_start_frame + frame as u64;
              if abs < loop_anchor {
                continue;
              }
              loop_pos = loop_wrap(loop_pos + loop_speed as f64, len_f);
              let mut l = 0.0f32;
              let mut r = 0.0f32;
              if tape_on {
                if loop_lock {
                  // Pitch-locked OLA: heads spawn every half-window at the
                  // playhead and read forward at native pitch; triangular
                  // windows at 50% overlap sum to unity. Runs even at
                  // stopped speed (frozen slice — deliberate).
                  let w_frames = (sr_f32 as f64 * 0.085).max(256.0);
                  let hop = w_frames * 0.5;
                  loop_ola_countdown -= 1.0;
                  if loop_ola_countdown <= 0.0 {
                    loop_ola_countdown = hop;
                    loop_ola[loop_ola_next] = (loop_pos, 0.0);
                    loop_ola_next = (loop_ola_next + 1) % 2;
                  }
                  let mut tl = 0.0f32;
                  let mut tr = 0.0f32;
                  for (hpos, hphase) in loop_ola.iter_mut() {
                    if *hphase < 0.0 {
                      continue;
                    }
                    let t = *hphase / w_frames;
                    let w = (1.0 - (2.0 * t - 1.0).abs()) as f32;
                    let p = loop_wrap(*hpos + *hphase, len_f);
                    tl += loop_read(&loop_buf_l, loop_len, p) * w;
                    tr += loop_read(&loop_buf_r, loop_len, p) * w;
                    *hphase += 1.0;
                    if *hphase >= w_frames {
                      *hphase = -1.0;
                    }
                  }
                  l += tl * g_tape;
                  r += tr * g_tape;
                } else if !stopped {
                  l += loop_read(&loop_buf_l, loop_len, loop_pos) * g_tape;
                  r += loop_read(&loop_buf_r, loop_len, loop_pos) * g_tape;
                }
              }
              if grains_on {
                if (abs as f64) >= loop_next_spawn {
                  // Schedule the next spawn: synced mode anchors to the
                  // capture's bar grid (loop_anchor IS a bar boundary), so
                  // spawns land ON the grid; free mode just steps forward.
                  // rate_dev jitters around either.
                  let base_next = if loop_rate_synced {
                    let rel = (abs - loop_anchor) as f64;
                    loop_anchor as f64
                      + ((rel / spawn_interval).floor() + 1.0) * spawn_interval
                  } else {
                    abs as f64 + spawn_interval
                  };
                  loop_next_spawn = base_next;
                  // Pick a slot within the first `loop_grain_count`: a free
                  // one, else steal the OLDEST (highest phase) — a spawn
                  // must always sound, and stealing the nearly-finished
                  // grain is the least audible cut.
                  let window = &mut loop_grains[..loop_grain_count];
                  let slot = match window.iter().position(|g| !g.active) {
                    Some(i) => i,
                    None => {
                      let mut oldest = 0;
                      for (i, g) in window.iter().enumerate() {
                        if g.phase / g.dur > window[oldest].phase
                          / window[oldest].dur
                        {
                          oldest = i;
                        }
                      }
                      oldest
                    }
                  };
                  // One bipolar roll per deviated control — every grain
                  // is its own event when the deviations are up (ADDAC
                  // 112's per-control deviation concept).
                  let mut roll = || {
                    loop_rng ^= loop_rng << 13;
                    loop_rng ^= loop_rng >> 17;
                    loop_rng ^= loop_rng << 5;
                    (loop_rng as f64 / u32::MAX as f64) * 2.0 - 1.0
                  };
                  let jitter = if random_amt > 0.0 { roll() * random_amt } else { 0.0 };
                  let dur_g = if loop_size_dev > 0.0 {
                    (grain_dur * 4.0_f64.powf(roll() * loop_size_dev as f64))
                      .clamp(64.0, len_f)
                  } else {
                    grain_dur
                  };
                  // FOLLOW chains grain pitch to the playhead (tape);
                  // a fixed pitch decouples them — timestretch.
                  let base_rate = if loop_pitch != 0.0 {
                    loop_pitch as f64
                  } else if stopped {
                    1.0
                  } else {
                    loop_speed as f64
                  };
                  // Pitch deviation is QUANTIZED to fifths and octaves
                  // (Chris's call — musical scatter, not detune haze): the
                  // deviation amount opens the interval ladder, and each
                  // grain rolls a uniform pick from what's open. Full dev =
                  // ±2 octaves in fifth/octave steps.
                  const DEV_INTERVALS: [f64; 9] =
                    [0.0, 7.0, -7.0, 12.0, -12.0, 19.0, -19.0, 24.0, -24.0];
                  let rate_g = if loop_pitch_dev > 0.0 {
                    let max_idx = ((loop_pitch_dev as f64)
                      * (DEV_INTERVALS.len() - 1) as f64)
                      .round() as usize;
                    let pick =
                      ((roll().abs()) * (max_idx as f64 + 1.0)) as usize;
                    let semis = DEV_INTERVALS[pick.min(max_idx)];
                    base_rate * 2.0_f64.powf(semis / 12.0)
                  } else {
                    base_rate
                  };
                  if loop_rate_dev > 0.0 {
                    loop_next_spawn +=
                      roll() * loop_rate_dev as f64 * 0.9 * spawn_interval;
                  }
                  let g = &mut window[slot];
                  g.active = true;
                  g.start = loop_wrap(loop_pos + jitter, len_f);
                  g.phase = 0.0;
                  g.dur = dur_g;
                  g.rate = rate_g;
                }
                let mut gl = 0.0f32;
                let mut gr = 0.0f32;
                for g in loop_grains.iter_mut() {
                  if !g.active {
                    continue;
                  }
                  let t = (g.phase / g.dur) as f32;
                  let w = 4.0 * t * (1.0 - t); // parabolic window
                  let p = loop_wrap(g.start + g.phase * g.rate, len_f);
                  gl += loop_read(&loop_buf_l, loop_len, p) * w;
                  gr += loop_read(&loop_buf_r, loop_len, p) * w;
                  g.phase += 1.0;
                  if g.phase >= g.dur {
                    g.active = false;
                  }
                }
                l += gl * grain_norm * g_grain;
                r += gr * grain_norm * g_grain;
              }
              let out_l = l * loop_gain;
              let out_r = r * loop_gain;
              // Stash for the noise unit (insert routing) and the bounce
              // tap, which now lives downstream of the routing.
              if frame < REVERB_SCRATCH {
                loop_send_l[frame] = out_l;
                loop_send_r[frame] = out_r;
                // Unit → FX sends (pre-routing tap: fires even when the
                // dry path is inserted into the noise unit).
                units_fx_carry_l[frame] += out_l * loop_fx_send;
                units_fx_carry_r[frame] += out_r * loop_fx_send;
                units_rev_carry_l[frame] += out_l * loop_rev_send;
                units_rev_carry_r[frame] += out_r * loop_rev_send;
                units_del_carry_l[frame] += out_l * loop_del_send;
                units_del_carry_r[frame] += out_r * loop_del_send;
              }
              if !noise_inserted {
                if n_ch >= 2 {
                  buf[frame * n_ch] += out_l;
                  buf[frame * n_ch + 1] += out_r;
                } else {
                  buf[frame * n_ch] += 0.5 * (out_l + out_r);
                }
              }
            }
            // Publish viz once per block: playhead fraction + per-grain
            // (position, window level). Relaxed — a picture, not a clock.
            LOOP_VIZ_POS.store(
              ((loop_pos / len_f) as f32).to_bits(),
              Ordering::Relaxed,
            );
            // Bounce progress — 0 while waiting for the bar grid, fraction
            // while printing, -1 when idle (completion published here too:
            // the tuple is None by the time this block ends).
            let bounce_prog = match loop_bounce.as_ref() {
              Some((_, remaining, total, _, _)) => {
                if loop_bounce_started && *total > 0 {
                  1.0 - (*remaining as f32 / *total as f32)
                } else {
                  0.0
                }
              }
              None => -1.0,
            };
            LOOP_VIZ_BOUNCE.store(bounce_prog.to_bits(), Ordering::Relaxed);
            for (i, g) in loop_grains.iter().enumerate() {
              let (pos, env) = if g.active && grains_on {
                let t = (g.phase / g.dur) as f32;
                (
                  (loop_wrap(g.start + g.phase * g.rate, len_f) / len_f)
                    as f32,
                  4.0 * t * (1.0 - t),
                )
              } else {
                (-1.0, 0.0)
              };
              LOOP_VIZ_GRAINS[i * 2].store(pos.to_bits(), Ordering::Relaxed);
              LOOP_VIZ_GRAINS[i * 2 + 1]
                .store(env.to_bits(), Ordering::Relaxed);
            }
          }

          // ---- NOISE unit (Mörser-shaped) ------------------------------
          // Runs whenever its return level is up — WITH or WITHOUT a
          // capture (empty = the clocked noise alone through the filter,
          // the Mörser self-sounding trick). Placed after the ring tap, so
          // like the loop unit its output is never re-captured.
          if noise_level > 0.001 {
            let sr_f = sr_f32.max(1.0);
            // Cutoff base: log map 40..12k; clock-held jitter shifts it in
            // octaves (the noise→CV normalling). Recomputed on clock ticks.
            let fc_of = |jit: f32| -> f32 {
              let base = 40.0 * 300.0_f32.powf(noise_cutoff);
              (base * 2.0_f32.powf(jit * noise_cv * 2.0))
                .clamp(30.0, (sr_f * 0.24).min(14000.0))
            };
            // Coefficient for the 2x-OVERSAMPLED inner loop (two half-steps
            // per sample) — the plain Chamberlin falls into a Nyquist limit
            // cycle above ~sr/6, which read as "cranking the filter kills
            // the output". Half-stepping keeps the full range stable.
            let mut f_coef = 2.0
              * (std::f32::consts::PI * fc_of(noise_jit) / (2.0 * sr_f)).sin();
            // Per-channel damping from res ± width — the stereo
            // instability. res→1 = edge of self-oscillation; the tanh in
            // the loop keeps a scream musical instead of exploding.
            let damp = |r: f32| 2.0 * (1.0 - r.clamp(0.0, 0.98));
            let q_l = damp(noise_res + noise_width * 0.5);
            let q_r = damp(noise_res - noise_width * 0.5);
            let clk_interval = noise_clock_frames.max(4.0) as f64;
            let in_gain = 1.0 + noise_drive * 23.0;
            // Ping decay ~4ms — short enough that slow clocks read as
            // discrete dots, long enough to kick the resonance.
            let ping_decay = (-1.0 / (0.004 * sr_f)).exp();
            let nlen_f = noise_len as f64;
            for frame in 0..frames {
              let abs = block_start_frame + frame as u64;
              // Source per selector: Loop A's output (INS insert / PAR
              // parallel — same feed, routing differs downstream), own
              // capture at vari-speed, or nothing (self-sounding). Read
              // FIRST — the signal clock may need this frame's input.
              let (mut xl, mut xr) = (0.0f32, 0.0f32);
              match noise_source {
                0 | 1 => {
                  if frame < REVERB_SCRATCH {
                    xl = loop_send_l[frame];
                    xr = loop_send_r[frame];
                  }
                }
                2 => {
                  if noise_capture_active
                    && noise_len > 0
                    && noise_speed.abs() >= 0.02
                    && abs >= noise_anchor
                  {
                    noise_pos =
                      loop_wrap(noise_pos + noise_speed as f64, nlen_f);
                    xl = loop_read(&noise_buf_l, noise_len, noise_pos);
                    xr = loop_read(&noise_buf_r, noise_len, noise_pos);
                  }
                }
                _ => {}
              }
              // Clock decision. Timer mode: absolute next-tick frame
              // (bar-grid anchored when synced). SIGNAL mode (Spektrum):
              // ticks from the clock-source's zero crossings through a
              // divider — the clock rate IS the material's pitch and
              // brightness; silence stops the clock dead. Hysteresis
              // (sens) keeps the noise floor from clocking it.
              let mut do_tick = false;
              if noise_clock_mode == 1 {
                let cs = match noise_clock_src {
                  0 => 0.5 * (xl + xr),
                  1 => {
                    if frame < REVERB_SCRATCH {
                      0.5 * (loop_send_l[frame] + loop_send_r[frame])
                    } else {
                      0.0
                    }
                  }
                  _ => {
                    if n_ch >= 2 {
                      0.5 * (buf[frame * n_ch] + buf[frame * n_ch + 1])
                    } else {
                      buf[frame * n_ch]
                    }
                  }
                };
                let thr = 0.005 + noise_sens * 0.12;
                let sign_now: i8 = if cs > thr {
                  1
                } else if cs < -thr {
                  -1
                } else {
                  0
                };
                if sign_now != 0 {
                  if noise_xing_sign != 0 && sign_now != noise_xing_sign {
                    noise_xing_count += 1;
                    if noise_xing_count >= noise_clock_div {
                      noise_xing_count = 0;
                      do_tick = true;
                    }
                  }
                  noise_xing_sign = sign_now;
                }
              } else if (abs as f64) >= noise_next_clock {
                do_tick = true;
                noise_next_clock = if noise_clock_synced {
                  let anchor = if noise_capture_active {
                    noise_anchor
                  } else {
                    loop_anchor
                  };
                  let rel = abs.saturating_sub(anchor) as f64;
                  anchor as f64
                    + ((rel / clk_interval).floor() + 1.0) * clk_interval
                } else {
                  abs as f64 + clk_interval
                };
              }
              if do_tick {
                // HARD LFSR bits, not smoothed random — ±1 held values
                // are the digital hash; at audio-rate clocks this is a
                // pitched bitstream (the Mörser noise color).
                let mut bit = || {
                  noise_rng ^= noise_rng << 13;
                  noise_rng ^= noise_rng >> 17;
                  noise_rng ^= noise_rng << 5;
                  noise_rng & 1 != 0
                };
                let b_l = bit();
                let b_r = bit();
                // Fire a ping only on a TRANSITION — irregular flip runs
                // are the morse rhythm. Polarity follows the new bit.
                if b_l != noise_bit_l {
                  noise_ping_l = if b_l { 1.0 } else { -1.0 };
                  noise_bit_l = b_l;
                  NOISE_VIZ_PING[0].store(1.0f32.to_bits(), Ordering::Relaxed);
                }
                if b_r != noise_bit_r {
                  noise_ping_r = if b_r { 1.0 } else { -1.0 };
                  noise_bit_r = b_r;
                  NOISE_VIZ_PING[1].store(1.0f32.to_bits(), Ordering::Relaxed);
                }
                // Cutoff jitter keeps a graded value (bit pairs → 4 steps)
                // so cv reads as stepped CV, not pure square FM.
                let j = ((noise_rng >> 1) & 3) as f32 / 1.5 - 1.0;
                noise_jit = j;
                f_coef = 2.0
                  * (std::f32::consts::PI * fc_of(noise_jit) / (2.0 * sr_f))
                    .sin();
              }
              // Edge pings, decaying between clock ticks — not held DC.
              xl = (xl + noise_ping_l * noise_amt * 1.4) * in_gain;
              xr = (xr + noise_ping_r * noise_amt * 1.4) * in_gain;
              noise_ping_l *= ping_decay;
              noise_ping_r *= ping_decay;
              // WASP-grit Chamberlin SVF — the CMOS misbehavior lives in
              // three places: input DRIVE (level-sensitivity: pushing the
              // filter IS the sound), an ASYMMETRIC nonlinearity in the
              // loop (even harmonics, like a mis-biased inverter), and
              // resonance SQUELCH (damping rises with signal level, so
              // the resonance chokes under load instead of ringing clean).
              let asym = |v: f32| (v + 0.14 * v * v).tanh();
              // 2x-oversampled loop: two half-steps per sample. Leaky lp
              // integrator bleeds off the DC the asymmetric clipper
              // injects, so the filter can't latch.
              let (mut lp_l, mut bp_l) = noise_svf[0];
              let (mut lp_r, mut bp_r) = noise_svf[1];
              for _ in 0..2 {
                let sq_l = q_l * (1.0 + 0.6 * bp_l.abs());
                lp_l = (lp_l + f_coef * bp_l) * 0.9995;
                let hp_l = xl - lp_l - sq_l * bp_l;
                bp_l = asym(bp_l + f_coef * hp_l);
                let sq_r = q_r * (1.0 + 0.6 * bp_r.abs());
                lp_r = (lp_r + f_coef * bp_r) * 0.9995;
                let hp_r = xr - lp_r - sq_r * bp_r;
                bp_r = asym(bp_r + f_coef * hp_r);
              }
              noise_svf[0] = (lp_l, bp_l);
              noise_svf[1] = (lp_r, bp_r);
              let (raw_l, raw_r) = if noise_mode == 0 {
                (lp_l, lp_r)
              } else {
                (bp_l, bp_r)
              };
              // DC blocker (~10Hz one-pole) ahead of the output stage —
              // a residual offset would otherwise saturate the output
              // tanh into a constant and read as silence.
              let (x1_l, y1_l) = noise_dcb[0];
              let tap_l = raw_l - x1_l + 0.995 * y1_l;
              noise_dcb[0] = (raw_l, tap_l);
              let (x1_r, y1_r) = noise_dcb[1];
              let tap_r = raw_r - x1_r + 0.995 * y1_r;
              noise_dcb[1] = (raw_r, tap_r);
              // Always-on distortion — DE philosophy, no blend knob.
              let comp = 1.0 / (1.0 + noise_drive * 1.5);
              let sat_l = (tap_l * 2.2 * comp).tanh() * 0.9;
              let sat_r = (tap_r * 2.2 * comp).tanh() * 0.9;
              let out_l = sat_l * noise_level;
              let out_r = sat_r * noise_level;
              // Scope tap — mono sum of the pre-level saturator output,
              // decimated to min/max columns in the lock-free ring.
              let mono = 0.5 * (sat_l + sat_r);
              noise_scope_min = noise_scope_min.min(mono);
              noise_scope_max = noise_scope_max.max(mono);
              noise_scope_n += 1;
              if noise_scope_n >= NOISE_SCOPE_DECIM {
                noise_scope_push(noise_scope_min, noise_scope_max);
                noise_scope_min = 0.0;
                noise_scope_max = 0.0;
                noise_scope_n = 0;
              }
              if n_ch >= 2 {
                buf[frame * n_ch] += out_l;
                buf[frame * n_ch + 1] += out_r;
              } else {
                buf[frame * n_ch] += 0.5 * (out_l + out_r);
              }
              // The bounce scratch carries the chain's TOTAL output in
              // every routing: inserted → the noise out REPLACES the loop
              // signal (which was suppressed from direct injection);
              // par/cap/off → it ADDS on top of the loop's direct out.
              // SAVE always prints what these two units produce together —
              // "the saved file is basically silent" (cap/off setups
              // weren't taped at all) was the bug.
              if frame < REVERB_SCRATCH {
                if noise_inserted {
                  loop_send_l[frame] = out_l;
                  loop_send_r[frame] = out_r;
                } else {
                  loop_send_l[frame] += out_l;
                  loop_send_r[frame] += out_r;
                }
                units_fx_carry_l[frame] += out_l * noise_fx_send;
                units_fx_carry_r[frame] += out_r * noise_fx_send;
                units_rev_carry_l[frame] += out_l * noise_rev_send;
                units_rev_carry_r[frame] += out_r * noise_rev_send;
                units_del_carry_l[frame] += out_l * noise_del_send;
                units_del_carry_r[frame] += out_r * noise_del_send;
              }
            }
            // LED persistence decay, once per block (~100ms fall).
            for led in NOISE_VIZ_PING.iter() {
              let v = f32::from_bits(led.load(Ordering::Relaxed)) * 0.90;
              led.store(v.to_bits(), Ordering::Relaxed);
            }
          } else {
            // Bypassed — keep the scope scrolling so it drains to a flat
            // line instead of freezing the last active content.
            noise_scope_min = 0.0;
            noise_scope_max = 0.0;
            noise_scope_n += frames as u32;
            while noise_scope_n >= NOISE_SCOPE_DECIM {
              noise_scope_n -= NOISE_SCOPE_DECIM;
              noise_scope_push(0.0, 0.0);
            }
          }

          // Bounce pass — prints the final loop-chain signal from the
          // scratch (post-noise when inserted). Same bar-grid wait and
          // self-stop as before, relocated downstream of the routing.
          if loop_bounce.is_some() {
            let mut bounce_done = false;
            for frame in 0..sframes {
              let abs = block_start_frame + frame as u64;
              if let Some((prod, remaining, _total, align, stop)) =
                loop_bounce.as_mut()
              {
                if !loop_bounce_started
                  && abs.saturating_sub(loop_anchor) % (*align).max(1) == 0
                {
                  loop_bounce_started = true;
                }
                if loop_bounce_started {
                  let _ = prod.try_push(loop_send_l[frame]);
                  let _ = prod.try_push(loop_send_r[frame]);
                  *remaining = remaining.saturating_sub(1);
                  if *remaining == 0 {
                    stop.store(true, Ordering::Release);
                    bounce_done = true;
                    break;
                  }
                }
              }
            }
            if bounce_done {
              loop_bounce = None;
              loop_bounce_started = false;
            }
          }
        }

        // 5.5) Master stage — final tone-shaping on channels 0+1, at the
        // END of the chain (moved 2026-07-12, was pre-units): the loop
        // and noise units inject above, so the global EQ/comp/drive/gate
        // shape them too — "cut the highs" reaches the noise unit. The
        // capture ring therefore holds the PRE-master mix and captures
        // get mastered live on playback — one master pass either way,
        // and master moves made after a capture now affect held loops.
        // In multi-out mode the master chain is SKIPPED ENTIRELY:
        // per-voice stems on higher channels stay pre-master AND the
        // FX-bus pair stays pre-master too, so the DAW (or FOH) drives
        // its own master.
        if !multi_out_now {
          let ms = master_state();
          let input = master_input_linear(f32::from_bits(
            ms.input.load(Ordering::Relaxed),
          ));
          let lo_cut_idx =
            master_lo_cut_index(ms.lo_cut.load(Ordering::Relaxed));
          let hi_cut_hz = master_hi_cut_hz(f32::from_bits(
            ms.hi_cut.load(Ordering::Relaxed),
          ));
          let trim = master_trim_linear(f32::from_bits(
            ms.trim.load(Ordering::Relaxed),
          ));
          let comp_amount = f32::from_bits(ms.comp_amount.load(Ordering::Relaxed));
          let comp_attack_ms = MASTER_COMP_ATTACK_MS[(ms
            .comp_attack
            .load(Ordering::Relaxed) as usize)
            .min(MASTER_COMP_ATTACK_MS.len() - 1)];
          let comp_release_ms = MASTER_COMP_RELEASE_MS[(ms
            .comp_release
            .load(Ordering::Relaxed) as usize)
            .min(MASTER_COMP_RELEASE_MS.len() - 1)];
          let dist_mode = ms.dist_mode.load(Ordering::Relaxed);
          let dist_drive = f32::from_bits(ms.dist_drive.load(Ordering::Relaxed));
          let dist_bias = f32::from_bits(ms.dist_bias.load(Ordering::Relaxed));
          let dist_mix = f32::from_bits(ms.dist_mix.load(Ordering::Relaxed));
          let gate_enabled = ms.gate_enabled.load(Ordering::Relaxed);
          let gate_threshold_norm =
            f32::from_bits(ms.gate_threshold.load(Ordering::Relaxed));
          let master_bypass = ms.bypass.load(Ordering::Relaxed);
          master_stage.update_filters(lo_cut_idx, hi_cut_hz);
          master_stage.process_block(
            buf,
            frames,
            n_ch,
            input,
            trim,
            comp_amount,
            comp_attack_ms,
            comp_release_ms,
            dist_mode,
            dist_drive,
            dist_bias,
            dist_mix,
            gate_enabled,
            gate_threshold_norm,
            master_bypass,
          );
        }

        // 6) Recorder tap — push the post-master stereo bus into the
        // combined queue + push section scratches into the splits
        // queues, when armed. Producers live in audio-thread-local
        // state (set/cleared via Start/Stop*Recording commands) so no
        // locking happens on the audio thread.
        //
        // Head alignment: drop any frames in this block that precede
        // rec_start_frame so WAV frame 0 = the first musical downbeat (no
        // leading dead-space, on-grid in the DAW). block_start_frame + i =
        // the absolute frame of output frame i. rec_start_frame = 0 (splits /
        // legacy) makes rec_skip 0, i.e. capture from the block start.
        let rec_skip = rec_start_frame.saturating_sub(block_start_frame) as usize;
        let rec_skip_f = rec_skip.min(frames);
        let rec_skip_r = rec_skip.min(rev_frames);
        if let Some(prod) = combined_rec_producer.as_mut() {
          if n_ch >= 2 {
            for frame in rec_skip_f..frames {
              // Best-effort whole-frame push — if the queue is full
              // (worker stalled), drop frames rather than block.
              push_rec_frame(prod, buf[frame * n_ch], buf[frame * n_ch + 1]);
            }
          } else if n_ch == 1 {
            for frame in rec_skip_f..frames {
              let s = buf[frame * n_ch];
              push_rec_frame(prod, s, s);
            }
          }
        }
        // Splits: rhythm + melody scratches (already cleared at block
        // top, accumulated by per-voice section taps above). Pre-FX,
        // pre-master raw voice signal — matches the web splits tap
        // point and gives DAWs a clean stem per section.
        if let Some(prod) = rhythm_rec_producer.as_mut() {
          for frame in rec_skip_r..rev_frames {
            push_rec_frame(prod, rhythm_l[frame], rhythm_r[frame]);
          }
        }
        if let Some(prod) = melody_rec_producer.as_mut() {
          for frame in rec_skip_r..rev_frames {
            push_rec_frame(prod, melody_l[frame], melody_r[frame]);
          }
        }
        // Full-stems tap. master = post-master buf (same as combined but its
        // own producer so the whole set shares one lifecycle); fx = mangler
        // snapshot; reverb/delay = the wet returns (process_block filled these
        // this block); stems[i] = per-track dry. All sample-locked.
        if let Some(prod) = master_rec_producer.as_mut() {
          if n_ch >= 2 {
            for frame in rec_skip_f..frames {
              push_rec_frame(prod, buf[frame * n_ch], buf[frame * n_ch + 1]);
            }
          } else if n_ch == 1 {
            for frame in rec_skip_f..frames {
              let s = buf[frame * n_ch];
              push_rec_frame(prod, s, s);
            }
          }
        }
        if let Some(prod) = fx_rec_producer.as_mut() {
          for frame in rec_skip_r..rev_frames {
            push_rec_frame(prod, fx_stem_l[frame], fx_stem_r[frame]);
          }
        }
        if let Some(prod) = reverb_rec_producer.as_mut() {
          for frame in rec_skip_r..rev_frames {
            push_rec_frame(prod, reverb_out_l[frame], reverb_out_r[frame]);
          }
        }
        if let Some(prod) = delay_rec_producer.as_mut() {
          for frame in rec_skip_r..rev_frames {
            push_rec_frame(prod, delay_out_l[frame], delay_out_r[frame]);
          }
        }
        for idx in 0..MAX_STEMS {
          if let Some(prod) = stem_rec_producers[idx].as_mut() {
            for frame in rec_skip_r..rev_frames {
              push_rec_frame(prod, stem_l[idx][frame], stem_r[idx][frame]);
            }
          }
        }

        // Block peak for the visualizer level meter. Computed AFTER all
        // FX + master processing so the meter reflects what the audience
        // actually hears. abs() of all samples in the interleaved buffer
        // is fine — block size × channels is small (256-2048 × 2 ch).
        let mut peak: f32 = 0.0;
        for &s in buf.iter() {
          let a = s.abs();
          if a > peak {
            peak = a;
          }
        }
        AUDIO_OUTPUT_LEVEL.store(peak.to_bits(), Ordering::Relaxed);

        // Advance the engine clock LAST so ENGINE_FRAMES == this block's
        // start frame for the entire callback body above. Current stream
        // only — a zombie callback must never advance the timebase.
        if is_current_stream {
          ENGINE_FRAMES.store(block_end_frame, Ordering::Release);
        }
      },
      move |err| {
        log::error!("[audio] stream error: {}", err);
      },
      None,
    )
    .map_err(|e| format!("build stream: {}", e))?;

  let info = OpenedInfo {
    device_name: actual_name,
    channels,
    sample_rate,
    buffer_size: buffer_size.unwrap_or(0),
  };
  Ok((stream, info))
}

// --- device enumeration ---------------------------------------------------

pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
  let host = cpal::default_host();
  let default_name = host
    .default_output_device()
    .and_then(|d| d.name().ok())
    .unwrap_or_default();

  let mut out: Vec<DeviceInfo> = Vec::new();
  let devices = host
    .output_devices()
    .map_err(|e| format!("enumerate: {}", e))?;
  for d in devices {
    let name = match d.name() {
      Ok(n) => n,
      Err(_) => continue,
    };
    let default_cfg = d.default_output_config().ok();
    let default_sr = default_cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0);
    let default_ch = default_cfg.as_ref().map(|c| c.channels() as u32).unwrap_or(0);

    let mut max_ch = default_ch;
    let mut sr_set: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    let mut min_bs: Option<u32> = None;
    let mut max_bs: Option<u32> = None;
    if default_sr != 0 {
      sr_set.insert(default_sr);
    }
    if let Ok(configs) = d.supported_output_configs() {
      for c in configs {
        if c.channels() as u32 > max_ch {
          max_ch = c.channels() as u32;
        }
        sr_set.insert(c.min_sample_rate().0);
        sr_set.insert(c.max_sample_rate().0);
        if let cpal::SupportedBufferSize::Range { min, max } = c.buffer_size() {
          min_bs = Some(min_bs.map(|cur| cur.min(*min)).unwrap_or(*min));
          max_bs = Some(max_bs.map(|cur| cur.max(*max)).unwrap_or(*max));
        }
      }
    }

    out.push(DeviceInfo {
      is_default: name == default_name,
      name,
      max_output_channels: max_ch,
      default_sample_rate: default_sr,
      supported_sample_rates: sr_set.into_iter().collect(),
      min_buffer_size: min_bs,
      max_buffer_size: max_bs,
    });
  }
  Ok(out)
}

// --- Tauri commands -------------------------------------------------------

#[tauri::command]
pub fn audio_list_output_devices() -> Result<Vec<DeviceInfo>, String> {
  list_devices()
}

#[derive(Debug, Serialize)]
pub struct DeviceDefaultConfig {
  pub sample_rate: u32,
  pub channels: u32,
}

// Lightweight probe for the JS device-rate watch: the named device's (or
// system default's) CURRENT default output config only — no
// supported-config range scans. ASYNC so it runs off the main thread:
// the watch polls every 2s, and a synchronous command doing CoreAudio
// property reads (slow with Bluetooth present) hitched the whole UI at
// poll cadence (2026-07-07, "app is still SUPER sluggish"). Full
// enumeration stays reserved for boot / Settings / actual reopens.
#[tauri::command]
pub async fn audio_device_default_config(
  device_name: String,
) -> Option<DeviceDefaultConfig> {
  let host = cpal::default_host();
  let device = if device_name.is_empty() || device_name == "default" {
    host.default_output_device()?
  } else {
    host
      .output_devices()
      .ok()?
      .find(|d| d.name().map(|n| n == device_name).unwrap_or(false))?
  };
  let cfg = device.default_output_config().ok()?;
  Some(DeviceDefaultConfig {
    sample_rate: cfg.sample_rate().0,
    channels: cfg.channels() as u32,
  })
}

#[tauri::command]
pub fn audio_open_device(
  device_name: String,
  channels: u32,
  sample_rate: u32,
  buffer_size: Option<u32>,
) -> Result<OpenedInfo, String> {
  engine().open(device_name, channels, sample_rate, buffer_size)
}

#[tauri::command]
pub fn audio_close_device() -> Result<(), String> {
  engine().close()
}

#[derive(Debug, Serialize)]
pub struct AudioStatus {
  pub channels: u32,
  pub sample_rate: u32,
}

#[tauri::command]
pub fn audio_status() -> AudioStatus {
  let e = engine();
  AudioStatus {
    channels: e.current_channels(),
    sample_rate: e.current_sample_rate(),
  }
}

// Engine-clock snapshot: absolute frame position of the open stream +
// the device sample rate. Polled once by the JS extrapolator at boot;
// the ~30Hz `audio:time` event (lib.rs) carries the same payload for
// continuous correction.
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct EngineTime {
  pub frames: u64,
  pub sample_rate: u32,
}

pub fn engine_time() -> EngineTime {
  EngineTime {
    frames: engine_frames(),
    sample_rate: engine().current_sample_rate(),
  }
}

#[tauri::command]
pub fn audio_engine_time() -> EngineTime {
  engine_time()
}

#[tauri::command]
pub fn audio_test_tone(channel: Option<usize>, frequency_hz: Option<f32>) -> Result<(), String> {
  let freq = frequency_hz.unwrap_or(440.0);
  engine().set_test_tone(channel, freq);
  Ok(())
}

#[tauri::command]
pub fn audio_load_sample(path: String) -> Result<SampleLoadInfo, String> {
  engine().load_sample(path)
}

#[tauri::command]
pub fn audio_load_sample_from_bytes(
  path: String,
  bytes: Vec<u8>,
) -> Result<SampleLoadInfo, String> {
  engine().load_sample_from_bytes(path, bytes)
}

// Bundled-sample fast path. Replaces the fetch + Uint8Array-as-JSON-array
// IPC that the cold-boot preload used to pay per WAV. The webview's URL
// (`/samples/drums/606/foo.wav`) is resolved to a real filesystem path,
// then `hound` opens it directly — no Vite fetch, no IPC bytes, no decode
// of an in-memory cursor. Registry key stays the URL so existing
// `triggerSample(url, ...)` lookups don't need to change.
//
// Dev: resolves against the source tree at `<cargo manifest>/../public/samples`.
// Production: resolves against `app.path().resource_dir()/samples` —
// requires `bundle.resources` in tauri.conf.json to copy the samples dir
// into the app's Resources at build time.
#[tauri::command]
pub fn audio_load_bundled_sample(
  app: tauri::AppHandle,
  path: String,
) -> Result<SampleLoadInfo, String> {
  let fs_path = resolve_bundled_sample_path(&app, &path)?;
  engine().load_bundled_sample(path, &fs_path)
}

fn resolve_bundled_sample_path(
  app: &tauri::AppHandle,
  url: &str,
) -> Result<std::path::PathBuf, String> {
  use tauri::Manager;
  let rel = url.strip_prefix("/samples/").unwrap_or(url);
  // Production / bundled: resource dir.
  if let Ok(resource_dir) = app.path().resource_dir() {
    let candidate = resource_dir.join("samples").join(rel);
    if candidate.exists() {
      return Ok(candidate);
    }
  }
  // Dev fallback: walk up from the cargo manifest to the source tree.
  let manifest = env!("CARGO_MANIFEST_DIR");
  let dev_path = std::path::Path::new(manifest)
    .parent()
    .ok_or_else(|| "cargo manifest has no parent".to_string())?
    .join("public")
    .join("samples")
    .join(rel);
  if dev_path.exists() {
    return Ok(dev_path);
  }
  Err(format!("bundled sample not found: {}", url))
}

// One trigger's full parameter set as a serde struct — shared by the
// single-shot `audio_trigger_sample` and the batched
// `audio_trigger_batch` (a tick's chord/arp tones in ONE invoke instead
// of N JSON round-trips). Field semantics match the doc comments on
// `MixerCommand::Trigger` / the JS `triggerSample` opts.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerSpec {
  pub path: String,
  pub gain: Option<f32>,
  pub pan: Option<f32>,
  pub pitch: Option<f32>,
  pub out_first: Option<u32>,
  pub out_stereo: Option<bool>,
  pub track_id: Option<String>,
  pub delay_secs: Option<f32>,
  // Absolute ENGINE_FRAMES deadline — the jitter-free scheduling path.
  // Overrides delay_secs when set. f64 over IPC (JS numbers).
  pub target_frame: Option<f64>,
  pub monophonic: Option<bool>,
  pub choke_group: Option<String>,
  pub section: Option<u8>,
  pub is_texture: Option<bool>,
  pub envelope_attack: Option<f32>,
  pub envelope_decay: Option<f32>,
  pub envelope_sustain: Option<f32>,
  pub envelope_release: Option<f32>,
  pub envelope_hold: Option<f32>,
  pub note_id: Option<u64>,
  pub start_frac: Option<f32>,
  pub end_frac: Option<f32>,
  pub loop_mode: Option<u8>,
  pub inst_filter_type: Option<u8>,
  pub inst_cutoff: Option<f32>,
  pub inst_resonance: Option<f32>,
  // Per-instrument saturation drive 0..1 (0/None = bypass), post-filter.
  pub sat_drive: Option<f32>,
  // Per-instrument bit crush 4..16 (16/None = bypass), after saturation.
  pub bit_depth: Option<u8>,
  pub lfo_shape: Option<u8>,
  pub lfo_rate_hz: Option<f32>,
  pub lfo_depth: Option<f32>,
  pub mods: Option<Vec<ModSpecIpc>>,
  pub gran_on: Option<bool>,
  pub gran_grain_ms: Option<f32>,
  pub gran_position: Option<f32>,
  pub gran_shape: Option<u8>,
  pub gran_dir: Option<u8>,
  pub gran_spray: Option<f32>,
  pub wt_on: Option<bool>,
  pub wt_window_frames: Option<f32>,
  pub wt_pos_norm: Option<f32>,
  pub wt_morph: Option<bool>,
  pub wt_hz: Option<f32>,
  // Wavetable smoother (Tracker parity tool): bake + read a smoothed copy.
  pub wt_smooth: Option<bool>,
}

// Resolve a TriggerSpec's defaults and queue it on the mixer ring.
fn queue_trigger(spec: TriggerSpec) -> Result<(), String> {
  let envelope = match (
    spec.envelope_attack,
    spec.envelope_release,
    spec.envelope_hold,
  ) {
    (Some(attack), Some(release), Some(hold)) => Some(EnvelopeSpec {
      attack_secs: attack,
      decay_secs: spec.envelope_decay.unwrap_or(0.0),
      sustain_level: spec.envelope_sustain.unwrap_or(1.0),
      release_secs: release,
      hold_secs: hold,
    }),
    _ => None,
  };
  engine().trigger_sample(
    spec.path,
    spec.gain.unwrap_or(1.0),
    spec.pan.unwrap_or(0.0),
    spec.pitch.unwrap_or(1.0),
    spec.out_first.unwrap_or(0),
    spec.out_stereo.unwrap_or(true),
    spec.track_id,
    spec.delay_secs.unwrap_or(0.0),
    spec
      .target_frame
      .filter(|f| f.is_finite() && *f > 0.0)
      .map(|f| f.round() as u64)
      .unwrap_or(0),
    spec.monophonic.unwrap_or(false),
    spec.choke_group,
    spec.section.unwrap_or(0),
    spec.is_texture.unwrap_or(false),
    envelope,
    spec.note_id.unwrap_or(0),
    spec.start_frac.unwrap_or(0.0),
    spec.end_frac.unwrap_or(1.0),
    spec.loop_mode.unwrap_or(0),
    spec.inst_filter_type.unwrap_or(0),
    spec.inst_cutoff.unwrap_or(1.0),
    spec.inst_resonance.unwrap_or(0.0),
    spec.sat_drive.unwrap_or(0.0),
    spec.bit_depth.unwrap_or(16),
    spec.lfo_shape.unwrap_or(0),
    spec.lfo_rate_hz.unwrap_or(0.0),
    spec.lfo_depth.unwrap_or(0.0),
    spec.mods.unwrap_or_default(),
    spec.gran_on.unwrap_or(false),
    spec.gran_grain_ms.unwrap_or(80.0),
    spec.gran_position.unwrap_or(0.0),
    spec.gran_shape.unwrap_or(0),
    spec.gran_dir.unwrap_or(0),
    spec.gran_spray.unwrap_or(0.0),
    spec.wt_on.unwrap_or(false),
    spec.wt_window_frames.unwrap_or(2048.0),
    spec.wt_pos_norm.unwrap_or(0.0),
    spec.wt_morph.unwrap_or(true),
    spec.wt_hz.unwrap_or(261.63),
    spec.wt_smooth.unwrap_or(false),
  )
}

#[tauri::command]
pub fn audio_trigger_sample(spec: TriggerSpec) -> Result<(), String> {
  queue_trigger(spec)
}

// Batched dispatch — a tick's simultaneous triggers (chord tones, arp
// spread) in one IPC. Each spec still carries its own target_frame, so
// batching changes serialization cost only, not timing semantics.
#[tauri::command]
pub fn audio_trigger_batch(triggers: Vec<TriggerSpec>) -> Result<(), String> {
  // One bad spec (e.g. an unloaded sample path) must not drop the rest of
  // the tick's tones — queue everything, report the first error.
  let mut first_err: Option<String> = None;
  for spec in triggers {
    if let Err(e) = queue_trigger(spec) {
      first_err.get_or_insert(e);
    }
  }
  match first_err {
    Some(e) => Err(e),
    None => Ok(()),
  }
}

#[tauri::command]
pub fn audio_release_note(note_id: u64, fade_secs: Option<f32>) -> Result<(), String> {
  engine().release_note(note_id, fade_secs.unwrap_or(0.0))
}

// Editor playhead. The instrument editor sets the note_id of its preview
// voice so the audio thread publishes that voice's read position; clearing
// (note_id 0) also resets the published position to "none" (-1).
#[tauri::command]
pub fn audio_set_monitor_voice(note_id: u64) {
  MONITOR_NOTE_ID.store(note_id, Ordering::Relaxed);
  if note_id == 0 {
    MONITOR_POS.store((-1.0_f32).to_bits(), Ordering::Relaxed);
    MONITOR_WT_SCAN.store((-1.0_f32).to_bits(), Ordering::Relaxed);
  } else {
    // Reset the wt scan to "none" until the (possibly wt) voice publishes one —
    // so a non-wt monitored voice leaves it negative and the editor falls back
    // to the set position rather than reading a stale scan.
    MONITOR_WT_SCAN.store((-1.0_f32).to_bits(), Ordering::Relaxed);
  }
}

// Normalized read position (0..1 over the whole sample) of the monitored
// voice, or a negative value when none is playing. Polled by the waveform.
#[tauri::command]
pub fn audio_monitor_playhead() -> f32 {
  f32::from_bits(MONITOR_POS.load(Ordering::Relaxed))
}

// Live wavetable scan (0..1) of the monitored voice incl. self-morph deviation +
// automation, or negative when the monitored voice isn't a wavetable. Polled by
// the editor so the zoomed visualizer tracks the window the engine is reading.
#[tauri::command]
pub fn audio_monitor_wt_scan() -> f32 {
  f32::from_bits(MONITOR_WT_SCAN.load(Ordering::Relaxed))
}

#[tauri::command]
pub fn audio_repitch_note(note_id: u64, ratio: f32) -> Result<(), String> {
  engine().repitch_note(note_id, ratio)
}

// Phase 6: cutoff arrives normalized (0..1) so the LFO compute on the
// audio thread can operate in the same space as the web `modulated()`
// helper. Rust converts norm→Hz via the same log curve as JS-side
// `cutoffNormToHz` at IPC time and on every LFO write.
#[tauri::command]
pub fn audio_set_track_filter(
  track_id: String,
  cutoff_norm: f32,
  resonance: f32,
) -> Result<(), String> {
  engine().set_track_filter(track_id, cutoff_norm, resonance);
  Ok(())
}

#[derive(serde::Deserialize)]
pub struct TrackFilterUpdate {
  pub track_id: String,
  // Phase 6: was cutoff_hz; now normalized 0..1 so LFO modulation
  // operates in the same space as the web stack. Rust maps to Hz.
  pub cutoff_norm: f32,
  pub resonance: f32,
  pub fx_send: f32,
  pub reverb_send: f32,
  pub delay_send: f32,
  // Static tune/finetune normalized 0..1 — the LFO swing center for the
  // TrackTune / TrackFineTune destinations (the static value itself is already
  // baked into each voice's pitch at trigger).
  pub tune_norm: f32,
  pub finetune_norm: f32,
}

// One invoke carrying N per-track updates. RAF push in JS hits this
// once per animation frame for hand-edits / non-LFO knob moves —
// audio-rate LFO modulation no longer rides this path (the audio
// thread reads the LFO snapshot directly and writes `_eff` atomics).
#[tauri::command]
pub fn audio_set_track_filters_bulk(updates: Vec<TrackFilterUpdate>) -> Result<(), String> {
  // Hottest IPC handler (RAF-paced) — resolve the registry entry once per
  // track instead of once per param (5 mutex passes + 4 String clones).
  for u in updates {
    let params = get_or_create_track_params(&u.track_id);
    params.set_filter_norm(u.cutoff_norm.clamp(0.0, 1.0), u.resonance.clamp(0.0, 1.0));
    params.set_fx_send(u.fx_send.clamp(0.0, 1.0));
    params.set_reverb_send(u.reverb_send.clamp(0.0, 1.0));
    params.set_delay_send(u.delay_send.clamp(0.0, 1.0));
    params.set_tuning(u.tune_norm, u.finetune_norm);
  }
  Ok(())
}

#[tauri::command]
pub fn audio_set_reverb_params(
  size: f32,
  wet_gain: f32,
  diffusion: f32,
  damping: f32,
) -> Result<(), String> {
  engine().set_reverb_params(size, wet_gain, diffusion, damping);
  Ok(())
}

#[tauri::command]
pub fn audio_set_delay_params(
  delay_seconds: f32,
  feedback: f32,
  pingpong: f32,
  lofi: f32,
) -> Result<(), String> {
  engine().set_delay_params(delay_seconds, feedback, pingpong, lofi);
  Ok(())
}

#[tauri::command]
pub fn audio_set_mix_routing(
  multi_out: bool,
  fx_out_first: u32,
  fx_out_stereo: bool,
  fx_bypass: bool,
) -> Result<(), String> {
  engine().set_mix_routing(multi_out, fx_out_first, fx_out_stereo, fx_bypass);
  Ok(())
}

#[tauri::command]
pub fn audio_set_saturation_params(pre_drive: f32) -> Result<(), String> {
  engine().set_saturation_params(pre_drive);
  Ok(())
}

#[tauri::command]
pub fn audio_set_glitch_params(mix: f32) -> Result<(), String> {
  engine().set_glitch_params(mix);
  Ok(())
}

#[tauri::command]
pub fn audio_glitch_fire(target_frame: Option<f64>) -> Result<(), String> {
  engine().glitch_fire(
    target_frame
      .filter(|f| f.is_finite() && *f > 0.0)
      .map(|f| f.round() as u64)
      .unwrap_or(0),
  );
  Ok(())
}

#[tauri::command]
pub fn audio_set_master_filters(
  input: f32,
  lo_cut: u32,
  hi_cut: f32,
  trim: f32,
) -> Result<(), String> {
  engine().set_master_filters(input, lo_cut, hi_cut, trim);
  Ok(())
}

#[tauri::command]
pub fn audio_set_master_comp(
  amount: f32,
  attack_idx: u32,
  release_idx: u32,
) -> Result<(), String> {
  engine().set_master_comp(amount, attack_idx, release_idx);
  Ok(())
}

#[tauri::command]
pub fn audio_set_master_dist(
  mode: u32,
  drive: f32,
  bias: f32,
  mix: f32,
) -> Result<(), String> {
  engine().set_master_dist(mode, drive, bias, mix);
  Ok(())
}

#[tauri::command]
pub fn audio_set_master_gate(
  enabled: bool,
  threshold: f32,
) -> Result<(), String> {
  engine().set_master_gate(enabled, threshold);
  Ok(())
}

#[tauri::command]
pub fn audio_set_master_bypass(bypass: bool) -> Result<(), String> {
  engine().set_master_bypass(bypass);
  Ok(())
}

// Combined recording (phase 7f-1). Path is an absolute filesystem path
// — JS computes a timestamped filename inside the user's configured
// recordings dir (see `recorderConfig.getConfiguredRecordingsDir`).
#[tauri::command]
pub fn audio_start_recording_combined(
  app: tauri::AppHandle,
  path: String,
  start_frame: u64,
) -> Result<(), String> {
  engine().start_recording_combined(app, path, start_frame)
}

#[tauri::command]
pub fn audio_stop_recording_combined() -> Result<(), String> {
  engine().stop_recording_combined()
}

#[tauri::command]
pub fn audio_is_recording_combined() -> bool {
  engine().is_recording_combined()
}

#[tauri::command]
pub fn audio_start_recording_splits(
  app: tauri::AppHandle,
  rhythm_path: String,
  melody_path: String,
) -> Result<(), String> {
  engine().start_recording_splits(app, rhythm_path, melody_path)
}

#[tauri::command]
pub fn audio_stop_recording_splits() -> Result<(), String> {
  engine().stop_recording_splits()
}

#[tauri::command]
pub fn audio_is_recording_splits() -> bool {
  engine().is_recording_splits()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audio_start_recording_stems(
  app: tauri::AppHandle,
  stem_dir: String,
  master_path: String,
  fx_path: String,
  reverb_path: String,
  delay_path: String,
  track_ids: Vec<String>,
  track_paths: Vec<String>,
  start_frame: u64,
) -> Result<(), String> {
  engine().start_recording_stems(
    app,
    stem_dir,
    master_path,
    fx_path,
    reverb_path,
    delay_path,
    track_ids,
    track_paths,
    start_frame,
  )
}

#[tauri::command]
pub fn audio_stop_recording_stems() -> Result<(), String> {
  engine().stop_recording_stems()
}

#[tauri::command]
pub fn audio_is_recording_stems() -> bool {
  engine().is_recording_stems()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audio_set_tape_params(
  position: f32,
  length: f32,
  stretch1: f32,
  gain1: f32,
  stretch2: f32,
  gain2: f32,
  mix: f32,
  reverse: bool,
  hold: bool,
  grain_rate: f32,
  grain_mix: f32,
) -> Result<(), String> {
  engine().set_tape_params(
    position, length, stretch1, gain1, stretch2, gain2, mix, reverse, hold,
    grain_rate, grain_mix,
  );
  Ok(())
}

#[tauri::command]
pub fn audio_stop_all() -> Result<(), String> {
  engine().stop_all_voices()
}

#[tauri::command]
pub fn audio_panic() -> Result<(), String> {
  engine().panic()
}

// Perform punch-in/release — flush queued-but-unfired triggers from
// min_frame onward so the dispatcher can re-emit the horizon under the
// new perform state. See MixerCommand::FlushPending.
#[tauri::command]
pub fn audio_flush_pending(min_frame: f64) -> Result<(), String> {
  if !min_frame.is_finite() || min_frame < 0.0 {
    return Err("min_frame must be a non-negative number".to_string());
  }
  engine().flush_pending(min_frame as u64)
}

// Transport-stop texture fade — ring down texture-role voices over
// fade_secs while everything else keeps playing untouched. See
// MixerCommand::FadeTextures.
#[tauri::command]
pub fn audio_fade_textures(fade_secs: f32) -> Result<(), String> {
  engine().fade_textures(fade_secs)
}

// Freeze in-flight voice DSP params on a scene/bank/song swap so ringing
// tails keep the outgoing scene's filter/fx settings. See
// MixerCommand::FreezeVoiceParams.
#[tauri::command]
pub fn audio_freeze_voice_params() -> Result<(), String> {
  engine().freeze_voice_params()
}

// Loop/resample capture — copy [start_frame, end_frame) out of the
// pre-master ring and loop it bar-phase-locked. Frames are absolute
// engine-clock positions in the PAST (retroactive capture). See
// MixerCommand::LoopCapture.
#[tauri::command]
pub fn audio_loop_capture(start_frame: f64, end_frame: f64) -> Result<(), String> {
  if !start_frame.is_finite()
    || !end_frame.is_finite()
    || start_frame < 0.0
    || end_frame <= start_frame
  {
    return Err("invalid capture span".to_string());
  }
  engine().loop_capture(start_frame as u64, end_frame as u64)
}

#[tauri::command]
pub fn audio_loop_stop() -> Result<(), String> {
  engine().loop_stop()
}

#[tauri::command]
pub fn audio_noise_capture(start_frame: f64, end_frame: f64) -> Result<(), String> {
  if !start_frame.is_finite()
    || !end_frame.is_finite()
    || start_frame < 0.0
    || end_frame <= start_frame
  {
    return Err("invalid capture span".to_string());
  }
  engine().noise_capture(start_frame as u64, end_frame as u64)
}

#[tauri::command]
pub fn audio_noise_stop() -> Result<(), String> {
  engine().noise_stop()
}

// NOISE unit params — see MixerCommand::NoiseParams.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audio_noise_params(
  source: u8,
  speed: f32,
  drive: f32,
  cutoff: f32,
  res: f32,
  width: f32,
  mode: u8,
  noise: f32,
  cv: f32,
  clock_frames: f32,
  clock_synced: bool,
  clock_mode: u8,
  clock_src: u8,
  clock_div: u32,
  sens: f32,
  level: f32,
  fx_send: f32,
  rev_send: f32,
  del_send: f32,
) -> Result<(), String> {
  engine().noise_params(
    source, speed, drive, cutoff, res, width, mode, noise, cv, clock_frames,
    clock_synced, clock_mode, clock_src, clock_div, sens, level, fx_send,
    rev_send, del_send,
  )
}

// NOISE unit ping LEDs — (L, R) peak-hold envelopes 0..1. Polled ~30Hz by
// the NOISE tab while open.
#[tauri::command]
pub fn audio_noise_viz() -> Vec<f32> {
  NOISE_VIZ_PING
    .iter()
    .map(|a| f32::from_bits(a.load(Ordering::Relaxed)))
    .collect()
}

// NOISE unit output scope — [write_pos, min0, max0, min1, max1, ...].
// Ring order: the column AT write_pos is the oldest; the tab rotates so
// newest lands at the right edge. Polled ~30Hz while the NOISE tab is open.
#[tauri::command]
pub fn audio_noise_scope() -> Vec<f32> {
  let mut v = Vec::with_capacity(NOISE_SCOPE_COLS * 2 + 1);
  v.push(NOISE_SCOPE_POS.load(Ordering::Relaxed) as f32);
  for a in NOISE_SCOPE.iter() {
    v.push(f32::from_bits(a.load(Ordering::Relaxed)));
  }
  v
}

// Save-to-library: bounce `frames` stereo frames of the loop unit's output
// to `path`, starting at the next bar-grid point (`align_frames`). Emits
// `recorder:finalized` with label "loop" when the WAV is done.
#[tauri::command]
pub fn audio_loop_bounce(
  app: tauri::AppHandle,
  path: String,
  frames: f64,
  align_frames: f64,
) -> Result<(), String> {
  if !frames.is_finite() || frames < 1.0 {
    return Err("frames must be a positive number".to_string());
  }
  if path.trim().is_empty() {
    return Err("path must be non-empty".to_string());
  }
  engine().loop_bounce(app, path, frames as u64, align_frames.max(1.0) as u64)
}

#[tauri::command]
pub fn audio_loop_gain(gain: f32) -> Result<(), String> {
  engine().loop_gain(gain)
}

// P2 manipulation params — speed (thru-zero, octave-ladder quantized
// JS-side), size (grain size norm, 1 = tape mode), random (start-point
// randomness 0..1), grains (concurrent voices 1..8), rate_hz (spawn rate
// 0.5..60), plus per-control deviations (ADDAC 112 style, 0..1 each).
// See MixerCommand::LoopParams.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audio_loop_params(
  speed: f32,
  pitch: f32,
  loop_lock: bool,
  loop_level: f32,
  grain_level: f32,
  size: f32,
  random: f32,
  grains: u32,
  spawn_frames: f32,
  rate_synced: bool,
  size_dev: f32,
  pitch_dev: f32,
  rate_dev: f32,
  fx_send: f32,
  rev_send: f32,
  del_send: f32,
) -> Result<(), String> {
  engine().loop_params(
    speed, pitch, loop_lock, loop_level, grain_level, size, random, grains,
    spawn_frames, rate_synced, size_dev, pitch_dev, rate_dev, fx_send,
    rev_send, del_send,
  )
}

#[derive(Debug, Serialize)]
pub struct LoopViz {
  pub version: u32,
  // Playhead as a 0..1 fraction of the loop; negative = unit inactive.
  pub pos: f32,
  // Bounce progress 0..1; negative = no save in flight.
  pub bounce: f32,
  // 8 × (position fraction, window level); position -1 = slot idle.
  pub grains: Vec<f32>,
}

// Live loop-unit picture for the LOOPS tab — playhead + grain positions,
// written by the audio thread once per block into lock-free statics.
// Polled ~30Hz while the tab is open; `version` tells the poller when the
// captured waveform changed (re-fetch peaks).
#[tauri::command]
pub fn audio_loop_viz() -> LoopViz {
  let mut grains = Vec::with_capacity(LOOP_GRAIN_SLOTS * 2);
  for a in LOOP_VIZ_GRAINS.iter() {
    grains.push(f32::from_bits(a.load(Ordering::Relaxed)));
  }
  LoopViz {
    version: LOOP_VIZ_VERSION.load(Ordering::Acquire),
    pos: f32::from_bits(LOOP_VIZ_POS.load(Ordering::Relaxed)),
    bounce: f32::from_bits(LOOP_VIZ_BOUNCE.load(Ordering::Relaxed)),
    grains,
  }
}

// Captured-loop waveform peaks (512 columns × min/max, interleaved) —
// filled at capture time. Fetched once per version change, not polled.
#[tauri::command]
pub fn audio_loop_peaks() -> Vec<f32> {
  let mut out = Vec::with_capacity(LOOP_PEAK_COLS * 2);
  for a in LOOP_VIZ_PEAKS.iter() {
    out.push(f32::from_bits(a.load(Ordering::Relaxed)));
  }
  out
}

// Phase 6: push the full LFO panel state (rate / depth / destinations
// for all 8 LFOs) to the audio thread. Called by JS whenever the user
// touches the LFO panel or a downstream destination is toggled. Cheap
// — runs at user-event rate, not RAF rate, so HashMap building and
// Vec allocs are fine. The audio-thread compute reads the resulting
// Arc snapshot lock-free.
#[tauri::command]
pub fn audio_set_lfos(lfos: Vec<LfoIpc>) -> Result<(), String> {
  install_lfo_snapshot(lfos);
  Ok(())
}
