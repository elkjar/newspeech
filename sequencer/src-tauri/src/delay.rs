// Hand-written stereo ping-pong delay for the per-instrument delay send.
// Mirrors the reverb send/return shape: a parallel aux fed by the additive
// per-voice `delay_send` bus, returned 100% wet. No Faust — delay is just a
// circular buffer + cross-channel feedback. Tempo-synced time is computed
// JS-side (note division + bpm → seconds) and pushed via IPC; this engine
// consumes a delay length in seconds and converts to samples per block.

// Longest synced time we support: a 1/2 note at ~30 BPM is 4s. Requests longer
// than this clamp (delay comes out shorter than asked). ~1.5 MB for the pair.
const MAX_DELAY_SECS: f32 = 4.0;

// Baseline feedback-path one-pole lowpass coefficient (the darkening at
// lofi=0 — the v1 tone). The lofi knob lowers this further toward FB_DAMP_MIN
// for a darker tail. Lower coefficient = more smoothing = darker.
const FB_DAMP: f32 = 0.35;
const FB_DAMP_MIN: f32 = 0.04;

pub struct DelayBus {
  buf_l: Vec<f32>,
  buf_r: Vec<f32>,
  cap: usize,
  write: usize,
  sample_rate: f32,
  // One-pole LP state for the feedback signal (per channel).
  fb_lp_l: f32,
  fb_lp_r: f32,
}

impl DelayBus {
  pub fn new(sample_rate: u32) -> Self {
    let cap = ((sample_rate as f32) * MAX_DELAY_SECS).ceil() as usize + 1;
    Self {
      buf_l: vec![0.0; cap],
      buf_r: vec![0.0; cap],
      cap,
      write: 0,
      sample_rate: sample_rate as f32,
      fb_lp_l: 0.0,
      fb_lp_r: 0.0,
    }
  }

  // Process one block, writing the 100%-wet delayed signal to (out_l, out_r).
  // `delay_seconds` = tempo-synced time; `feedback` 0..~1.1 (top runs away /
  // self-oscillates, per broken-ranges). `pingpong` 0..1 blends the feedback
  // routing: 0 = straight stereo (each channel feeds itself), 1 = full
  // cross-feed (repeats bounce L→R→L). `lofi` 0..1 degrades the feedback
  // (sample-rate reduction + bitcrush) so the tail decays into grit — it lives
  // IN the loop, so the crunch compounds per repeat. Changing `delay_seconds`
  // (a Time or BPM move) re-lengths the tap and bends in-flight repeats —
  // accepted behavior; a crossfade is later polish.
  pub fn process_block(
    &mut self,
    in_l: &[f32],
    in_r: &[f32],
    out_l: &mut [f32],
    out_r: &mut [f32],
    frames: usize,
    delay_seconds: f32,
    feedback: f32,
    pingpong: f32,
    lofi: f32,
  ) {
    let d = ((delay_seconds * self.sample_rate).round() as usize).clamp(1, self.cap - 1);
    let fb = feedback.clamp(0.0, 1.1);
    let p = pingpong.clamp(0.0, 1.0);
    let lf = lofi.clamp(0.0, 1.0);
    // Lofi = analog degradation: DARKEN (lower the feedback LP cutoff toward
    // FB_DAMP_MIN) + SATURATE (soft tanh). Both compound per repeat.
    let lp = (FB_DAMP - lf * (FB_DAMP - FB_DAMP_MIN)).max(FB_DAMP_MIN);
    // tanh(drive·x)/drive has UNIT slope at the origin → adds no loop gain
    // (stable inside the feedback), only softclips/warms larger signals more as
    // lofi rises. Blended in by lofi so lofi=0 is perfectly clean.
    let drive = 1.0 + lf * 5.0;
    let inv_drive = 1.0 / drive;
    for i in 0..frames {
      let read = (self.write + self.cap - d) % self.cap;
      let yl = self.buf_l[read];
      let yr = self.buf_r[read];
      // Ping-pong blend: route each channel's feedback from a mix of its own
      // read tap and the opposite channel's (p=1 → full cross = bounce).
      let fb_in_l = (1.0 - p) * yl + p * yr;
      let fb_in_r = (1.0 - p) * yr + p * yl;
      // Darken.
      self.fb_lp_l += lp * (fb_in_l - self.fb_lp_l);
      self.fb_lp_r += lp * (fb_in_r - self.fb_lp_r);
      // Saturate (dry ↔ softclip blend by lofi).
      let deg_l =
        (1.0 - lf) * self.fb_lp_l + lf * (drive * self.fb_lp_l).tanh() * inv_drive;
      let deg_r =
        (1.0 - lf) * self.fb_lp_r + lf * (drive * self.fb_lp_r).tanh() * inv_drive;
      self.buf_l[self.write] = in_l[i] + deg_l * fb;
      self.buf_r[self.write] = in_r[i] + deg_r * fb;
      out_l[i] = yl;
      out_r[i] = yr;
      self.write = (self.write + 1) % self.cap;
    }
  }
}
