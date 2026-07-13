// Auto-update check (tauri-plugin-updater).
//
// Installed testers have no other channel back to us — this check is what lets
// a shipped build ever be superseded, so it rides in every release from the
// first tester build onward. Manifest lives at the GitHub Releases `latest.json`
// (endpoint in tauri.conf.json); artifacts are signed with the keypair at
// ~/.tauri/sequence-updater.key (see scripts/release.sh).
//
// Flow: check → ask → downloadAndInstall → relaunch. Declining is final for the
// session (next launch asks again). The LAUNCH check is silent-to-console — an
// offline boot must never surface an updater error. The MANUAL check (settings
// panel button) returns a human-readable status so a failed check is visible.
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { isTauri } from '@tauri-apps/api/core';
import { useSequencerStore } from './state/store';

// Delay so the check never competes with audio-engine + sample-library boot.
const CHECK_DELAY_MS = 5000;

export function scheduleUpdateCheck(): void {
  if (!isTauri() || import.meta.env.DEV) return;
  window.setTimeout(() => {
    void runUpdateCheck();
  }, CHECK_DELAY_MS);
}

// Returns a status line for the manual path; the launch path ignores it.
export async function runUpdateCheck(manual = false): Promise<string> {
  if (!isTauri()) return 'updates only work in the app';
  try {
    const update = await check();
    if (!update) return 'up to date';

    const install = await ask(
      `Sequence ${update.version} is available (you have ${update.currentVersion}).\n\nDownload and install now? The app restarts when it's done.`,
      { title: 'Update available', kind: 'info', okLabel: 'Update', cancelLabel: 'Not now' },
    );
    if (!install) return `${update.version} available — skipped`;

    useSequencerStore.getState().pushToast({
      kind: 'success',
      text: `downloading ${update.version}…`,
    });
    await update.downloadAndInstall();
    await relaunch();
    return 'installing…';
  } catch (err) {
    console.warn('[updater] check/install failed:', err);
    // Surface the failure on the manual path — this is the diagnostic for
    // "launch check silently did nothing" reports.
    return manual ? `check failed: ${String(err).slice(0, 120)}` : 'check failed';
  }
}
