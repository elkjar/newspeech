#!/usr/bin/env bash
#
# Cut a distributable release of one suite plugin.
#
#   vst/release.sh <vibe|saturate|slice> [--publish]        (SKIP_BUILD=1 to re-zip installed bundles)
#
# 1. SIGN=1 build.sh — universal AU + VST3, Developer-ID signed, notarized,
#    stapled, installed to ~/Library/Audio/Plug-Ins.
# 2. Zip both installed bundles into vst/<plugin>/dist/<Name>-<version>.zip
#    (ditto, so signatures + stapled tickets survive).
# 3. --publish: create the GitHub pre-release <plugin>-v<version> with the zip
#    attached, then point the site's direct-download redirect
#    (/dl/<plugin> in netlify.toml) at that asset. Commit + push separately.
#
# Name + version come from the plugin's .jucer. Bump the jucer version first.
set -euo pipefail

PLUGIN="${1:-}"; PUBLISH=0
[ -n "$PLUGIN" ] || { echo "Usage: $0 <vibe|saturate|slice> [--publish]"; exit 2; }
[ "${2:-}" = "--publish" ] && PUBLISH=1

VST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$VST_DIR/.." && pwd)"
PLUGIN_DIR="$VST_DIR/$PLUGIN"
[ -d "$PLUGIN_DIR" ] || { echo "ERROR: no plugin at $PLUGIN_DIR"; exit 2; }

JUCER="$(ls "$PLUGIN_DIR"/juce/*/*.jucer | head -1)"
NAME="$(sed -nE 's/.*<JUCERPROJECT[^>]* name="([^"]+)".*/\1/p' "$JUCER" | head -1)"
VERSION="$(sed -nE 's/.*<JUCERPROJECT[^>]* version="([^"]+)".*/\1/p' "$JUCER" | head -1)"
[ -n "$NAME" ] && [ -n "$VERSION" ] || { echo "ERROR: could not read name/version from $JUCER"; exit 1; }

AU="$HOME/Library/Audio/Plug-Ins/Components/$NAME.component"
VST3="$HOME/Library/Audio/Plug-Ins/VST3/$NAME.vst3"
ZIP="$PLUGIN_DIR/dist/$NAME-$VERSION.zip"
TAG="$PLUGIN-v$VERSION"
ASSET_URL="https://github.com/elkjar/newspeech/releases/download/$TAG/$NAME-$VERSION.zip"

echo "▸ $PLUGIN → $NAME v$VERSION (tag $TAG)"

# --- 1. signed, notarized build ------------------------------------------------
#        SKIP_BUILD=1 reuses the bundles already installed (they must still pass
#        the signature + staple checks below) — for re-zipping without another
#        notary round trip.
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "▸ SKIP_BUILD=1 — reusing installed bundles"
else
  ( cd "$PLUGIN_DIR" && SIGN=1 bash build.sh )
fi
[ -d "$AU" ] && [ -d "$VST3" ] || { echo "ERROR: installed bundles missing after build"; exit 1; }
for b in "$AU" "$VST3"; do
  # capture first — under pipefail, `grep -q` closing the pipe early makes codesign fail the pipeline
  SIG="$(codesign -dvv "$b" 2>&1)"
  echo "$SIG" | grep -q "Authority=Developer ID Application" || { echo "ERROR: $b is not Developer-ID signed"; exit 1; }
  xcrun stapler validate "$b" >/dev/null 2>&1 || { echo "ERROR: $b has no stapled notarization ticket"; exit 1; }
done

# --- 2. zip both bundles -----------------------------------------------------
STAGE="$(mktemp -d -t "$PLUGIN-release")"
cp -R "$AU" "$VST3" "$STAGE/"
rm -f "$ZIP"
( cd "$STAGE" && ditto -c -k --keepParent --sequesterRsrc "$NAME.component" "$ZIP.au" && ditto -c -k --sequesterRsrc . "$ZIP" )
rm -f "$ZIP.au"; rm -rf "$STAGE"
echo "▸ Zipped → $ZIP ($(du -h "$ZIP" | cut -f1))"

[ "$PUBLISH" = "1" ] || { echo "Dry run complete. Re-run with --publish to create the GitHub pre-release and update /dl/$PLUGIN."; exit 0; }

# --- 3. publish ------------------------------------------------------------------
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "ERROR: release $TAG already exists — bump the jucer version"; exit 1
fi
NOTES="$(mktemp -t "$PLUGIN-notes")"
cat > "$NOTES" <<NOTES
$NAME v$VERSION — macOS AU + VST3, universal (Apple Silicon + Intel), signed + notarized.

Install: unzip, copy \`$NAME.component\` to \`~/Library/Audio/Plug-Ins/Components\` and \`$NAME.vst3\` to \`~/Library/Audio/Plug-Ins/VST3\`, restart your DAW.

Free for everything you make with it. If it ends up on something cool, share it — @newspeechsound.
Source: https://github.com/elkjar/newspeech/tree/main/vst/$PLUGIN (GPLv3).
NOTES
gh release create "$TAG" --prerelease --title "$PLUGIN v$VERSION" --notes-file "$NOTES" "$ZIP"
rm -f "$NOTES"
echo "▸ Published $ASSET_URL"

# Direct-download redirect: www.newspeechsound.com/dl/<plugin> → the asset.
python3 - "$REPO_DIR/netlify.toml" "$PLUGIN" "$ASSET_URL" <<'PY'
import sys, re, pathlib
toml, plugin, url = sys.argv[1:]
p = pathlib.Path(toml); s = p.read_text()
block = f'''# dl:{plugin} begin — managed by vst/release.sh
[[redirects]]
  from = "/dl/{plugin}"
  to = "{url}"
  status = 302
# dl:{plugin} end
'''
pat = re.compile(rf'# dl:{plugin} begin.*?# dl:{plugin} end\n', re.S)
s = pat.sub(block, s) if pat.search(s) else s.rstrip('\n') + '\n\n' + block
p.write_text(s)
print(f"▸ netlify.toml: /dl/{plugin} → {url}")
PY
echo "Now commit netlify.toml (+ the page) and push to deploy the redirect."
