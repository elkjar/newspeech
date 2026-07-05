// VoicePickerDialog — modal voice/instrument picker for a track row.
// Replaces the per-row <select> as the voice library scales past what fits
// in a native dropdown. Grouped list + search field; click highlights,
// "assign" commits.
//
// Source kinds it produces (forwarded to setTrackSource via onPick):
//   - { kind: 'empty' }       — clear the row
//   - { kind: 'voice', id }   — internal sample/synth voice from the registry
//   - { kind: 'instrument', id } — user-defined MIDI instrument
// Plus a `+ new instrument` row per role that opens NewInstrumentDialog
// via the onNewInstrument callback (parent owns that dialog lifecycle).

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TrackSection } from '../state/store';
import type { Instrument, InstrumentRole, TrackSource } from '../instruments/library';
import { INSTRUMENTS } from '../instruments/library';
import { useUserInstrumentsStore } from '../instruments/userInstrumentsStore';
import { useRegistryKits } from '../instruments/useRegistryKits';
import { useRegistryVoices } from '../instruments/useRegistryVoices';
import type { VoiceDef } from '../audio/voices';
import type { RegisteredKit } from '../instruments/manifestRegistry';

interface PickerItem {
  key: string;                  // unique within the dialog
  kind: 'voice' | 'instrument' | 'new-instrument' | 'empty';
  id: string;                   // voice id, instrument id, or '<role>' for new-instrument
  label: string;
  // Source pack hint shown as secondary text on the row (e.g. "user/cassette-pack").
  hint?: string;
  // For voice items inside drum-kit groups: the kit's full path. Used to
  // remember the last-used drum kit so the next open auto-expands the same
  // group (kit-stickiness across consecutive drum-track edits).
  kitPath?: string;
}

interface PickerGroup {
  key: string;
  label: string;
  items: PickerItem[];
  // Drum-kit groups default-collapse — at 5–10 kits with 7–9 voices each the
  // flat list would be a wall. Header click toggles. Search expands everything
  // implicitly (matching items always render regardless of collapsed state).
  collapsedByDefault?: boolean;
}

// Session-scoped memory of the last drum kit the user picked from. Survives
// dialog open/close but not app restart (which is fine — the per-track
// source assignments themselves persist via the store). Used to override
// the default-collapsed state of one drum-kit group at picker-open time so
// consecutive drum-track edits land back in the same kit without hunting.
let lastDrumKitPath: string | null = null;

