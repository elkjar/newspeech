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

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleRate, Stream, StreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::Serialize;

use crate::reverb::ReverbBus;

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

// Shared per-track filter state. Cutoff arrives in Hz (the JS side does the
// log mapping from 0..1 store space to 50..18000 Hz, matching the Web Audio
// worklet's input convention). Resonance is 0..1.
//
// Stored as Arc<TrackParams> so every voice triggered for the track holds
// the same reference and reads coefficient changes immediately (knob twists
// hit existing voices, not just future triggers).
pub struct TrackParams {
  cutoff_hz: AtomicU32,
  resonance: AtomicU32,
  // 0..1 — portion of the voice signal routed to the global reverb bus.
  // The voice's dry signal is attenuated by (1 - fx_send) and the wet
  // contribution scaled by fx_send. Per-voice mix, audio-rate atomic.
  fx_send: AtomicU32,
}

impl TrackParams {
  fn new() -> Self {
    Self {
      cutoff_hz: AtomicU32::new(18000.0_f32.to_bits()),
      resonance: AtomicU32::new(0.0_f32.to_bits()),
      fx_send: AtomicU32::new(0.0_f32.to_bits()),
    }
  }
  fn cutoff(&self) -> f32 {
    f32::from_bits(self.cutoff_hz.load(Ordering::Relaxed))
  }
  fn resonance(&self) -> f32 {
    f32::from_bits(self.resonance.load(Ordering::Relaxed))
  }
  fn fx_send(&self) -> f32 {
    f32::from_bits(self.fx_send.load(Ordering::Relaxed))
  }
  fn set_filter(&self, cutoff_hz: f32, resonance: f32) {
    self.cutoff_hz.store(cutoff_hz.to_bits(), Ordering::Release);
    self.resonance.store(resonance.to_bits(), Ordering::Release);
  }
  fn set_fx_send(&self, fx_send: f32) {
    self.fx_send.store(fx_send.to_bits(), Ordering::Release);
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
  size: AtomicU32,
  wet_gain: AtomicU32,
  diffusion: AtomicU32,
  damping: AtomicU32,
  // Bypass skips reverb.process_block entirely. Distinct from
  // SharedState::fx_bypass — that one kills the whole FX chain
  // (silencing voice wet contributions); this one just removes
  // reverb from the chain so future tape/glitch stages still process.
  bypass: AtomicBool,
}

impl ReverbState {
  fn new() -> Self {
    Self {
      size: AtomicU32::new(0.7_f32.to_bits()),
      // wet_gain defaults to 0 — silent until the user dials in a mix.
      wet_gain: AtomicU32::new(0.0_f32.to_bits()),
      diffusion: AtomicU32::new(0.625_f32.to_bits()),
      damping: AtomicU32::new(0.4_f32.to_bits()),
      bypass: AtomicBool::new(false),
    }
  }
}

static REVERB_STATE: OnceLock<ReverbState> = OnceLock::new();

fn reverb_state() -> &'static ReverbState {
  REVERB_STATE.get_or_init(ReverbState::new)
}

// --- pre-saturation shared state ---
//
// Tanh waveshaper applied to the dry voices sum on channels 0+1 before
// reverb output mixes in. Matches the web architecture's pre-saturation
// stage (between voicesBus and voicesPostFX). Only engages when
// multi-out is OFF — stems in multi-out mode are pre-master-drive by
// convention so the engineer/DAW does the saturation.
pub struct SaturationState {
  pre_drive: AtomicU32,
  bypass: AtomicBool,
}

impl SaturationState {
  fn new() -> Self {
    Self {
      pre_drive: AtomicU32::new(0.0_f32.to_bits()),
      bypass: AtomicBool::new(false),
    }
  }
}

static SATURATION_STATE: OnceLock<SaturationState> = OnceLock::new();

fn saturation_state() -> &'static SaturationState {
  SATURATION_STATE.get_or_init(SaturationState::new)
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

// --- voice pool ---

const VOICE_POOL_SIZE: usize = 64;
const TRIGGER_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
struct Voice {
  sample: Option<Arc<SampleData>>,
  position: f64,
  rate: f64,
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
}

