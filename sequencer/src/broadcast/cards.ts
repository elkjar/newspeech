// Station idents — the "ads" in the feed (Wreckage Systems injects
// support-65labs cards; ours point at the site, the plugins, the list, or
// ask nothing at all). A folder of plain-text cards beside the set:
//
//   CARDS/anything.txt
//     kind: ident | support | plugin      optional header lines
//     weight: 2                           (plays twice as often)
//     url: newspeechsound.com/plugins     (rendered small under the body)
//     <headline>                          first non-header line
//     <body line>                         up to two more
//
// Tokens filled live: {uptime} {songs} {played} {song} {bpm} {time}.
// README.txt is ignored. The folder is re-scanned every minute so cards can
// be dropped in while the runner is up.
//
// Scheduling is the slow machine's: a card every few minutes, on screen for
// half a minute, weighted random minus the last few shown. During an
// interstitial hold a card shows at once — the ident over the static.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { useBroadcast } from './setlist';
import { siblingFolders } from './gap';
import { fmtUptime } from './os/windows/NowWindow';
import { useSettings } from './settings';

export type CardKind = 'ident' | 'support' | 'plugin';

export interface Card {
  path: string;
  kind: CardKind;
  weight: number;
  url: string | null;
  headline: string;
  body: string[];
}

interface CardsState {
  cards: Card[];
  active: Card | null;
  shownAt: number; // performance.now()
  enabled: boolean;
  recent: string[];
  count: number;
}

const SHOW_MS = 32_000;
// Minutes between cards (after the previous one hides); first one sooner.
const FIRST_MIN = [3, 5];
const EVERY_MIN = [5, 9];
const jitter = ([a, b]: number[]) => (a + Math.random() * (b - a)) * 60_000;
const KIND_WEIGHT: Record<CardKind, number> = { ident: 1, support: 0.7, plugin: 0.7 };

export const useCards = create<CardsState>(() => ({
  cards: [],
  active: null,
  shownAt: 0,
  enabled: true,
  recent: [],
  count: 0,
}));

export function parseCard(path: string, text: string): Card | null {
  const lines = text.replace(/\r/g, '').split('\n');
  let kind: CardKind = 'ident';
  let weight = 1;
  let url: string | null = null;
  const body: string[] = [];
  let inHeader = true;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (inHeader) {
      const m = /^(kind|weight|url)\s*:\s*(.+)$/i.exec(line.trim());
      if (m) {
        const k = m[1].toLowerCase();
        const v = m[2].trim();
        if (k === 'kind' && (v === 'ident' || v === 'support' || v === 'plugin')) kind = v;
        else if (k === 'weight') weight = Math.max(0.1, Number(v) || 1);
        else if (k === 'url') url = v;
        continue;
      }
      if (line.trim() === '') continue;
      inHeader = false;
    }
    if (line.trim() === '' && body.length === 0) continue;
    body.push(line);
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  if (body.length === 0) return null;
  return { path, kind, weight, url, headline: body[0], body: body.slice(1, 3) };
}

export async function scanCards(setPaths: string[], explicitDir: string | null = null): Promise<void> {
  const files = new Set<string>();
  for (const dir of explicitDir ? [explicitDir] : siblingFolders(setPaths, 'CARDS')) {
    try {
      for (const f of await invoke<string[]>('list_dir_files', { dir, exts: ['txt', 'md'] })) files.add(f);
    } catch {
      // folder absent
    }
  }
  const cards: Card[] = [];
  for (const f of [...files].sort()) {
    if (/readme/i.test(f.split('/').pop() ?? '')) continue;
    try {
      const text = await invoke<string>('read_text_file', { path: f });
      const c = parseCard(f, text);
      if (c) cards.push(c);
    } catch (err) {
      console.warn('[cards] unreadable card:', f, err);
    }
  }
  const prev = useCards.getState().cards;
  if (cards.length !== prev.length || cards.some((c, i) => c.path !== prev[i]?.path)) {
    console.info(`[cards] ${cards.length} card(s)`);
  }
  useCards.setState({ cards });
}

// Fill the live tokens.
export function renderCardLine(line: string): string {
  const b = useBroadcast.getState();
  const s = useSequencerStore.getState();
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return line
    .replace(/\{uptime\}/g, fmtUptime(b.startedAt, Date.now()))
    .replace(/\{songs\}/g, String(b.entries.length))
    .replace(/\{played\}/g, String(b.played))
    .replace(/\{song\}/g, s.songTitle ?? 'untitled')
    .replace(/\{bpm\}/g, String(Math.round(s.bpm)))
    .replace(/\{time\}/g, time);
}

function pickCard(): Card | null {
  const { cards, recent } = useCards.getState();
  if (cards.length === 0) return null;
  const skip = new Set(recent.slice(-Math.min(Math.floor(cards.length / 2), 4)));
  const pool = cards.filter((c) => !skip.has(c.path));
  const from = pool.length ? pool : cards;
  const total = from.reduce((a, c) => a + c.weight * KIND_WEIGHT[c.kind], 0);
  let r = Math.random() * total;
  for (const c of from) {
    r -= c.weight * KIND_WEIGHT[c.kind];
    if (r <= 0) return c;
  }
  return from[from.length - 1];
}

export function showCard(card?: Card | null): void {
  const c = card ?? pickCard();
  if (!c) return;
  useCards.setState((s) => ({
    active: c,
    shownAt: performance.now(),
    recent: [...s.recent, c.path].slice(-8),
    count: s.count + 1,
  }));
  console.info(`[cards] show ${c.path.split('/').pop()}`);
}

export function hideCard(): void {
  if (useCards.getState().active) useCards.setState({ active: null });
}

export function setCardsEnabled(v: boolean): void {
  useCards.setState({ enabled: v });
  if (!v) hideCard();
}

let timer: number | null = null;
let installed = false;
let rescan: number | null = null;

function scheduleNext(first: boolean): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    const { enabled, active } = useCards.getState();
    if (enabled && !active && useBroadcast.getState().status === 'running') {
      showCard();
      timer = window.setTimeout(() => {
        timer = null;
        hideCard();
        scheduleNext(false);
      }, SHOW_MS);
      return;
    }
    scheduleNext(false);
  }, jitter(first ? FIRST_MIN : EVERY_MIN));
}

export function installCards(getSetPaths: () => string[]): () => void {
  if (installed) return () => {};
  installed = true;
  scheduleNext(true);
  rescan = window.setInterval(() => void scanCards(getSetPaths(), useSettings.getState().cardsDir), 60_000);
  return () => {
    installed = false;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (rescan !== null) window.clearInterval(rescan);
    rescan = null;
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    installed = false;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (rescan !== null) window.clearInterval(rescan);
    rescan = null;
  });
}