function kitDisplayName(kit: RegisteredKit): string {
  // Strip "user/" or "drums/"/"instruments/"/"pads/" prefix for display.
  const trimmed = kit.kitPath.startsWith('user/')
    ? kit.kitPath.slice('user/'.length)
    : kit.kitPath;
  const slash = trimmed.indexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function kitParentFolder(kit: RegisteredKit): string {
  const trimmed = kit.kitPath.startsWith('user/')
    ? kit.kitPath.slice('user/'.length)
    : kit.kitPath;
  const slash = trimmed.indexOf('/');
  return slash >= 0 ? trimmed.slice(0, slash) : trimmed;
}

// The four melodic-section categories shown in the picker, in display
// order. Drum-section rows ignore these and show a single drums group.
const MELODIC_CATEGORIES = ['instruments', 'pads', 'bass', 'textures'] as const;
type MelodicCategory = (typeof MELODIC_CATEGORIES)[number];

// Maps MIDI instrument roles to picker categories. drum-role lives in the
// drum section's group and never appears here.
const ROLE_TO_CATEGORY: Record<InstrumentRole, MelodicCategory | 'drum'> = {
  lead: 'instruments',
  bass: 'bass',
  pad: 'pads',
  texture: 'textures',
  drum: 'drum',
};

// Determines which picker categories a sample voice belongs to. A voice
// usually lands in one category, but `pickerCategories` in the manifest
// can multi-list (e.g. mini-moog appears under both instruments and bass).
//   * Drum-folder voices: always single 'drum'.
//   * Manifest pickerCategories override: explicit list wins over inference.
//   * Flat (rootless) voices: forced into 'textures' (pitchless one-shots).
//   * Otherwise: folder name → category, defaulting to 'instruments'.
function voiceCategoriesForKit(
  kit: RegisteredKit,
  voiceId: string,
): MelodicCategory[] | 'drum' {
  const voice = kit.manifest.voices[voiceId];
  const folder = kitParentFolder(kit);
  if (folder === 'drums') return 'drum';
  if (voice?.pickerCategories && voice.pickerCategories.length > 0) {
    const valid = voice.pickerCategories.filter(
      (c): c is MelodicCategory => (MELODIC_CATEGORIES as readonly string[]).includes(c),
    );
    if (valid.length > 0) return valid;
  }
  if (voice && !voice.roots && voice.files && voice.files.length > 0) {
    return ['textures'];
  }
  if (folder === 'pads' || folder === 'bass' || folder === 'textures') {
    return [folder as MelodicCategory];
  }
  return ['instruments'];
}

function buildGroups(
  section: TrackSection,
  voices: VoiceDef[],
  kits: readonly RegisteredKit[],
  userInstruments: Record<string, Instrument>,
): PickerGroup[] {
  const isDrum = section === 'drum';
  const voiceById = new Map<string, VoiceDef>();
  for (const v of voices) voiceById.set(v.id, v);
  const allInstruments: Instrument[] = [
    ...INSTRUMENTS,
    ...Object.values(userInstruments),
  ];

  const groups: PickerGroup[] = [];
  // Always lead with "none / clear" so it's a single-click to empty a row.
  groups.push({
    key: 'none',
    label: 'none',
    items: [{ key: 'empty', kind: 'empty', id: '', label: '— empty —' }],
  });

  if (isDrum) {
    // Drum section: one group per kit. The "kit first, then voice" workflow
    // lives entirely inside this section.
    const drumKits = kits
      .filter((k) => k.category === 'drum')
      .slice()
      .sort((a, b) => a.kitPath.localeCompare(b.kitPath));
    for (const kit of drumKits) {
      const items: PickerItem[] = [];
      for (const [voiceId, vm] of Object.entries(kit.manifest.voices)) {
        const def = voiceById.get(voiceId);
        const label = def?.label ?? vm.label ?? voiceId;
        items.push({
          key: `voice:${voiceId}`,
          kind: 'voice',
          id: voiceId,
          label,
          hint: 'sample',
          kitPath: kit.kitPath,
        });
      }
      items.sort((a, b) => a.label.localeCompare(b.label));
      if (items.length === 0) continue;
      groups.push({
        key: `drum-kit-${kit.kitPath}`,
        label: kitDisplayName(kit),
        items,
        collapsedByDefault: true,
      });
    }
    // MIDI drum instruments combined into one group with `midi` tag.
    const drumInstrItems: PickerItem[] = allInstruments
      .filter((i) => i.role === 'drum')
      .map<PickerItem>((i) => ({
        key: `instrument:${i.id}`,
        kind: 'instrument',
        id: i.id,
        label: i.label,
        hint: 'midi',
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    drumInstrItems.push({
      key: 'new-drum',
      kind: 'new-instrument',
      id: 'drum',
      label: '+ new instrument',
    });
    groups.push({
      key: 'midi-drum',
      label: 'midi instruments',
      items: drumInstrItems,
      collapsedByDefault: true,
    });
    return groups;
  }

  // Melodic section: four flat category groups. Each combines sample
  // voices + MIDI instruments under the matching role, with a `sample` or
  // `midi` tag on each row so the kind stays legible without a separate
  // group level.
  const byCategory: Record<MelodicCategory, PickerItem[]> = {
    instruments: [],
    pads: [],
    bass: [],
    textures: [],
  };

  for (const kit of kits) {
    if (kit.category !== 'melodic') continue;
    for (const [voiceId, vm] of Object.entries(kit.manifest.voices)) {
      const cats = voiceCategoriesForKit(kit, voiceId);
      if (cats === 'drum') continue;
      const def = voiceById.get(voiceId);
      const label = def?.label ?? vm.label ?? voiceId;
      for (const cat of cats) {
        byCategory[cat].push({
          // Include cat in the key so a voice appearing in multiple
          // categories doesn't collide on React's key uniqueness check.
          key: `voice:${cat}:${kit.kitPath}:${voiceId}`,
          kind: 'voice',
          id: voiceId,
          label,
          hint: 'sample',
        });
      }
    }
  }

  for (const inst of allInstruments) {
    const cat = ROLE_TO_CATEGORY[inst.role];
    if (cat === 'drum') continue;
    byCategory[cat].push({
      key: `instrument:${inst.id}`,
      kind: 'instrument',
      id: inst.id,
      label: inst.label,
      hint: 'midi',
    });
  }

  for (const cat of MELODIC_CATEGORIES) {
    const items = byCategory[cat].slice().sort((a, b) => a.label.localeCompare(b.label));
    // Append a "+ new instrument" anchor under the matching MIDI role so
    // the user can keep authoring MIDI instruments without leaving the
    // picker. The role maps back from the category via ROLE_TO_CATEGORY's
    // inverse (only invertable for lead/bass/pad — textures has no MIDI
    // counterpart so we skip the new-instrument anchor there).
    const newInstrumentRole: InstrumentRole | null =
      cat === 'instruments' ? 'lead' : cat === 'bass' ? 'bass' : cat === 'pads' ? 'pad' : null;
    if (newInstrumentRole) {
      items.push({
        key: `new-${newInstrumentRole}`,
        kind: 'new-instrument',
        id: newInstrumentRole,
        label: '+ new midi instrument',
      });
    }
    if (items.length === 0) continue;
    groups.push({
      key: `cat-${cat}`,
      label: cat,
      items,
    });
  }

  return groups;
}

function matchesSearch(item: PickerItem, group: PickerGroup, q: string): boolean {
  if (!q) return true;
  const hay = `${item.label} ${item.id} ${group.label} ${item.hint ?? ''}`.toLowerCase();
  return hay.includes(q);
}

function isSourceItem(source: TrackSource, item: PickerItem): boolean {
  if (item.kind === 'empty') return source.kind === 'empty';
  if (item.kind === 'voice') return source.kind === 'voice' && source.id === item.id;
  if (item.kind === 'instrument') return source.kind === 'instrument' && source.id === item.id;
  return false;
}

export function VoicePickerDialog({
  open,
  section,
  source,
  onPick,
  onNewInstrument,
  onCancel,
}: {
  open: boolean;
  section: TrackSection;
  source: TrackSource;
  onPick: (next: TrackSource) => void;
  onNewInstrument: (role: InstrumentRole) => void;
  onCancel: () => void;
}) {
  const voices = useRegistryVoices();
  const kits = useRegistryKits();
  const userInstruments = useUserInstrumentsStore((s) => s.userInstruments);

  const groups = useMemo(
    () => buildGroups(section, voices, kits, userInstruments),
    [section, voices, kits, userInstruments],
  );

  const [search, setSearch] = useState('');
  // Collapsed-group state, keyed by group.key. Drum-kit groups (and user
  // drum kits) default-collapse via group.collapsedByDefault. Header click
  // toggles. Search bypasses collapse — any group with a matching item
  // expands implicitly while the search is active.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) {
      setSearch('');
      // Reset collapsed state per open so default-collapsed groups start
      // closed each time the picker is reopened — EXCEPT for the
      // last-used drum kit, which we re-expand to keep kit-stickiness
      // across consecutive drum-track edits. lastDrumKitPath is module-
      // level (session-scoped); see top of file.
      const initial: Record<string, boolean> = {};
      for (const g of groups) {
        if (g.collapsedByDefault) initial[g.key] = true;
      }
      if (section === 'drum' && lastDrumKitPath) {
        for (const g of groups) {
          if (g.items.some((it) => it.kitPath === lastDrumKitPath)) {
            initial[g.key] = false;
            break;
          }
        }
      }
      setCollapsed(initial);
    }
  }, [open, groups, section]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const searchActive = q.length > 0;

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Click immediately commits — no separate assign step. Single-click model
  // matches user intent ("pick this voice now"); cancel paths remain via Esc,
  // backdrop click, or the close button.
  const handleItemClick = (item: PickerItem) => {
    if (item.kind === 'new-instrument') {
      onNewInstrument(item.id as InstrumentRole);
      return;
    }
    if (item.kind === 'empty') {
      onPick({ kind: 'empty' });
      return;
    }
    if (item.kind === 'voice') {
      // Remember the kit on drum picks so the next drum-row open re-expands
      // the same group.
      if (section === 'drum' && item.kitPath) {
        lastDrumKitPath = item.kitPath;
      }
      onPick({ kind: 'voice', id: item.id });
      return;
    }
    if (item.kind === 'instrument') {
      onPick({ kind: 'instrument', id: item.id });
      return;
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[640px] max-h-[80vh] flex flex-col p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white text-sm normal-case tracking-normal">
            {section === 'drum' ? 'pick drum source' : 'choose instrument'}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="text-white/40 hover:text-white text-base leading-none"
            aria-label="close"
            title="close"
          >
            ×
          </button>
        </div>

        <input
          autoFocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search…"
          className="mb-3 bg-transparent border border-white/15 px-3 py-1.5 text-[12px] normal-case tracking-normal text-white focus:outline-none focus:border-white"
        />

        <div className="flex-1 overflow-y-auto -mx-2 pl-2 pr-4 normal-case tracking-normal">
          {groups.map((group) => {
            const visible = group.items.filter((it) => matchesSearch(it, group, q));
            if (visible.length === 0) return null;
            // Collapsed state: honor toggle unless a search is active (search
            // implicitly expands every group with matches so users see hits).
            const isCollapsed = !searchActive && collapsed[group.key] === true;
            return (
              <div key={group.key} className="mb-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className="flex items-center gap-2 w-full text-left text-[10px] uppercase tracking-widest text-white/40 hover:text-white/80 transition-colors py-1"
                >
                  <span className="inline-block w-3 text-white/50">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span>{group.label}</span>
                  <span className="text-white/25 tabular-nums">{visible.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="flex flex-col">
                    {visible.map((item) => {
                      const isCurrent = isSourceItem(source, item);
                      const isNew = item.kind === 'new-instrument';
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => handleItemClick(item)}
                          className={[
                            'flex items-center justify-between px-2 py-1 text-[12px] text-left transition-colors',
                            isCurrent
                              ? 'bg-white text-ink'
                              : isNew
                                ? 'text-white/50 hover:text-white hover:bg-white/[0.06]'
                                : 'text-white/85 hover:text-white hover:bg-white/[0.06]',
                          ].join(' ')}
                        >
                          <span className="truncate">{item.label}</span>
                          {item.hint && (
                            <span
                              className={[
                                'shrink-0 ml-3 text-[10px] tabular-nums',
                                isCurrent ? 'text-ink/60' : 'text-white/35',
                              ].join(' ')}
                            >
                              {item.hint}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {groups.every(
            (g) => g.items.filter((it) => matchesSearch(it, g, q)).length === 0,
          ) && (
            <div className="text-white/40 text-[12px] py-6 text-center">no matches</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