impl Default for Voice {
  fn default() -> Self {
    Self {
      sample: None,
      position: 0.0,
      rate: 1.0,
      gain: 0.0,
      pan_left: 0.0,
      pan_right: 0.0,
      out_first: 0,
      out_stereo: true,
      track_params: None,
      filter: LadderFilter::default(),
      start_frame: 0,
      active: false,
    }
  }
}

enum MixerCommand {
  Trigger {
    sample: Arc<SampleData>,
    gain: f32,
    pan: f32,        // -1..1 (ignored when out_stereo=false)
    pitch: f32,      // 1.0 = native rate
    out_first: u32,  // first physical channel, 0-indexed
    out_stereo: bool,
    track_params: Option<Arc<TrackParams>>,
    // Frames to wait after this trigger is drained from the queue
    // before the voice begins emitting. 0 = fire immediately at start
    // of the next audio block (existing behavior). >0 = queue in
    // pending_triggers and fire sample-accurately when the deadline
    // falls within an audio block.
    delay_samples: u32,
  },
  StopAll,
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
  remaining_samples: i32,
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
      delay_samples,
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

  pub fn set_track_filter(&self, track_id: String, cutoff_hz: f32, resonance: f32) {
    let params = get_or_create_track_params(&track_id);
    params.set_filter(cutoff_hz.max(20.0).min(20000.0), resonance.clamp(0.0, 1.0));
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
    bypass: bool,
  ) {
    let r = reverb_state();
    r.size.store(size.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    r.wet_gain
      .store(wet_gain.clamp(0.0, 4.0).to_bits(), Ordering::Release);
    r.diffusion
      .store(diffusion.clamp(0.0, 0.85).to_bits(), Ordering::Release);
    r.damping
      .store(damping.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    r.bypass.store(bypass, Ordering::Release);
  }

  // Pre-saturation params. Stage lives outside the FX bus — it's a
  // pre-master drive applied to the dry-voices sum on channels 0+1
  // when multi-out is OFF (per the web architecture's saturation.ts).
  pub fn set_saturation_params(&self, pre_drive: f32, bypass: bool) {
    let s = saturation_state();
    s.pre_drive
      .store(pre_drive.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    s.bypass.store(bypass, Ordering::Release);
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

// Drops a PendingTrigger into a voice slot — picks an inactive slot,
// or steals one round-robin via steal_cursor if all are busy. Used by
// both the immediate-fire path (delay_samples == 0) and the
// sample-accurate dispatch path (delay reached this block).
fn claim_voice_slot(
  voices: &mut [Voice],
  steal_cursor: &mut usize,
  p: PendingTrigger,
  start_frame: usize,
) {
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
  v.gain = p.gain;
  v.pan_left = p.pan_left;
  v.pan_right = p.pan_right;
  v.out_first = p.out_first;
  v.out_stereo = p.out_stereo;
  v.track_params = p.track_params;
  v.filter.reset();
  v.start_frame = start_frame;
  v.active = true;
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
  let mut pending_triggers: Vec<PendingTrigger> = Vec::with_capacity(64);
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
              delay_samples,
            } => {
              let pan_clamped = pan.clamp(-1.0, 1.0);
              let angle =
                (pan_clamped + 1.0) * 0.5 * std::f32::consts::FRAC_PI_2;
              let pan_left = angle.cos();
              let pan_right = angle.sin();
              let base_rate = sample.sample_rate as f64 / device_sr_f64;
              let rate = base_rate * (pitch.max(0.001) as f64);
              let pending = PendingTrigger {
                sample,
                rate,
                gain,
                pan_left,
                pan_right,
                out_first: out_first as usize,
                out_stereo,
                track_params,
                remaining_samples: delay_samples as i32,
              };
              if delay_samples == 0 {
                claim_voice_slot(&mut voices, &mut steal_cursor, pending, 0);
              } else {
                pending_triggers.push(pending);
              }
            }
            MixerCommand::StopAll => {
              for v in voices.iter_mut() {
                v.active = false;
                v.sample = None;
                v.track_params = None;
                v.filter.reset();
                v.start_frame = 0;
              }
              pending_triggers.clear();
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
            claim_voice_slot(&mut voices, &mut steal_cursor, p, start_frame);
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

        // Clear the reverb input bus for this block. Voices accumulate
        // their wet contribution into it during the loop below.
        let rev_frames = frames.min(REVERB_SCRATCH);
        for i in 0..rev_frames {
          reverb_in_l[i] = 0.0;
          reverb_in_r[i] = 0.0;
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
          let sample = match v.sample.as_ref() {
            Some(s) => s.clone(),
            None => {
              v.active = false;
              continue;
            }
          };
          // Per-trigger snapshot of the track params Arc. Reads off the
          // atomics each frame — cheap, lockfree.
          let track_params = v.track_params.clone();
          // Honor sample-accurate dispatch — voice may have been queued
          // to start partway into this block. Reset start_frame after
          // this block so subsequent blocks emit from frame 0.
          let start = v.start_frame;
          for frame in start..frames {
            let pos = v.position;
            let i0 = pos.floor() as usize;
            let frame_count = sample.frame_count();
            if i0 + 1 >= frame_count {
              v.active = false;
              v.sample = None;
              v.track_params = None;
              break;
            }
            let frac = (pos - i0 as f64) as f32;
            let inv = 1.0 - frac;
            let (mut ls, mut rs) = if sample.channels == 1 {
              let s0 = sample.frames[i0];
              let s1 = sample.frames[i0 + 1];
              let interp = s0 * inv + s1 * frac;
              (interp, interp)
            } else {
              let i0s = i0 * 2;
              let i1s = (i0 + 1) * 2;
              let s0l = sample.frames[i0s];
              let s1l = sample.frames[i1s];
              let s0r = sample.frames[i0s + 1];
              let s1r = sample.frames[i1s + 1];
              (s0l * inv + s1l * frac, s0r * inv + s1r * frac)
            };
            if let Some(p) = track_params.as_ref() {
              let fc = p.cutoff();
              let res = p.resonance();
              let (fl, fr) = v.filter.process_stereo(ls, rs, fc, res, sr_f32);
              ls = fl;
              rs = fr;
            }
            // Effective fx_send is 0 when the FX bus is bypassed —
            // dry passes through at full level, no wet accumulates.
            // Voice's stored fx_send is preserved in TrackParams so
            // turning bypass off restores the prior amount with no
            // discontinuity.
            let raw_fx_send = track_params
              .as_ref()
              .map(|p| p.fx_send())
              .unwrap_or(0.0);
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
            let (route_first, route_stereo) = if multi_out_now {
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
          }
          // Block-end reset — subsequent blocks emit from frame 0.
          v.start_frame = 0;
        }

        // 3.5) Pre-master saturation — applied to the dry voices +
        // test-tone sum on channels 0+1 BEFORE reverb's wet adds in.
        // Matches web architecture's saturation.ts: tanh waveshaper
        // between voicesBus and voicesPostFX, so the reverb tail
        // doesn't get saturated. Engages only when multi-out is OFF
        // (folded-to-stereo mode) — multi-out stems stay pre-drive
        // by convention so the DAW/FOH does the saturation.
        if !multi_out_now {
          let sat = saturation_state();
          let sat_bypass = sat.bypass.load(Ordering::Acquire);
          let drive = f32::from_bits(sat.pre_drive.load(Ordering::Relaxed));
          if !sat_bypass && drive > 0.001 {
            if n_ch >= 1 {
              for frame in 0..frames {
                let idx = frame * n_ch;
                buf[idx] = pre_saturate_sample(buf[idx], drive);
              }
            }
            if n_ch >= 2 {
              for frame in 0..frames {
                let idx = frame * n_ch + 1;
                buf[idx] = pre_saturate_sample(buf[idx], drive);
              }
            }
          }
        }

        // 4) Reverb — apply current params, process the wet bus, route
        // the result. Skipped when fx_bypass or reverb's own bypass
        // toggle is on. Output channel pair depends on multi_out:
        // OFF → always 0+1 stereo (monitor fold); ON → fx_out_first /
        // fx_out_stereo (user-assigned, e.g. outs 7+8 for stems).
        let r = reverb_state();
        let reverb_bypass_now = r.bypass.load(Ordering::Acquire);
        let size = f32::from_bits(r.size.load(Ordering::Relaxed));
        let wet_gain = f32::from_bits(r.wet_gain.load(Ordering::Relaxed));
        let diffusion = f32::from_bits(r.diffusion.load(Ordering::Relaxed));
        let damping = f32::from_bits(r.damping.load(Ordering::Relaxed));
        reverb_bus.set_size(size);
        reverb_bus.set_diffusion(diffusion);
        reverb_bus.set_damping(damping);
        let fx_active = !fx_bypass_now && !reverb_bypass_now;
        if fx_active && rev_frames > 0 {
          reverb_bus.process_block(
            &reverb_in_l[..rev_frames],
            &reverb_in_r[..rev_frames],
            &mut reverb_out_l[..rev_frames],
            &mut reverb_out_r[..rev_frames],
          );
          if wet_gain > 0.0 {
            let (out_first, out_stereo) = if multi_out_now {
              (fx_out_first, fx_out_stereo)
            } else {
              (0usize, true)
            };
            if out_stereo {
              let l_idx = out_first;
              let r_idx = out_first + 1;
              if l_idx < n_ch {
                for frame in 0..rev_frames {
                  buf[frame * n_ch + l_idx] += reverb_out_l[frame] * wet_gain;
                }
              }
              if r_idx < n_ch {
                for frame in 0..rev_frames {
                  buf[frame * n_ch + r_idx] += reverb_out_r[frame] * wet_gain;
                }
              }
            } else if out_first < n_ch {
              // Mono FX out — sum L+R*0.5 into a single channel.
              for frame in 0..rev_frames {
                let mono = 0.5 * (reverb_out_l[frame] + reverb_out_r[frame]);
                buf[frame * n_ch + out_first] += mono * wet_gain;
              }
            }
          }
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

#[tauri::command]
pub fn audio_trigger_sample(
  path: String,
  gain: Option<f32>,
  pan: Option<f32>,
  pitch: Option<f32>,
  out_first: Option<u32>,
  out_stereo: Option<bool>,
  track_id: Option<String>,
  delay_secs: Option<f32>,
) -> Result<(), String> {
  engine().trigger_sample(
    path,
    gain.unwrap_or(1.0),
    pan.unwrap_or(0.0),
    pitch.unwrap_or(1.0),
    out_first.unwrap_or(0),
    out_stereo.unwrap_or(true),
    track_id,
    delay_secs.unwrap_or(0.0),
  )
}

#[tauri::command]
pub fn audio_set_track_filter(
  track_id: String,
  cutoff_hz: f32,
  resonance: f32,
) -> Result<(), String> {
  engine().set_track_filter(track_id, cutoff_hz, resonance);
  Ok(())
}

#[derive(serde::Deserialize)]
pub struct TrackFilterUpdate {
  pub track_id: String,
  pub cutoff_hz: f32,
  pub resonance: f32,
  pub fx_send: f32,
}

// One invoke carrying N per-track updates. The RAF-driven LFO push in
// JS hits this once per animation frame even when many tracks have LFO
// routings to filter params, capping IPC overhead at one round-trip.
#[tauri::command]
pub fn audio_set_track_filters_bulk(updates: Vec<TrackFilterUpdate>) -> Result<(), String> {
  let e = engine();
  for u in updates {
    e.set_track_filter(u.track_id.clone(), u.cutoff_hz, u.resonance);
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
  bypass: Option<bool>,
) -> Result<(), String> {
  engine().set_reverb_params(size, wet_gain, diffusion, damping, bypass.unwrap_or(false));
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
pub fn audio_set_saturation_params(
  pre_drive: f32,
  bypass: Option<bool>,
) -> Result<(), String> {
  engine().set_saturation_params(pre_drive, bypass.unwrap_or(false));
  Ok(())
}

#[tauri::command]
pub fn audio_stop_all() -> Result<(), String> {
  engine().stop_all_voices()
}
