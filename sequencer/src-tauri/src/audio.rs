// Native audio engine (Plan B foundation).
//
// Owns a cpal output stream on a dedicated control thread; the audio
// callback closure reads from an Arc<SharedState> using atomics so the
// real-time thread never blocks. Phase 0 mixer only emits silence or a
// per-channel sine test tone — voices, samples, FX, and the scheduler
// move in over subsequent phases.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, OnceLock};
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleRate, Stream, StreamConfig};
use serde::Serialize;

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

struct SharedState {
  // Mixer parameters — written by control commands, read by audio callback.
  channels: AtomicU32,
  sample_rate: AtomicU32,
  test_tone_enabled: AtomicBool,
  test_tone_channel: AtomicUsize,
  test_tone_freq_mhz: AtomicU32, // freq Hz * 1000
}

impl SharedState {
  fn new() -> Self {
    Self {
      channels: AtomicU32::new(0),
      sample_rate: AtomicU32::new(0),
      test_tone_enabled: AtomicBool::new(false),
      test_tone_channel: AtomicUsize::new(0),
      test_tone_freq_mhz: AtomicU32::new(440_000),
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
}

fn control_thread(rx: Receiver<EngineCommand>, state: Arc<SharedState>) {
  // The Stream is kept here; cpal::Stream is !Send on some platforms so
  // its lifetime must stay on this single thread.
  // _stream is held purely to keep the cpal output stream alive; the
  // compiler sees writes-only because audio runs through the closure.
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
        // Drop any existing stream before opening a new one.
        _stream = None;
        state.channels.store(0, Ordering::Release);
        state.sample_rate.store(0, Ordering::Release);
        state.test_tone_enabled.store(false, Ordering::Release);

        match build_stream(&device_name, channels, sample_rate, buffer_size, state.clone()) {
          Ok((s, info)) => {
            if let Err(e) = s.play() {
              let _ = reply.send(Err(format!("stream play: {}", e)));
              continue;
            }
            state.channels.store(info.channels, Ordering::Release);
            state.sample_rate.store(info.sample_rate, Ordering::Release);
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

  // Phase + last-channel are owned solely by the audio callback.
  let mut phase: f32 = 0.0;
  let mut last_ch: usize = usize::MAX;
  let nominal_channels = channels as usize;
  let nominal_sr = sample_rate as f32;

  let cb_state = state.clone();
  let stream = device
    .build_output_stream(
      &config,
      move |buf: &mut [f32], _info: &cpal::OutputCallbackInfo| {
        // Silence by default — every frame, every channel.
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
        let sr = {
          let v = cb_state.sample_rate.load(Ordering::Acquire) as f32;
          if v == 0.0 {
            nominal_sr
          } else {
            v
          }
        };

        if !cb_state.test_tone_enabled.load(Ordering::Acquire) {
          return;
        }
        let target_ch = cb_state.test_tone_channel.load(Ordering::Relaxed);
        if target_ch >= n_ch {
          return;
        }
        if target_ch != last_ch {
          phase = 0.0;
          last_ch = target_ch;
        }
        let freq = cb_state.test_tone_freq_mhz.load(Ordering::Relaxed) as f32 / 1000.0;
        let dphase = std::f32::consts::TAU * freq / sr;

        let frames = buf.len() / n_ch;
        for frame in 0..frames {
          let sample = phase.sin() * 0.2;
          buf[frame * n_ch + target_ch] = sample;
          phase += dphase;
          if phase > std::f32::consts::TAU {
            phase -= std::f32::consts::TAU;
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
