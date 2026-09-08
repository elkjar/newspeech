#!/usr/bin/env bash
# BROADCAST release: build the universal, signed, notarized BROADCAST.app (+ dmg)
# and optionally install it to /Applications. No updater (the crate has none),
# no GitHub Release, and NO git push — Chris reviews and pushes main himself.
#
#   bash scripts/release-broadcast.sh <version> [--install] [--no-notarize]
#
# Credentials come from sequencer/.release-env (same file Sequence's release
# uses): APPLE_SIGNING_IDENTITY, and for notarization APPLE_ID / APPLE_PASSWORD /
# APPLE_TEAM_ID (or APPLE_API_KEY_PATH / APPLE_API_KEY / APPLE_API_ISSUER).
# Tauri signs the .app during `tauri build` when APPLE_SIGNING_IDENTITY is set;
# this script notarizes + staples the dmg after.
set -euo pipefail
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEQ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SEQ_DIR"
if [ -f "$SEQ_DIR/.release-env" ]; then set -a; source "$SEQ_DIR/.release-env"; set +a; fi

VERSION="${1:-}"; shift || true
INSTALL=0; NOTARIZE=1
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    --no-notarize) NOTARIZE=0 ;;
    *) echo "unknown flag $a" >&2; exit 1 ;;
  esac
done
die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▶ $*"; }

TARGET="universal-apple-darwin"
CONF="src-tauri-broadcast/tauri.conf.json"
BUNDLE_DIR="src-tauri-broadcast/target/$TARGET/release/bundle"
APP="$BUNDLE_DIR/macos/BROADCAST.app"

step "preflight"
[ -n "$VERSION" ] || die "usage: bash scripts/release-broadcast.sh <version> [--install] [--no-notarize]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version '$VERSION' is not X.Y.Z"
CURRENT="$(node -p "require('./$CONF').version")"
echo "  $CURRENT → $VERSION"
echo "  typecheck…"; npx tsc --noEmit || die "tsc failed"
rustup target list --installed | grep -q '^x86_64-apple-darwin$' || die "run: rustup target add x86_64-apple-darwin"
rustup target list --installed | grep -q '^aarch64-apple-darwin$' || die "run: rustup target add aarch64-apple-darwin"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then echo "  signing as: $APPLE_SIGNING_IDENTITY"; else echo "  ⚠ APPLE_SIGNING_IDENTITY not set — UNSIGNED build"; fi

step "version → $VERSION ($CONF)"
node -e "const fs=require('fs');const f='$CONF';const c=JSON.parse(fs.readFileSync(f,'utf8'));c.version='$VERSION';fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"

step "build (tauri build, $TARGET)"
npm run broadcast:build -- --target "$TARGET"
[ -d "$APP" ] || die "bundle not found at $APP"
BUILT="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[ "$BUILT" = "$VERSION" ] || die "built app is $BUILT, expected $VERSION"
codesign -dv --verbose=1 "$APP" 2>&1 | grep -E "Authority=Developer ID|Signature=adhoc" | head -1 || true

DMG="$(ls "$BUNDLE_DIR"/dmg/BROADCAST_"$VERSION"_*.dmg 2>/dev/null | head -1 || true)"
if [ "$NOTARIZE" = 1 ] && [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && [ -n "$DMG" ]; then
  step "notarize + staple dmg"
  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait || die "notarization failed"
  elif [ -n "${APPLE_ID:-}" ]; then
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait || die "notarization failed"
  else
    echo "  (no notarization credentials — skipped)"
  fi
  xcrun stapler staple "$DMG" || true
  xcrun stapler staple "$APP" || true
fi

if [ "$INSTALL" = 1 ]; then
  step "install → /Applications/BROADCAST.app"
  pkill -x BROADCAST 2>/dev/null || true
  rm -rf /Applications/BROADCAST.app
  cp -R "$APP" /Applications/BROADCAST.app
  echo "  installed"
fi

echo
echo "✓ BROADCAST $VERSION"
echo "  app: $APP"
[ -n "$DMG" ] && echo "  dmg: $DMG"
echo "  (nothing pushed — review and push main yourself)"
