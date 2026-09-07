#!/usr/bin/env bash
#
# Build & install vst/slice as the "SLICE" AU + VST3 plugin.
#
# Unlike vibe/saturate there is no Faust stage: slice is a plain JUCE project
# (juce/slice/Source/*), so the flow is just
#   1. Projucer --resave regenerates Builds/MacOSX/Slice.xcodeproj from slice.jucer.
#   2. xcodebuild AU + VST3 (universal arm64 + x86_64).
#   3. Replace ~/Library/Audio/Plug-Ins/Components/Slice.component
#      and ~/Library/Audio/Plug-Ins/VST3/Slice.vst3.
#   4. Ad-hoc codesign (SIGN=1: Developer-ID sign + notarize + staple via dist/).
#   5. killall AudioComponentRegistrar to flush the AU registry cache.
#   6. auval to verify.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUCE_PROJECT_DIR="$SCRIPT_DIR/juce/slice"

JUCE_ROOT="$HOME/JUCE"
JUCE_MODULES="$JUCE_ROOT/modules"
PROJUCER="$JUCE_ROOT/extras/Projucer/Builds/MacOSX/build/Release/Projucer.app/Contents/MacOS/Projucer"

PLUGIN_NAME="SLICE"
PLUGIN_MFR="newspeech"
PLUGIN_MFR_CODE="Nwsp"
PLUGIN_CODE="Slce"

INSTALL_NAME="Slice.component"
INSTALL_DIR="$HOME/Library/Audio/Plug-Ins/Components"

VST3_INSTALL_NAME="Slice.vst3"
VST3_INSTALL_DIR="$HOME/Library/Audio/Plug-Ins/VST3"

[ -d "$JUCE_MODULES" ] || { echo "ERROR: JUCE not at $JUCE_ROOT — git clone https://github.com/juce-framework/JUCE.git $JUCE_ROOT"; exit 1; }
[ -x "$PROJUCER" ]     || { echo "ERROR: Projucer not built at $PROJUCER — xcodebuild in $JUCE_ROOT/extras/Projucer/Builds/MacOSX"; exit 1; }
[ -f "$JUCE_PROJECT_DIR/slice.jucer" ] || { echo "ERROR: $JUCE_PROJECT_DIR/slice.jucer missing"; exit 1; }

# --- 1. Regenerate xcodeproj from .jucer.
echo "▸ Projucer --resave..."
"$PROJUCER" --resave "$JUCE_PROJECT_DIR/slice.jucer" --fix-missing-dependencies >/dev/null

XCODEPROJ="$JUCE_PROJECT_DIR/Builds/MacOSX/Slice.xcodeproj"
[ -d "$XCODEPROJ" ] || { echo "ERROR: Projucer didn't produce $XCODEPROJ"; exit 1; }

# --- 2. Build AU and VST3 (universal arm64 + x86_64).
build_target() {
  local target="$1"
  local log
  log="$(mktemp -t slice-xcodebuild)"
  if ! xcodebuild -project "$XCODEPROJ" -target "$target" -configuration Release \
        ARCHS='arm64 x86_64' ONLY_ACTIVE_ARCH=NO >"$log" 2>&1; then
    echo "ERROR: xcodebuild failed for '$target':"
    grep -E "error:|\*\* BUILD" "$log" | head -40
    exit 1
  fi
  tail -1 "$log"
  rm -f "$log"
}

echo "▸ Building universal AU..."
build_target "Slice - AU"
BUILT="$JUCE_PROJECT_DIR/Builds/MacOSX/build/Release/Slice.component"
[ -d "$BUILT" ] || { echo "ERROR: AU build produced no .component"; exit 1; }

echo "▸ Building universal VST3..."
build_target "Slice - VST3"
BUILT_VST3="$JUCE_PROJECT_DIR/Builds/MacOSX/build/Release/Slice.vst3"
[ -d "$BUILT_VST3" ] || { echo "ERROR: VST3 build produced no .vst3"; exit 1; }

if [ "${STANDALONE:-0}" = "1" ]; then
  echo "▸ Building Standalone (STANDALONE=1)..."
  build_target "Slice - Standalone Plugin"
fi

# --- 3. Install both bundles.
echo "▸ Installing AU to $INSTALL_DIR/$INSTALL_NAME..."
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/$INSTALL_NAME"
cp -R "$BUILT" "$INSTALL_DIR/$INSTALL_NAME"

echo "▸ Installing VST3 to $VST3_INSTALL_DIR/$VST3_INSTALL_NAME..."
mkdir -p "$VST3_INSTALL_DIR"
rm -rf "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"
cp -R "$BUILT_VST3" "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"

# --- 4. Codesign.
if [ "${SIGN:-0}" = "1" ]; then
  echo "▸ Sign + notarize AU (SIGN=1)..."
  bash "$SCRIPT_DIR/dist/sign-and-notarize.sh" "$INSTALL_DIR/$INSTALL_NAME"
  echo "▸ Sign + notarize VST3 (SIGN=1)..."
  bash "$SCRIPT_DIR/dist/sign-and-notarize.sh" "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"
else
  echo "▸ Re-codesigning AU ad-hoc (set SIGN=1 to Developer-ID-sign + notarize)..."
  codesign --force --deep --sign - "$INSTALL_DIR/$INSTALL_NAME" 2>&1
  echo "▸ Re-codesigning VST3 ad-hoc..."
  codesign --force --deep --sign - "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME" 2>&1
fi

# --- 5. Flush AU registry.
echo "▸ Resetting AU registry..."
killall -9 AudioComponentRegistrar 2>&1 || true
sleep 2

# --- 6. Validate.
echo "▸ Validating with auval..."
if auval -v aufx "$PLUGIN_CODE" "$PLUGIN_MFR_CODE" 2>&1 | tail -3 | grep -q "AU VALIDATION SUCCEEDED"; then
  echo
  echo "✓ Build complete. Plug-in installed in both formats:"
  echo "    AU   $INSTALL_DIR/$INSTALL_NAME"
  echo "    VST3 $VST3_INSTALL_DIR/$VST3_INSTALL_NAME"
  echo "  Restart your DAW (or rescan plug-ins) and look for \"$PLUGIN_NAME\" by \"$PLUGIN_MFR\"."
else
  echo "⚠ auval did not report SUCCESS. Run manually for details:"
  echo "  auval -v aufx $PLUGIN_CODE $PLUGIN_MFR_CODE"
  exit 1
fi
