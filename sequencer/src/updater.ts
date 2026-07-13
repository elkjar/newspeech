// Launch-time auto-update check (tauri-plugin-updater).
//
// Installed testers have no other channel back to us — this check is what lets
// a shipped build ever be superseded, so it rides in every release from the
// first tester build onward. Manifest lives at the GitHub Releases `latest.json`
// (endpoint in tauri.conf.json); artifacts are signed with the keypair at
// ~/.tauri/sequence-updater.key (see scripts/release.sh).
//
// Flow: check → ask → downloadAndInstall → relaunch. Declining is final for the
// session (next launch asks again). All failures are silent-to-console — an
// offline boot must never surface an updater error.
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

async function runUpdateCheck(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;

    const install = await ask(
      `Sequence ${update.version} is available (you have ${update.currentVersion}).\n\nDownload and install now? The app restarts when it's done.`,
      { title: 'Update available', kind: 'info', okLabel: 'Update', cancelLabel: 'Not now' },
    );
    if (!install) return;

    useSequencerStore.getState().pushToast({
      kind: 'success',
      text: `downloading ${update.version}…`,
    });
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    console.warn('[updater] check/install failed:', err);
  }
}
