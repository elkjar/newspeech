export interface OverlayValue {
  on: boolean;
  velocity: number;
  pitch: number;
  gate: number;
}

const overlay = new Map<string, Map<number, OverlayValue>>();

export function setOverlay(trackId: string, stepIndex: number, val: OverlayValue): void {
  let m = overlay.get(trackId);
  if (!m) {
    m = new Map();
    overlay.set(trackId, m);
  }
  m.set(stepIndex, val);
}

export function getOverlay(trackId: string, stepIndex: number): OverlayValue | undefined {
  return overlay.get(trackId)?.get(stepIndex);
}

export function clearOverlay(): void {
  overlay.clear();
}
