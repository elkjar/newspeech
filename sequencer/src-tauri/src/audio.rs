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
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleRate, Stream, StreamConfig};
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::Serialize;

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

  let frames: Vec<f32> = match spec.sample_format {
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
  // 0..1 — portion of the voice signal routed to the global reverb bus.
  // The voice's dry signal is attenuated by (1 - fx_send) and the wet
  // contribution scaled by fx_send. Per-voice mix, audio-rate atomic.
  fx_send_base: AtomicU32,
  fx_send_eff: AtomicU32,
}

// Cutoff mapping mirrors src/audio/nativeEngine.ts cutoffNormToHz.
// 50 Hz at norm=0, 18 kHz at norm=1, log spacing in between.
const CUTOFF_MIN_HZ: f32 = 50.0;
const CUTOFF_MAX_HZ: f32 = 18000.0;
fn cutoff_norm_to_hz(norm: f32) -> f32 {
  let n = norm.clamp(0.0, 1.0);
  CUTOFF_MIN_HZ * (CUTOFF_MAX_HZ / CUTOFF_MIN_HZ).powf(n)
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
    }
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
// `fire_requested` is the trigger flag; audio thread polls on each
// block and clears once consumed.
pub struct GlitchState {
  mix_base: AtomicU32,
  mix: AtomicU32,
  fire_requested: AtomicBool,
}

