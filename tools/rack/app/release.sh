#!/usr/bin/env bash
#
# Cut an edit.app release: bump → build (signed + notarized) → GitHub prerelease.
#
#   bash tools/rack/app/release.sh <version> "<summary>"
#
# Mirrors sequencer/scripts/release.sh, with two differences that matter:
#   - releases are PRERELEASES. Sequence owns releases/latest (its updater reads
#     releases/latest/download/latest.json) — a normal release here would hijack it.
#   - the updater reads a rolling "edit-latest" prerelease instead
#     (releases/download/edit-latest/latest.json); each release re-uploads it.
# Signing secrets and the updater key are Sequence's (sequencer/.release-env,
# ~/.tauri/sequence-updater.key) — one Developer ID, one update keypair.
# Commits the version bump to main (tooling — no PR needed).
set -euo pipefail

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$APP_DIR/../../.." && pwd)"
ENV_FILE="$REPO/sequencer/.release-env"
if [ -f "$ENV_FILE" ]; then set -a; source "$ENV_FILE"; set +a; fi

KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/sequence-updater.key}"
[ -f "$KEY" ] || { echo "✗ updater key missing at $KEY" >&2; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

VERSION="${1:-}"; SUMMARY="${2:-}"
die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▶ $*"; }

step "preflight"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release.sh <X.Y.Z> \"<summary>\""
[ -n "$SUMMARY" ] || die "missing release summary"
[ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = "main" ] || die "releases go from main"
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || die "APPLE_SIGNING_IDENTITY not set ($ENV_FILE) — an unsigned app would hit Gatekeeper"
rustup target list --installed | grep -q '^x86_64-apple-darwin$' || die "run: rustup target add x86_64-apple-darwin"
cd "$APP_DIR"
CURRENT="$(node -p "require('./package.json').version")"
echo "  $CURRENT → $VERSION"

step "bump package.json → $VERSION"
node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"

step "build (universal, signed + notarized)"
npm install --silent
./node_modules/.bin/tauri build --target universal-apple-darwin
BUNDLE_DIR="$APP_DIR/src-tauri/target/universal-apple-darwin/release/bundle"
APP="$BUNDLE_DIR/macos/edit.app"
DMG="$BUNDLE_DIR/dmg/edit_${VERSION}_universal.dmg"
TGZ="$BUNDLE_DIR/macos/edit.app.tar.gz"
SIG="$TGZ.sig"
for f in "$APP" "$DMG" "$TGZ" "$SIG"; do [ -e "$f" ] || die "missing $f"; done
[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VERSION" ] || die "built app has the wrong version"

step "notarize dmg"
if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait || die "dmg notarization failed"
else
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait || die "dmg notarization failed"
fi
xcrun stapler staple "$DMG"

step "updater manifest"
LATEST="$BUNDLE_DIR/latest.json"
node -e "
  require('fs').writeFileSync('$LATEST', JSON.stringify({
    version: '$VERSION', notes: process.argv[1], pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(['darwin-aarch64', 'darwin-x86_64'].map(k => [k, {
      signature: process.argv[2],
      url: 'https://github.com/elkjar/newspeech/releases/download/edit-v$VERSION/edit.app.tar.gz',
    }])),
  }, null, 2) + '\n');
" "$SUMMARY" "$(cat "$SIG")"
cp -f "$DMG" "$BUNDLE_DIR/dmg/edit.dmg"

step "commit + push the bump"
git -C "$REPO" add tools/rack/app/package.json tools/rack/app/src-tauri/Cargo.lock
# (nothing to commit when re-cutting the version package.json already says)
git -C "$REPO" diff --cached --quiet || git -C "$REPO" commit -q -m "edit.app: $VERSION — $SUMMARY"
git -C "$REPO" push -q origin main

step "GitHub prereleases"
cd "$REPO"
gh release create "edit-v$VERSION" --prerelease --title "edit $VERSION" --notes "$SUMMARY" \
  "$DMG" "$BUNDLE_DIR/dmg/edit.dmg" "$TGZ" "$SIG" "$LATEST"
# the rolling channel the installed apps poll
if gh release view edit-latest >/dev/null 2>&1; then
  gh release upload edit-latest "$LATEST" "$BUNDLE_DIR/dmg/edit.dmg" --clobber
else
  gh release create edit-latest --prerelease --title "edit (latest)" \
    --notes "Rolling channel for edit.app's updater. Install: download edit.dmg below." "$LATEST" "$BUNDLE_DIR/dmg/edit.dmg"
fi

echo
echo "✓ edit $VERSION released — https://github.com/elkjar/newspeech/releases/download/edit-latest/edit.dmg"
echo "  installed copies will offer the update on next launch."
