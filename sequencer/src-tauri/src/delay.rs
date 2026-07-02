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

// Hard ceiling on the fed-back signal. tanh(x/CEIL)*CEIL has unit slope at
// the origin, so musical-level echoes (|x| ≲ 1) pass through effectively
// untouched (<0.25dB compression at full scale) — runaway feedback (fb > 1,
// per broken-ranges) still self-oscillates and screams, but settles into a
// bounded analog-style saturation around ~2-3x full scale instead of growing
// to f32::INFINITY. Unbounded growth was the real bug: inf reaching the
// master stage turns into 0×inf = NaN, which latches in every downstream
// biquad/envelope and leaves the output permanently dead (even Panic only
// cleared the delay line, not the poisoned master state).
const FB_CEIL: f32 = 4.0;

#[inline]
fn bound_feedback(x: f32) -> f32 {
  (x * (1.0 / FB_CEIL)).tanh() * FB_CEIL
}

pub struct DelayBus {
  buf_l: Vec<f32>,
  buf_r: Vec<f32>,
  cap: usize,
  write: usize,
  sample_rate: f32,
  // One-pole LP state for the feedback signal (per channel).
  fb_lp_l: f32,
  fb_lp_r: f32,
  // One-pole LP state for the fresh input (per channel) — the first tap gets
  // the same darkening as the repeats, so echo 1 sounds like "a repeat" rather
  // than a full-brightness clone of the dry hit.
  in_lp_l: f32,
  in_lp_r: f32,
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
      in_lp_l: 0.0,
      in_lp_r: 0.0,
    }
  }

  // Panic: zero the delay line + feedback-LP state so a runaway / self-
  // oscillating tail (feedback near the top of its range) is killed instantly.
  // The Vecs are already allocated, so this is allocation-free / audio-thread
  // safe. Capacity and sample rate are untouched.
  pub fn clear(&mut self) {
    for s in self.buf_l.iter_mut() {
      *s = 0.0;
    }
    for s in self.buf_r.iter_mut() {
      *s = 0.0;
    }
    self.write = 0;
    self.fb_lp_l = 0.0;
    self.fb_lp_r = 0.0;
    self.in_lp_l = 0.0;
    self.in_lp_r = 0.0;
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
    // Flush any non-finite feedback-LP state (e.g. inherited from a buffer
    // poisoned before the bound below existed, or a 0×inf on a knob move).
    // One branch per block; keeps a transient NaN from circulating forever.
    if !(self.fb_lp_l.is_finite()
      && self.fb_lp_r.is_finite()
      && self.in_lp_l.is_finite()
      && self.in_lp_r.is_finite())
    {
      self.clear();
    }
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
    // Energy compensation for the ping-pong input fold below. Folding both
    // channels onto the left line sums a centered send coherently (+6dB in-
    // channel at p=1), which made the first echo LOUDER than the dry hit and
    // read as "the hit got panned". 1/sqrt(1+p^2) keeps a centered send at
    // constant energy across the whole pingpong range.
    let fold_norm = 1.0 / (1.0 + p * p).sqrt();
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
      // Ping-pong input routing. The cross-fed feedback above can only BOUNCE a
      // signal that's already asymmetric — a centered/mono send writes equally
      // to both lines, which then stay symmetric forever (no width). So as p
      // rises, fold the input onto the LEFT line only: at p=1 the first echo is
      // hard-left and the cross-feed walks it L→R→L. At p=0 it's untouched
      // (straight per-channel stereo delay).
      let in_left = (in_l[i] + p * in_r[i]) * fold_norm;
      let in_right = (1.0 - p) * in_r[i] * fold_norm;
      // Darken the fresh input with the same one-pole as the feedback path so
      // the FIRST echo already has repeat tone (slightly dark) instead of
      // arriving as a full-brightness clone of the dry hit.
      self.in_lp_l += lp * (in_left - self.in_lp_l);
      self.in_lp_r += lp * (in_right - self.in_lp_r);
      // Bound the fed-back component (not the fresh input) so fb > 1
      // self-oscillates at a stable ceiling instead of running to inf.
      self.buf_l[self.write] = self.in_lp_l + bound_feedback(deg_l * fb);
      self.buf_r[self.write] = self.in_lp_r + bound_feedback(deg_r * fb);
      out_l[i] = yl;
      out_r[i] = yr;
      self.write = (self.write + 1) % self.cap;
    }
  }
}
