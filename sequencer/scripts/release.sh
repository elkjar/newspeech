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
#
set -euo pipefail

# cargo isn't on the default PATH in non-login shells.
# shellcheck disable=SC1090
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

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

echo
echo "✓ released $VERSION — main pushed (Netlify deploying), app installed."
