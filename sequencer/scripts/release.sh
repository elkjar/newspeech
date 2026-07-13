#!/usr/bin/env bash
#
# Cut a Sequence release: bump → build → install → commit → push.
#
#   bash scripts/release.sh <version> "<summary>"
#   e.g.  bash scripts/release.sh 0.8.7 "arp mode + per-track swing"
#
# What it does (and why each step matters):
#   1. Preflight — must be on `main`, version looks like X.Y.Z, summary given,
#      and `tsc` passes (fail fast before the slow Rust compile).
#   2. Bump ONLY sequencer/package.json. That is the single source of truth —
#      tauri.conf.json reads "../package.json", Cargo.toml stays 0.0.0, and the
#      Info.plist version keys are injected by Tauri. Never hand-edit those.
#   3. Build the app: `npm run tauri:build` (release profile).
#   4. Install: replace /Applications/Sequence.app with the fresh bundle. Every
#      release ships the app too, not just the web deploy.
#   5. Commit "sequencer: <version> — <summary>" and push main → Netlify
#      auto-deploys www.newspeechsound.com.
#   6. Distribution (when signing secrets are present): the build is already
#      Developer-ID-signed + notarized by Tauri (env vars below); we staple
#      the dmg, generate the updater manifest (latest.json), and publish a
#      GitHub Release with dmg + updater artifact — installed apps poll
#      /releases/latest/download/latest.json (tauri-plugin-updater).
#
# Secrets live in sequencer/.release-env (gitignored), sourced if present:
#   APPLE_SIGNING_IDENTITY  "Developer ID Application: Name (TEAMID)"
#   APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   (notarytool; app-specific pw)
# The updater keypair is ~/.tauri/sequence-updater.key (no password). Losing
# it orphans every installed app — back it up.
#
# NOTE: the dmg bundler runs a Finder AppleScript styling pass — run this
# script from a GUI terminal session, not headless/SSH.
#
set -euo pipefail

# cargo isn't on the default PATH in non-login shells.
# shellcheck disable=SC1090
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

# Distribution secrets (signing identity + notarization credentials).
# set -a exports everything the file defines so the Tauri build subprocess
# (which does the actual codesign + notarize) sees them.
# shellcheck disable=SC1091
if [ -f "$(dirname "${BASH_SOURCE[0]}")/../.release-env" ]; then
  set -a
  source "$(dirname "${BASH_SOURCE[0]}")/../.release-env"
  set +a
fi

# Updater artifacts (createUpdaterArtifacts in tauri.conf.json) are signed
# with the Tauri updater key — required for every build now. The CLI only
# reads the key CONTENT from TAURI_SIGNING_PRIVATE_KEY (the _PATH variant is
# ignored, verified 2026-07-13), so cat the file into it.
UPDATER_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/sequence-updater.key}"
[ -f "$UPDATER_KEY_PATH" ] || { echo "✗ updater key missing at $UPDATER_KEY_PATH" >&2; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

VERSION="${1:-}"
SUMMARY="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEQ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SEQ_DIR"

BUNDLE="src-tauri/target/release/bundle/macos/Sequence.app"
INSTALLED="/Applications/Sequence.app"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▶ $*"; }

# --- 1. preflight ----------------------------------------------------------
step "preflight"
[ -n "$VERSION" ] || die "usage: bash scripts/release.sh <version> \"<summary>\""
[ -n "$SUMMARY" ] || die "missing release summary (arg 2)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version '$VERSION' is not X.Y.Z"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH' — releases go from main"

CURRENT="$(node -p "require('./package.json').version")"
echo "  $CURRENT → $VERSION"
[ "$CURRENT" != "$VERSION" ] || die "package.json is already $VERSION"

echo "  typecheck…"
npx tsc --noEmit || die "tsc failed — fix types before releasing"

# --- 2. bump (single source of truth) --------------------------------------
step "bump package.json → $VERSION"
node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"

# --- 3. build --------------------------------------------------------------
step "build (npm run tauri:build)"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "  signing as: $APPLE_SIGNING_IDENTITY"
  [ -n "${APPLE_ID:-}" ] && echo "  notarizing as: $APPLE_ID (team ${APPLE_TEAM_ID:-?})"
else
  echo "  ⚠ APPLE_SIGNING_IDENTITY not set — UNSIGNED build (testers hit Gatekeeper)"
fi
npm run tauri:build

[ -d "$BUNDLE" ] || die "expected bundle not found at $BUNDLE"
BUILT_VER="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$BUNDLE/Contents/Info.plist")"
[ "$BUILT_VER" = "$VERSION" ] || die "built app is $BUILT_VER, expected $VERSION"

