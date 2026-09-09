// What the music is doing right now, for anything drawing at frame rate.
// Written by ReactiveVisual's audio:level listener (the one place the engine
// level arrives), read by the tube shader every frame. Plain mutable object:
// no store, no re-render on the audio path.
export const reactive = {
  // Smoothed output level 0..1 (fast attack, slow release).
  env: 0,
  // performance.now() of the last onset and how hard it hit (0..1).
  onsetAt: -1e9,
  onsetAmp: 0,
};
