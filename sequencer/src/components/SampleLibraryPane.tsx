// SampleLibraryPane — manage sample kits parallel to InstrumentLibraryPane.
//
// Lists every registered kit grouped by category, matching the
// VoicePickerDialog's organization (drums → instruments → pads → bass →
// textures). Every kit lives on disk in the samples dir and gets
// reveal-in-finder and move-to-trash actions plus a rescan/open-folder
// header bar.

import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useRegistryKits } from '../instruments/useRegistryKits';
import { rescanAllKits, resolveUserSamplesDir } from '../instruments/userSamplesDir';
import { type RegisteredKit } from '../instruments/manifestRegistry';
import { ConfirmDialog } from './ConfirmDialog';

type Folder = 'drums' | 'instruments' | 'pads' | 'bass' | 'textures';
const FOLDER_ORDER: Folder[] = ['drums', 'instruments', 'pads', 'bass', 'textures'];

interface KitGroup {
  key: string;
  label: string;
  folder: Folder;
  kits: RegisteredKit[];
}

const NATIVE = isTauri();

function kitDisplayName(kit: RegisteredKit): string {
  const trimmed = kit.kitPath.startsWith('user/')
    ? kit.kitPath.slice('user/'.length)
    : kit.kitPath;
  const slash = trimmed.indexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function kitFolder(kit: RegisteredKit): Folder {
  const trimmed = kit.kitPath.startsWith('user/')
    ? kit.kitPath.slice('user/'.length)
    : kit.kitPath;
  const slash = trimmed.indexOf('/');
  const folder = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  if ((FOLDER_ORDER as readonly string[]).includes(folder)) return folder as Folder;
  return 'instruments';
}

function voiceCount(kit: RegisteredKit): number {
  return Object.keys(kit.manifest.voices).length;
}

function buildGroups(allKits: readonly RegisteredKit[]): KitGroup[] {
  const out: KitGroup[] = [];
  for (const folder of FOLDER_ORDER) {
    const kits = allKits
      .filter((k) => kitFolder(k) === folder)
      .slice()
      .sort((a, b) => a.kitPath.localeCompare(b.kitPath));
    if (kits.length === 0) continue;
    out.push({
      key: folder,
      label: folder,
      folder,
      kits,
    });
  }
  return out;
}

export function SampleLibraryPane() {
  const kits = useRegistryKits();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [userSamplesDir, setUserSamplesDir] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = useState<RegisteredKit | null>(null);

  useEffect(() => {
    setSearch('');
    if (NATIVE) void resolveUserSamplesDir().then(setUserSamplesDir);
  }, []);

  const groups = buildGroups(kits);
  const q = search.trim().toLowerCase();
  const searchActive = q.length > 0;
  const matches = (kit: RegisteredKit): boolean => {
    if (!q) return true;
    const voiceNames = Object.keys(kit.manifest.voices).join(' ');
    const hay = `${kitDisplayName(kit)} ${kit.kitPath} ${voiceNames}`.toLowerCase();
    return hay.includes(q);
  };
  const filteredGroups = groups
    .map((g) => ({ ...g, kits: g.kits.filter(matches) }))
    .filter((g) => g.kits.length > 0);
  const totalKits = kits.length;
  const visibleKits = filteredGroups.reduce((n, g) => n + g.kits.length, 0);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleRescan = async () => {
    setScanning(true);
    setScanStatus('rescanning…');
    try {
      await rescanAllKits();
      setScanStatus(null);
    } catch (err) {
      console.warn('[samples] rescan failed:', err);
      setScanStatus('rescan error — see console');
    } finally {
      setScanning(false);
    }
  };

  const handleRevealUserDir = async () => {
    if (!NATIVE || !userSamplesDir) return;
    try {
      await invoke('reveal_in_finder', { path: userSamplesDir });
    } catch (err) {
      console.warn('[samples] reveal user dir failed:', err);
    }
  };

  const handleRevealKit = async (kit: RegisteredKit) => {
    if (!NATIVE) return;
    try {
      // kit.baseUrl is the absolute filesystem path for user kits (passed in
      // userSamplesDir.ts as the kit's `absolute_dir`). Bundled kits use a
      // URL baseUrl and don't reveal usefully — gated upstream by source.
      await invoke('reveal_in_finder', { path: kit.baseUrl });
    } catch (err) {
      console.warn('[samples] reveal kit failed:', err);
    }
  };

  const handleConfirmTrash = async () => {
    const kit = confirmTrash;
    setConfirmTrash(null);
    if (!kit || !NATIVE) return;
    try {
      await invoke('trash_sample_kit', { path: kit.baseUrl });
      await rescanAllKits();
    } catch (err) {
      console.warn('[samples] trash kit failed:', err);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 mb-4 normal-case tracking-normal">
        <button
          type="button"
          onClick={handleRescan}
          disabled={scanning}
          className={
            scanning
              ? 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/10 text-white/30 cursor-not-allowed'
              : 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white text-white hover:bg-white/10 transition-colors'
          }
          title="reload sample kits from disk"
        >
          {scanning ? 'scanning…' : 'rescan'}
        </button>
        {NATIVE && (
          <button
            type="button"
            onClick={handleRevealUserDir}
            disabled={!userSamplesDir}
            className={
              userSamplesDir
                ? 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
                : 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/10 text-white/20 cursor-not-allowed'
            }
            title="open the user samples folder in finder"
          >
            open user folder
          </button>
        )}
        <span className="ml-auto text-white/55 text-[11px] normal-case tracking-normal">
          {searchActive
            ? `${visibleKits} / ${totalKits}`
            : `${totalKits} ${totalKits === 1 ? 'kit' : 'kits'}`}
        </span>
      </div>

      {scanStatus && (
        <div className="text-white/50 text-[11px] -mt-3 mb-3">{scanStatus}</div>
      )}

      {totalKits > 0 && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search…"
          className="mb-3 bg-transparent border border-white/15 px-3 py-1.5 text-[12px] normal-case tracking-normal text-white focus:outline-none focus:border-white"
        />
      )}

      <div className="normal-case tracking-normal">
        {totalKits === 0 && (
          <div className="text-white/40 text-[12px] py-6 text-center">
            no sample kits loaded — drop folders into the user samples dir and rescan
          </div>
        )}
        {totalKits > 0 && visibleKits === 0 && (
          <div className="text-white/40 text-[12px] py-6 text-center">no matches</div>
        )}
        {filteredGroups.map((group) => {
          const isCollapsed = !searchActive && collapsed[group.key];
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
                <span className="text-white/25 tabular-nums">{group.kits.length}</span>
              </button>
              {!isCollapsed &&
                group.kits.map((kit) => (
                  <KitRow
                    key={kit.kitPath}
                    kit={kit}
                    onReveal={() => handleRevealKit(kit)}
                    onTrash={() => setConfirmTrash(kit)}
                  />
                ))}
            </div>
          );
        })}
      </div>

      {confirmTrash && (
        <ConfirmDialog
          title="move kit to trash"
          body={`move "${kitDisplayName(confirmTrash)}" to the trash? you can drag it back out of finder if you change your mind.`}
          confirmLabel="trash"
          onConfirm={() => void handleConfirmTrash()}
          onCancel={() => setConfirmTrash(null)}
        />
      )}
    </div>
  );
}

function KitRow({
  kit,
  onReveal,
  onTrash,
}: {
  kit: RegisteredKit;
  onReveal: () => void;
  onTrash: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] hover:bg-white/[0.02] -mx-2 px-2 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-white truncate">{kitDisplayName(kit)}</span>
        <span className="text-white/30 text-[11px] tabular-nums shrink-0">
          {voiceCount(kit)} {voiceCount(kit) === 1 ? 'voice' : 'voices'}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <RowBtn onClick={onReveal} title="reveal in finder">
          reveal
        </RowBtn>
        <RowBtn onClick={onTrash} title="move kit to trash" danger>
          ×
        </RowBtn>
      </div>
    </div>
  );
}

function RowBtn({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const base =
    'px-2 py-0.5 text-[10px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center';
  const tone = danger
    ? 'border-white/10 text-white/40 hover:text-white hover:border-white'
    : 'border-white/15 text-white/60 hover:text-white hover:border-white';
  return (
    <button type="button" onClick={onClick} title={title} className={`${base} ${tone}`}>
      {children}
    </button>
  );
}