# --- 4. install to /Applications -------------------------------------------
step "install → $INSTALLED"
rm -rf "$INSTALLED"
cp -R "$BUNDLE" "$INSTALLED"
echo "  installed $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$INSTALLED/Contents/Info.plist")"

# --- 5. commit + push ------------------------------------------------------
step "commit + push main"
cd "$(git rev-parse --show-toplevel)"
git add -A
git commit -q -m "sequencer: $VERSION — $SUMMARY"
git push origin main

# --- 6. distribution: staple dmg + GitHub Release + updater manifest -------
BUNDLE_DIR="$SEQ_DIR/src-tauri/target/release/bundle"
DMG="$BUNDLE_DIR/dmg/Sequence_${VERSION}_aarch64.dmg"
UPDATER_TGZ="$BUNDLE_DIR/macos/Sequence.app.tar.gz"
UPDATER_SIG="$BUNDLE_DIR/macos/Sequence.app.tar.gz.sig"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo
  echo "✓ released $VERSION — main pushed, app installed. (No signing identity:"
  echo "  skipped GitHub Release / updater publish — installed testers were NOT updated.)"
  exit 0
fi

step "distribution"
[ -f "$DMG" ] || die "dmg not found at $DMG"
[ -f "$UPDATER_TGZ" ] || die "updater artifact not found at $UPDATER_TGZ"
[ -f "$UPDATER_SIG" ] || die "updater signature not found at $UPDATER_SIG"

# Tauri notarizes + staples the .app when APPLE_* env is present; the dmg
# needs its own notarization pass so the download mounts clean. API-key auth
# (APPLE_API_KEY_PATH/APPLE_API_KEY/APPLE_API_ISSUER) preferred — Apple-ID
# auth 403'd on a fresh membership 2026-07-13.
if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  echo "  notarizing dmg via API key (this waits on Apple)…"
  xcrun notarytool submit "$DMG" \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait || die "dmg notarization failed"
  xcrun stapler staple "$DMG"
elif [ -n "${APPLE_ID:-}" ]; then
  echo "  notarizing dmg (this waits on Apple)…"
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
    --wait || die "dmg notarization failed"
  xcrun stapler staple "$DMG"
fi

echo "  writing latest.json…"
LATEST_JSON="$BUNDLE_DIR/latest.json"
SIG_CONTENT="$(cat "$UPDATER_SIG")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e "
  require('fs').writeFileSync('$LATEST_JSON', JSON.stringify({
    version: '$VERSION',
    notes: process.argv[1],
    pub_date: '$PUB_DATE',
    platforms: {
      'darwin-aarch64': {
        signature: process.argv[2],
        url: 'https://github.com/elkjar/newspeech/releases/download/sequence-v$VERSION/Sequence.app.tar.gz',
      },
    },
  }, null, 2) + '\n');
" "$SUMMARY" "$SIG_CONTENT"

# A stable-named copy rides along so the site can link
# releases/latest/download/Sequence.dmg without a per-version URL.
STABLE_DMG="$BUNDLE_DIR/dmg/Sequence.dmg"
cp -f "$DMG" "$STABLE_DMG"

echo "  publishing GitHub Release sequence-v${VERSION}…"
gh release create "sequence-v$VERSION" \
  --title "Sequence $VERSION" \
  --notes "$SUMMARY" \
  "$DMG" "$STABLE_DMG" "$UPDATER_TGZ" "$UPDATER_SIG" "$LATEST_JSON"

echo
echo "✓ released $VERSION — main pushed (Netlify deploying), app installed,"
echo "  GitHub Release published (dmg + updater manifest live)."
