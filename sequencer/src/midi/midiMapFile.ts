// `.midimap` file format — schema, serialize, parse, validate.
// Files are JSON with `version: 1`.

import { isValidTarget, type MidiBinding, type MidiTarget } from './midiMap';

export interface MidiMapFile {
  version: 1;
  id: string;
  name: string;
  controller?: string;       // substring matched against MIDI input port name
  source: 'bundled' | 'user';
  bindings: MidiBinding[];
  createdAt?: string;
}

const FILE_VERSION = 1 as const;

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

// Legacy target rewrites — applied at parse so old localStorage maps and
// `.midimap` files migrate transparently. Add entries here when targets
// get renamed; key = old string, value = current string.
const LEGACY_TARGET_RENAMES: Record<string, string> = {
  'transport:conductor': 'transport:ghost',
};

function validateBinding(x: unknown): MidiBinding | null {
  if (!isObject(x)) return null;
  const { ch, msg, num, target } = x;
  if (typeof ch !== 'number' || ch < 0 || ch > 15) return null;
  if (msg !== 'cc' && msg !== 'note') return null;
  if (typeof num !== 'number' || num < 0 || num > 127) return null;
  if (typeof target !== 'string') return null;
  const migrated = LEGACY_TARGET_RENAMES[target] ?? target;
  // Allow unknown targets to round-trip through save/load — dispatcher
  // silently ignores at runtime. This protects forward compatibility
  // when a `.midimap` is loaded on an older build.
  const binding: MidiBinding = {
    ch: Math.floor(ch),
    msg,
    num: Math.floor(num),
    target: migrated as MidiTarget,
  };
  // Preserve the relative-emulation flag (controllers that only send absolute
  // CC, treated as deltas at dispatch — e.g. Launch Control XL3 encoders).
  if (x.relative === true) binding.relative = true;
  return binding;
}

export function parseMidiMapFile(
  json: string,
  forcedSource?: 'bundled' | 'user'
): MidiMapFile | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  if (data.version !== FILE_VERSION) return null;
  if (typeof data.id !== 'string' || !data.id) return null;
  if (typeof data.name !== 'string' || !data.name) return null;
  if (!Array.isArray(data.bindings)) return null;
  const bindings: MidiBinding[] = [];
  for (const b of data.bindings) {
    const v = validateBinding(b);
    if (v) bindings.push(v);
  }
  return {
    version: FILE_VERSION,
    id: data.id,
    name: data.name,
    controller: typeof data.controller === 'string' ? data.controller : undefined,
    source:
      forcedSource ??
      (data.source === 'user' ? 'user' : 'bundled'),
    bindings,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
  };
}

export function serializeMidiMapFile(map: MidiMapFile): string {
  // Strip `source` on serialize — that's a runtime flag, not part of the
  // wire format. The loader reapplies it based on origin.
  const wire = {
    version: map.version,
    id: map.id,
    name: map.name,
    controller: map.controller,
    bindings: map.bindings,
    createdAt: map.createdAt,
  };
  return JSON.stringify(wire, null, 2);
}

export function listValidTargets(bindings: MidiBinding[]): MidiBinding[] {
  return bindings.filter((b) => isValidTarget(b.target));
}
