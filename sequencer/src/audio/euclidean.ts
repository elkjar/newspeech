export function euclidean(steps: number, hits: number, rotation = 0): boolean[] {
  if (steps <= 0) return [];
  const pattern = new Array<boolean>(steps).fill(false);
  if (hits <= 0) return pattern;
  const k = Math.min(hits, steps);
  const r = ((rotation % steps) + steps) % steps;
  for (let i = 0; i < steps; i++) {
    if ((i * k) % steps < k) {
      pattern[(i + r) % steps] = true;
    }
  }
  return pattern;
}
