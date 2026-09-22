import { Scope } from '../Scope';

// The engine scope in its own window (Chris 2026-09-22: "placing it on top
// of the rest of the data in that container doesn't work"). Waveform +
// bands of the output — the one thing on the desktop that moves under a
// record, and the visual's partner in the director's pair shots.
export function AudioWindow() {
  return (
    <div className="h-full px-2 pt-2 pb-1.5">
      <Scope />
    </div>
  );
}