impl GlitchState {
  fn new() -> Self {
    Self {
      mix_base: AtomicU32::new(1.0_f32.to_bits()),
      mix: AtomicU32::new(1.0_f32.to_bits()),
      fire_requested: AtomicBool::new(false),
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
pub struct RecorderState {
  // Mirror of audio-thread state for IPC introspection ("is recording
  // armed?"). Set true by start, cleared by stop.
  combined_enabled: AtomicBool,
  splits_enabled: AtomicBool,
  // Per-recording worker stop flags. Single-recording-at-a-time per
  // mode so one shared flag per stream is fine.
  combined_stop: Arc<AtomicBool>,
  splits_stop: Arc<AtomicBool>,
}

impl RecorderState {
  fn new() -> Self {
    Self {
      combined_enabled: AtomicBool::new(false),
      splits_enabled: AtomicBool::new(false),
      combined_stop: Arc::new(AtomicBool::new(false)),
      splits_stop: Arc::new(AtomicBool::new(false)),
    }
  }
}

static RECORDER_STATE: OnceLock<RecorderState> = OnceLock::new();

fn recorder_state() -> &'static RecorderState {
  RECORDER_STATE.get_or_init(RecorderState::new)
}

// f32 → i16 PCM with hard clip. Matches the web `floatStereoToInt16Bytes`
// conversion in `audio/recorder.ts`. 16-bit PCM keeps file sizes
// reasonable and is universally importable by DAWs.
#[inline]
fn f32_to_i16(x: f32) -> i16 {
  let clamped = x.clamp(-1.0, 1.0);
  (clamped * 32767.0) as i16
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
  mut cons: HeapCons<i16>,
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
        | LfoDestKind::TrackFxSend,
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

const VOICE_POOL_SIZE: usize = 64;
const TRIGGER_QUEUE_CAPACITY: usize = 256;
// Cap for the per-stream sample-accurate pending-trigger queue. The
// audio thread pre-allocates this many slots so pushes never realloc;
// overflow drops with `PENDING_TRIGGER_DROPS` for diagnostics.
const PENDING_TRIGGERS_CAP: usize = 512;

// Diagnostic counter — incremented from the audio thread when a
// delayed trigger arrives with the pending queue full. Read via the
// status IPC for debug overlays.
static PENDING_TRIGGER_DROPS: std::sync::atomic::AtomicU32 =
  std::sync::atomic::AtomicU32::new(0);

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
  // re-trigger.
  frozen_params: Option<(f32, f32, f32)>,
  // Output frames elapsed since trigger — drives the flat-voice declick
  // fade-in. Counts output frames (not sample position), so it's
  // rate-independent.
  frames_played: u32,
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
      out_first: 0,
      out_stereo: true,
      track_params: None,
      filter: LadderFilter::default(),
      start_frame: 0,
      active: false,
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
      is_texture: false,
      frozen_params: None,
      frames_played: 0,
      note_id: 0,
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
    producer: HeapProd<i16>,
  },
  StopCombinedRecording,
  StartSplitsRecording {
    rhythm: HeapProd<i16>,
    melody: HeapProd<i16>,
  },
  StopSplitsRecording,
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
    // Frames to wait after this trigger is drained from the queue
    // before the voice begins emitting. 0 = fire immediately at start
    // of the next audio block (existing behavior). >0 = queue in
    // pending_triggers and fire sample-accurately when the deadline
    // falls within an audio block.
    delay_samples: u32,
    // Voice handle (0 = untagged). Only live-input monitoring sets it.
    note_id: u64,
  },
  StopAll,
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
  // Detach every active, not-yet-frozen voice from its shared
  // track_params by snapshotting the current cutoff/resonance/fx_send
  // onto the voice. Issued on a scene/bank/song swap so in-flight tails
  // keep the OUTGOING scene's DSP settings as they ring out — the
  // incoming scene's params (pushed moments later) then can't retune the
  // tails (a resonance jump would otherwise self-oscillate into a crash).
  FreezeVoiceParams,
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
// into a slot. remaining_samples can go negative if the trigger
// arrives "late" relative to its requested delay (IPC + block boundary
// latency) — handled by clamping start_frame to 0.
struct PendingTrigger {
  sample: Arc<SampleData>,
  rate: f64,
  gain: f32,
  pan_left: f32,
  pan_right: f32,
  out_first: usize,
  out_stereo: bool,
  track_params: Option<Arc<TrackParams>>,
  monophonic: bool,
  section: u8,
  is_texture: bool,
  envelope: Option<EnvelopeSpec>,
  remaining_samples: i32,
  note_id: u64,
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
    monophonic: bool,
    section: u8,
    is_texture: bool,
    envelope: Option<EnvelopeSpec>,
    note_id: u64,
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
    let track_params = track_id
      .as_deref()
      .map(get_or_create_track_params);
    // Convert delay seconds → frames at the device sample rate. The
    // audio callback dequeues by frame count, so seconds is the
    // unit-agnostic value to cross IPC; sample rate is owned by Rust.
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    let delay_samples = if sr == 0 || !delay_secs.is_finite() || delay_secs <= 0.0 {
      0u32
    } else {
      (delay_secs * sr as f32).round().max(0.0).min(u32::MAX as f32) as u32
    };
    let cmd = MixerCommand::Trigger {
      sample,
      gain,
      pan,
      pitch,
      out_first,
      out_stereo,
      track_params,
      monophonic,
      section,
      is_texture,
      envelope,
      delay_samples,
      note_id,
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

  pub fn set_track_fx_send(&self, track_id: String, fx_send: f32) {
    let params = get_or_create_track_params(&track_id);
    params.set_fx_send(fx_send.clamp(0.0, 1.0));
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

  // Pre-saturation drive (in the wet bus, ahead of reverb).
  pub fn set_saturation_params(&self, pre_drive: f32) {
    saturation_state().ipc_set(pre_drive.clamp(0.0, 1.0));
  }

  // Glitch mix knob. Chance dice live in JS (scheduler.onStep handles
  // the beat clock); `glitch_fire` is the one-shot trigger.
  pub fn set_glitch_params(&self, mix: f32) {
    glitch_state().ipc_set(mix.clamp(0.0, 1.0));
  }

  pub fn glitch_fire(&self) {
    glitch_state()
      .fire_requested
      .store(true, Ordering::Release);
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
  ) -> Result<(), String> {
    let r = recorder_state();
    if r.combined_enabled.load(Ordering::Acquire) {
      return Err("combined recording already in progress".to_string());
    }
    let sr = self.state.sample_rate.load(Ordering::Acquire);
    if sr == 0 {
      return Err("audio device not open".to_string());
    }
    // ~5s of headroom at 48k stereo (480_000 i16 samples = 960 KB).
    // Worker drains every 5ms so this is far more than ever needed
    // in practice; keeps the audio thread's push side from blocking.
    const QUEUE_SAMPLES: usize = 480_000;
    let (prod, cons) = HeapRb::<i16>::new(QUEUE_SAMPLES).split();

    let spec = hound::WavSpec {
      channels: 2,
      sample_rate: sr,
      bits_per_sample: 16,
      sample_format: hound::SampleFormat::Int,
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
    let mut guard = self
      .state
      .trigger_producer
      .lock()
      .map_err(|e| format!("producer lock: {}", e))?;
    let producer = guard
      .as_mut()
      .ok_or_else(|| "audio device not open".to_string())?;
    producer
      .try_push(MixerCommand::StartCombinedRecording { producer: prod })
      .map_err(|_| "command queue full (start recording)".to_string())?;

    r.combined_enabled.store(true, Ordering::Release);
    Ok(())
  }

  pub fn stop_recording_combined(&self) -> Result<(), String> {
    let r = recorder_state();
    if !r.combined_enabled.load(Ordering::Acquire) {
      // Idempotent — stopping a non-running recorder is fine.
      return Ok(());
    }
    // Push stop to the audio thread — it drops the producer, worker
    // sees try_pop empty and eventually the stop flag, finalizes WAV.
    {
      let mut guard = self
        .state
        .trigger_producer
        .lock()
        .map_err(|e| format!("producer lock: {}", e))?;
      let producer = guard
        .as_mut()
        .ok_or_else(|| "audio device not open".to_string())?;
      producer
        .try_push(MixerCommand::StopCombinedRecording)
        .map_err(|_| "command queue full (stop recording)".to_string())?;
    }
    r.combined_enabled.store(false, Ordering::Release);
    r.combined_stop.store(true, Ordering::Release);
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
      bits_per_sample: 16,
      sample_format: hound::SampleFormat::Int,
    };
    let rhythm_writer = hound::WavWriter::create(&rhythm_path, spec)
      .map_err(|e| format!("create rhythm wav '{}': {}", rhythm_path, e))?;
    let melody_writer = hound::WavWriter::create(&melody_path, spec)
      .map_err(|e| format!("create melody wav '{}': {}", melody_path, e))?;
    let (rhythm_prod, rhythm_cons) = HeapRb::<i16>::new(QUEUE_SAMPLES).split();
    let (melody_prod, melody_cons) = HeapRb::<i16>::new(QUEUE_SAMPLES).split();

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
      .map_err(|_| "command queue full (start splits)".to_string())?;

    r.splits_enabled.store(true, Ordering::Release);
    Ok(())
  }

  pub fn stop_recording_splits(&self) -> Result<(), String> {
    let r = recorder_state();
    if !r.splits_enabled.load(Ordering::Acquire) {
      return Ok(());
    }
    {
      let mut guard = self
        .state
        .trigger_producer
        .lock()
        .map_err(|e| format!("producer lock: {}", e))?;
      let producer = guard
        .as_mut()
        .ok_or_else(|| "audio device not open".to_string())?;
      producer
        .try_push(MixerCommand::StopSplitsRecording)
        .map_err(|_| "command queue full (stop splits)".to_string())?;
    }
    r.splits_enabled.store(false, Ordering::Release);
    r.splits_stop.store(true, Ordering::Release);
    Ok(())
  }

  pub fn is_recording_splits(&self) -> bool {
    recorder_state().splits_enabled.load(Ordering::Acquire)
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
        _stream = None;
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
        _stream = None;
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

// Drops a PendingTrigger into a voice slot — picks an inactive slot,
// or steals one round-robin via steal_cursor if all are busy. Used by
// both the immediate-fire path (delay_samples == 0) and the
// sample-accurate dispatch path (delay reached this block).
// When the trigger is flagged monophonic, all OTHER currently-active
// voices sharing the same `track_params` Arc get a soft ~20ms release
// ramp before this trigger claims its slot.
fn claim_voice_slot(
  voices: &mut [Voice],
  steal_cursor: &mut usize,
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
  let slot = (0..VOICE_POOL_SIZE)
    .find(|i| !voices[*i].active)
    .unwrap_or_else(|| {
      let s = *steal_cursor;
      *steal_cursor = (*steal_cursor + 1) % VOICE_POOL_SIZE;
      s
    });
  let v = &mut voices[slot];
  v.sample = Some(p.sample);
  v.position = 0.0;
  v.rate = p.rate;
  v.rate_target = p.rate;
  v.rate_glide_inc = 0.0;
  v.rate_glide_remaining = 0;
  v.gain = p.gain;
  v.pan_left = p.pan_left;
  v.pan_right = p.pan_right;
  v.out_first = p.out_first;
  v.out_stereo = p.out_stereo;
  v.track_params = p.track_params;
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

  // Callback-local state — only the audio thread touches these.
  let mut phase: f32 = 0.0;
  let mut last_ch: usize = usize::MAX;
  let mut voices: Vec<Voice> = vec![Voice::default(); VOICE_POOL_SIZE];
  let mut steal_cursor: usize = 0;
  // Pending triggers — sample-accurate dispatch queue. Triggers with
  // delay_samples > 0 land here at drain time; each block we scan and
  // fire any whose remaining_samples falls inside this block.
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
  let mut combined_rec_producer: Option<HeapProd<i16>> = None;
  let mut rhythm_rec_producer: Option<HeapProd<i16>> = None;
  let mut melody_rec_producer: Option<HeapProd<i16>> = None;
  // Section scratch buffers (stereo interleaved? no — separate L/R for
  // matching the bus accumulation pattern of reverb_in_l/r). Sized at
  // REVERB_SCRATCH for the same chunked-large-block reasoning.
  let mut rhythm_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut rhythm_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut melody_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut melody_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let nominal_channels = channels as usize;
  let nominal_sr = sample_rate as f32;
  let device_sr_f64 = sample_rate as f64;
  // Reverb bus + scratch buffers. 8192 frames is well above the typical
  // cpal block size (256–2048); chunked processing kicks in if the
  // device ever calls back with a larger buffer.
  const REVERB_SCRATCH: usize = 8192;
  let mut reverb_bus = ReverbBus::new(sample_rate);
  let mut reverb_in_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut reverb_in_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut reverb_out_l: Vec<f32> = vec![0.0; REVERB_SCRATCH];
  let mut reverb_out_r: Vec<f32> = vec![0.0; REVERB_SCRATCH];
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

        // 1) Drain the trigger queue. Triggers with delay_samples == 0
        // claim a voice slot immediately at start_frame=0 (existing
        // behavior). Triggers with delay_samples > 0 are pushed to
        // pending_triggers for sample-accurate dispatch in step 2.
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
              section,
              is_texture,
              envelope,
              delay_samples,
              note_id,
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
              let pending = PendingTrigger {
                sample,
                rate,
                gain,
                pan_left,
                pan_right,
                out_first: out_first as usize,
                out_stereo,
                track_params,
                monophonic,
                section,
                is_texture,
                envelope,
                remaining_samples: delay_samples as i32,
                note_id,
              };
              if delay_samples == 0 {
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
                  v.frozen_params = Some((tp.cutoff(), tp.resonance(), tp.fx_send()));
                }
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
            MixerCommand::StartCombinedRecording { producer } => {
              // Drop any prior producer (worker thread observes via
              // try_pop returning None once it's gone). Install the
              // new one — subsequent blocks start pushing samples.
              combined_rec_producer = Some(producer);
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
            }
            MixerCommand::StopSplitsRecording => {
              rhythm_rec_producer = None;
              melody_rec_producer = None;
            }
          }
        }

        let frames = buf.len() / n_ch.max(1);

        // 1.5) Sample-accurate dispatch — scan pending triggers and
        // fire any whose deadline falls inside the current block. Uses
        // swap_remove for O(1) deletion. Order changes but that's fine
        // (each trigger carries its own delay; the JS scheduler already
        // computed pan/rate/etc. at push time).
        let block_frames = frames as i32;
        let mut i = 0;
        while i < pending_triggers.len() {
          if pending_triggers[i].remaining_samples < block_frames {
            let mut p = pending_triggers.swap_remove(i);
            let start_frame = p.remaining_samples.max(0) as usize;
            // Re-zero remaining so the moved value doesn't leak weird
            // state if anything in claim_voice_slot reads it.
            p.remaining_samples = 0;
            claim_voice_slot(&mut voices, &mut steal_cursor, p, start_frame, sr_f32);
          } else {
            pending_triggers[i].remaining_samples -= block_frames;
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
          reverb_in_l[i] = 0.0;
          reverb_in_r[i] = 0.0;
          rhythm_l[i] = 0.0;
          rhythm_r[i] = 0.0;
          melody_l[i] = 0.0;
          melody_r[i] = 0.0;
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
          // Honor sample-accurate dispatch — voice may have been queued
          // to start partway into this block. Reset start_frame after
          // the loop so subsequent blocks emit from frame 0.
          let start = v.start_frame;
          let mut deactivate = false;
          for frame in start..frames {
            let pos = v.position;
            let i0 = pos.floor() as usize;
            if i0 + 1 >= frame_count {
              deactivate = true;
              break;
            }
            let frac = (pos - i0 as f64) as f32;
            // Catmull-Rom needs the two outer neighbours i0-1 and i0+2.
            // Clamp them at the sample's edges (repeat the boundary frame)
            // so the curve degrades to near-linear at start/end rather
            // than reading out of bounds. The i0+1 < frame_count guard
            // above already protects the inner pair.
            let im1 = if i0 >= 1 { i0 - 1 } else { i0 };
            let ip2 = if i0 + 2 < frame_count { i0 + 2 } else { i0 + 1 };
            let (mut ls, mut rs) = if sample_channels == 1 {
              let interp = catmull(
                frames_slice[im1],
                frames_slice[i0],
                frames_slice[i0 + 1],
                frames_slice[ip2],
                frac,
              );
              (interp, interp)
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
            };
            // Filter coefficients: frozen snapshot (detached on a swap) if
            // present, else live from track_params.
            let filt_coeffs = match v.frozen_params {
              Some((fc, res, _)) => Some((fc, res)),
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
            // Declick: flat (non-enveloped) voices get a ~1ms linear fade
            // at the trigger and at the natural sample end, so samples not
            // trimmed to a zero-crossing don't click on start / cutoff.
            // Enveloped voices skip this — their ADSR already ramps both
            // ends. fade_in tracks output frames since trigger; fade_out
            // tracks output frames until the sample runs out (rate-scaled,
            // so it holds at pitched playback). Overlap on a very short
            // sample just yields a gentle bell — still click-free.
            if !v.env_active {
              let declick = (sr_f32 * 0.001).max(1.0);
              let fade_in = (v.frames_played as f32 / declick).min(1.0);
              let to_end =
                (((frame_count as f64 - 1.0 - pos) / v.rate) as f32).max(0.0);
              let fade_out = (to_end / declick).min(1.0);
              let g = fade_in.min(fade_out);
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
              Some((_, _, fx)) => fx,
              None => track_params_ref.map(|p| p.fx_send()).unwrap_or(0.0),
            };
            let fx_send = if fx_bypass_now { 0.0 } else { raw_fx_send };
            let dry_scale = 1.0 - fx_send;
            // Reverb input is post-gain + post-pan so the wet bus
            // matches the dry path's positioning. Reverb sums L+R to
            // mono internally so the pan only affects relative wet
            // level, not the reverb tail's spatial placement.
            if fx_send > 0.0 && frame < REVERB_SCRATCH {
              let wet_l = ls * v.gain * v.pan_left * fx_send;
              let wet_r = rs * v.gain * v.pan_right * fx_send;
              reverb_in_l[frame] += wet_l;
              reverb_in_r[frame] += wet_r;
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
            v.position += v.rate;
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

        // 4) FX bus — pre-reverb drive (saturation) → reverb. Both
        // stages live INSIDE the wet bus and only colour the signal
        // that voices fed in via fx_send. fx_send is a wet/dry
        // crossfade (dry_scale = 1 - fx_send above), so fx_send=1 is
        // pure-wet with no dry contribution and fx_send=0 is pure-dry
        // with the wet bus silent. The whole stage is skipped when
        // fx_bypass is on. Output channel pair depends on multi_out:
        // OFF → 0+1 stereo (monitor fold); ON → fx_out_first / fx_out_stereo.
        let r = reverb_state();
        let size = f32::from_bits(r.size.load(Ordering::Relaxed));
        let mix = f32::from_bits(r.wet_gain.load(Ordering::Relaxed));
        let diffusion = f32::from_bits(r.diffusion.load(Ordering::Relaxed));
        let damping = f32::from_bits(r.damping.load(Ordering::Relaxed));
        reverb_bus.set_size(size);
        reverb_bus.set_diffusion(diffusion);
        reverb_bus.set_damping(damping);
        reverb_bus.set_mix(mix);

        // Tape stage (first in the FX bus, ahead of drive). Always
        // captures the bus input even at mix=0 so the ring stays warm.
        // Replaces reverb_in_l/r in place with the (1-mix)·input +
        // mix·bed blend — downstream drive + reverb then operate on
        // whatever the tape stage emitted.
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
            &mut reverb_in_l[..rev_frames],
            &mut reverb_in_r[..rev_frames],
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
          let fired = g.fire_requested.swap(false, Ordering::AcqRel);
          glitch_machine.process_block(
            &mut reverb_in_l[..rev_frames],
            &mut reverb_in_r[..rev_frames],
            rev_frames,
            glitch_mix,
            fired,
          );
        }

        // Pre-reverb saturation — drives the wet input so the reverb
        // processes a distorted signal. Tanh waveshaper, same curve as
        // the web saturation.ts.
        if !fx_bypass_now && rev_frames > 0 {
          let sat = saturation_state();
          let drive = f32::from_bits(sat.pre_drive.load(Ordering::Relaxed));
          if drive > 0.001 {
            for frame in 0..rev_frames {
              reverb_in_l[frame] = pre_saturate_sample(reverb_in_l[frame], drive);
              reverb_in_r[frame] = pre_saturate_sample(reverb_in_r[frame], drive);
            }
          }
        }

        // The FX bus always outputs at unit gain — the reverb DSP's own
        // wet/dry mix (set via `mix` above) controls how much tail
        // bleeds against the saturated dry input. At mix=0 the bus
        // outputs the saturated dry signal as a parallel layer (no
        // reverb tail); at mix=1 it's tail only. Either way the drive
        // colours something audible, no longer scaled by a separate
        // wet-bus gain.
        if !fx_bypass_now && rev_frames > 0 {
          reverb_bus.process_block(
            &reverb_in_l[..rev_frames],
            &reverb_in_r[..rev_frames],
            &mut reverb_out_l[..rev_frames],
            &mut reverb_out_r[..rev_frames],
          );
          {
            // Same multi-out fallback as voice routing: if the FX bus
            // pair falls off the end of the device, fold to 0/1 so the
            // wet bus stays audible rather than vanishing on a smaller
            // interface than the config was authored against.
            let needed_channels = if fx_out_stereo { 2 } else { 1 };
            let fx_in_range =
              fx_out_first.saturating_add(needed_channels) <= n_ch;
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
                  buf[frame * n_ch + l_idx] += reverb_out_l[frame];
                }
              }
              if r_idx < n_ch {
                for frame in 0..rev_frames {
                  buf[frame * n_ch + r_idx] += reverb_out_r[frame];
                }
              }
            } else if out_first < n_ch {
              // Mono FX out — sum L+R*0.5 into a single channel.
              for frame in 0..rev_frames {
                let mono = 0.5 * (reverb_out_l[frame] + reverb_out_r[frame]);
                buf[frame * n_ch + out_first] += mono;
              }
            }
          }
        }

        // 5) Master stage — final tone-shaping on channels 0+1. Sits
        // AFTER the FX bus output has mixed in. In multi-out mode the
        // master chain is SKIPPED ENTIRELY: per-voice stems on higher
        // channels stay pre-master AND the FX-bus pair stays pre-
        // master too, so the DAW (or FOH) drives its own master.
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
        if let Some(prod) = combined_rec_producer.as_mut() {
          if n_ch >= 2 {
            for frame in 0..frames {
              let l = f32_to_i16(buf[frame * n_ch]);
              let r_s = f32_to_i16(buf[frame * n_ch + 1]);
              // Best-effort push — if queue is full (worker stalled),
              // drop samples rather than block the audio thread.
              let _ = prod.try_push(l);
              let _ = prod.try_push(r_s);
            }
          } else if n_ch == 1 {
            for frame in 0..frames {
              let s = f32_to_i16(buf[frame * n_ch]);
              let _ = prod.try_push(s);
              let _ = prod.try_push(s);
            }
          }
        }
        // Splits: rhythm + melody scratches (already cleared at block
        // top, accumulated by per-voice section taps above). Pre-FX,
        // pre-master raw voice signal — matches the web splits tap
        // point and gives DAWs a clean stem per section.
        if let Some(prod) = rhythm_rec_producer.as_mut() {
          for frame in 0..rev_frames {
            let _ = prod.try_push(f32_to_i16(rhythm_l[frame]));
            let _ = prod.try_push(f32_to_i16(rhythm_r[frame]));
          }
        }
        if let Some(prod) = melody_rec_producer.as_mut() {
          for frame in 0..rev_frames {
            let _ = prod.try_push(f32_to_i16(melody_l[frame]));
            let _ = prod.try_push(f32_to_i16(melody_r[frame]));
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audio_trigger_sample(
  path: String,
  gain: Option<f32>,
  pan: Option<f32>,
  pitch: Option<f32>,
  out_first: Option<u32>,
  out_stereo: Option<bool>,
  track_id: Option<String>,
  delay_secs: Option<f32>,
  monophonic: Option<bool>,
  // Section tag for splits routing. 0/None = no section (skipped from
  // splits WAVs), 1 = drum, 2 = melodic, 3 = click (writes to BOTH
  // splits so count-in is in either stem).
  section: Option<u8>,
  // Texture-role flag — texture voices fade out on transport stop.
  is_texture: Option<bool>,
  // ADSR envelope spec — all four fields must be present for the voice
  // to apply one. None of these → flat-gain voice (drums, leads
  // without envelope config). Times in seconds; sustain is 0..1.
  envelope_attack: Option<f32>,
  envelope_decay: Option<f32>,
  envelope_sustain: Option<f32>,
  envelope_release: Option<f32>,
  envelope_hold: Option<f32>,
  // Voice handle for targeted release (live-input monitoring). Omitted /
  // 0 for every sequencer trigger.
  note_id: Option<u64>,
) -> Result<(), String> {
  let envelope = match (
    envelope_attack,
    envelope_release,
    envelope_hold,
  ) {
    (Some(attack), Some(release), Some(hold)) => Some(EnvelopeSpec {
      attack_secs: attack,
      decay_secs: envelope_decay.unwrap_or(0.0),
      sustain_level: envelope_sustain.unwrap_or(1.0),
      release_secs: release,
      hold_secs: hold,
    }),
    _ => None,
  };
  engine().trigger_sample(
    path,
    gain.unwrap_or(1.0),
    pan.unwrap_or(0.0),
    pitch.unwrap_or(1.0),
    out_first.unwrap_or(0),
    out_stereo.unwrap_or(true),
    track_id,
    delay_secs.unwrap_or(0.0),
    monophonic.unwrap_or(false),
    section.unwrap_or(0),
    is_texture.unwrap_or(false),
    envelope,
    note_id.unwrap_or(0),
  )
}

#[tauri::command]
pub fn audio_release_note(note_id: u64, fade_secs: Option<f32>) -> Result<(), String> {
  engine().release_note(note_id, fade_secs.unwrap_or(0.0))
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
}

// One invoke carrying N per-track updates. RAF push in JS hits this
// once per animation frame for hand-edits / non-LFO knob moves —
// audio-rate LFO modulation no longer rides this path (the audio
// thread reads the LFO snapshot directly and writes `_eff` atomics).
#[tauri::command]
pub fn audio_set_track_filters_bulk(updates: Vec<TrackFilterUpdate>) -> Result<(), String> {
  let e = engine();
  for u in updates {
    e.set_track_filter(u.track_id.clone(), u.cutoff_norm, u.resonance);
    e.set_track_fx_send(u.track_id, u.fx_send);
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
pub fn audio_glitch_fire() -> Result<(), String> {
  engine().glitch_fire();
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
) -> Result<(), String> {
  engine().start_recording_combined(app, path)
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
