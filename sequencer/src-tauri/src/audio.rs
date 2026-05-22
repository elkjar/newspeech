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
  let mut reader = hound::WavReader::open(Path::new(path))
    .map_err(|e| format!("open wav: {}", e))?;
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
  },
  StopAll,
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
    thread::Builder::new()
      .name("sequence-audio-control".into())
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
    // Cache hit?
    {
      let registry = samples_registry()
        .lock()
        .map_err(|e| format!("registry lock: {}", e))?;
      if let Some(existing) = registry.get(&path) {
        let fc = existing.frame_count();
        return Ok(SampleLoadInfo {
          path: path.clone(),
          channels: existing.channels,
          sample_rate: existing.sample_rate,
          frames: fc as u32,
          duration_secs: if existing.sample_rate > 0 {
            fc as f32 / existing.sample_rate as f32
          } else {
            0.0
          },
        });
      }
    }
    let sample = load_wav(&path)?;
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
    let cmd = MixerCommand::Trigger {
      sample,
      gain,
      pan,
      pitch,
      out_first,
      out_stereo,
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
  let nominal_channels = channels as usize;
  let nominal_sr = sample_rate as f32;
  let device_sr_f64 = sample_rate as f64;

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

        // 1) Drain the trigger queue.
        while let Some(cmd) = consumer.try_pop() {
          match cmd {
            MixerCommand::Trigger {
              sample,
              gain,
              pan,
              pitch,
              out_first,
              out_stereo,
            } => {
              // Prefer an inactive slot; if all are busy, steal one
              // round-robin via steal_cursor.
              let slot = (0..VOICE_POOL_SIZE)
                .find(|i| !voices[*i].active)
                .unwrap_or_else(|| {
                  let s = steal_cursor;
                  steal_cursor = (steal_cursor + 1) % VOICE_POOL_SIZE;
                  s
                });
              let pan_clamped = pan.clamp(-1.0, 1.0);
              let angle =
                (pan_clamped + 1.0) * 0.5 * std::f32::consts::FRAC_PI_2;
              let pan_left = angle.cos();
              let pan_right = angle.sin();
              let base_rate = sample.sample_rate as f64 / device_sr_f64;
              let rate = base_rate * (pitch.max(0.001) as f64);
              voices[slot] = Voice {
                sample: Some(sample),
                position: 0.0,
                rate,
                gain,
                pan_left,
                pan_right,
                out_first: out_first as usize,
                out_stereo,
                active: true,
              };
            }
            MixerCommand::StopAll => {
              for v in voices.iter_mut() {
                v.active = false;
                v.sample = None;
              }
            }
          }
        }

        let frames = buf.len() / n_ch.max(1);

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

        // 3) Voices — per-voice routing.
        //   • Stereo voice: writes interpolated L/R to out_first / out_first+1
        //     with equal-power pan, channel bounds checked.
        //   • Mono voice:  writes 0.5×(L+R) sum to out_first only; pan is
        //     ignored (it's a stereo concept — on a mono out it would just
        //     attenuate). Bass / kick / centered leads ride mono pairs.
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
          for frame in 0..frames {
            let pos = v.position;
            let i0 = pos.floor() as usize;
            let frame_count = sample.frame_count();
            if i0 + 1 >= frame_count {
              v.active = false;
              v.sample = None;
              break;
            }
            let frac = (pos - i0 as f64) as f32;
            let inv = 1.0 - frac;
            let (ls, rs) = if sample.channels == 1 {
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
            if v.out_stereo {
              let l_idx = v.out_first;
              let r_idx = v.out_first + 1;
              if l_idx < n_ch {
                buf[frame * n_ch + l_idx] += ls * v.gain * v.pan_left;
              }
              if r_idx < n_ch {
                buf[frame * n_ch + r_idx] += rs * v.gain * v.pan_right;
              }
            } else if v.out_first < n_ch {
              let mono = 0.5 * (ls + rs);
              buf[frame * n_ch + v.out_first] += mono * v.gain;
            }
            v.position += v.rate;
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
pub fn audio_trigger_sample(
  path: String,
  gain: Option<f32>,
  pan: Option<f32>,
  pitch: Option<f32>,
  out_first: Option<u32>,
  out_stereo: Option<bool>,
) -> Result<(), String> {
  engine().trigger_sample(
    path,
    gain.unwrap_or(1.0),
    pan.unwrap_or(0.0),
    pitch.unwrap_or(1.0),
    out_first.unwrap_or(0),
    out_stereo.unwrap_or(true),
  )
}

#[tauri::command]
pub fn audio_stop_all() -> Result<(), String> {
  engine().stop_all_voices()
}
