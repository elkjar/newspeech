#!/usr/bin/env bash
#
# Build & install vst/glitch as the "Glitch FX" AU plugin via the
# Faust → JUCE pipeline.
#
# Flow:
#   1. faust2juce regenerates FaustPluginProcessor.cpp from combined.dsp.
#      The .jucer it ALSO generates is discarded — we keep our own
#      checked-in combined.jucer (with NEWSPEECH publisher + Source/
#      custom-UI file entries baked in).
#   2. Patch FaustPluginProcessor.cpp to use our GlitchEditor instead
#      of the default FaustPlugInAudioProcessorEditor (one #include +
#      one return-statement swap).
#   3. Projucer --resave regenerates Builds/MacOSX/GlitchFX.xcodeproj +
#      JuceLibraryCode/. We pass --fix-missing-dependencies because
#      faust2juce produces a .jucer with implicit module deps that Projucer
#      otherwise refuses to save.
#   4. xcodebuild the "GlitchFX - AU" target (universal arm64 + x86_64).
#   5. Replace ~/Library/Audio/Plug-Ins/Components/GlitchFX.component.
#   6. Ad-hoc codesign so Logic doesn't reject it.
#   7. killall AudioComponentRegistrar to flush the AU registry cache.
#   8. auval to verify.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSP_DIR="$SCRIPT_DIR/dsp"
DSP_FILE="$DSP_DIR/combined.dsp"
JUCE_PROJECT_DIR="$SCRIPT_DIR/juce/combined"

JUCE_ROOT="$HOME/JUCE"
JUCE_MODULES="$JUCE_ROOT/modules"
PROJUCER="$JUCE_ROOT/extras/Projucer/Builds/MacOSX/build/Release/Projucer.app/Contents/MacOS/Projucer"

PLUGIN_NAME="GLITCH"
PLUGIN_MFR="newspeech"
PLUGIN_MFR_CODE="Nwsp"          # AU FourCharCode — must contain ≥1 uppercase.
PLUGIN_CODE="Gfx1"              # AU FourCharCode subtype.
PLUGIN_BUNDLE_ID="com.newspeech.audiounit.GlitchFX"

INSTALL_NAME="GlitchFX.component"
INSTALL_DIR="$HOME/Library/Audio/Plug-Ins/Components"

# Preflight: tools and dirs.
command -v faust2juce >/dev/null   || { echo "ERROR: faust2juce not in PATH (brew install faust)"; exit 1; }
[ -d "$JUCE_MODULES" ]             || { echo "ERROR: JUCE not at $JUCE_ROOT — git clone https://github.com/juce-framework/JUCE.git $JUCE_ROOT"; exit 1; }
[ -x "$PROJUCER" ]                 || { echo "ERROR: Projucer not built at $PROJUCER — xcodebuild in $JUCE_ROOT/extras/Projucer/Builds/MacOSX"; exit 1; }

# --- 1. Regenerate FaustPluginProcessor.cpp. Discard the .jucer that
#       faust2juce also emits — we keep our own checked-in combined.jucer
#       (it carries the NEWSPEECH publisher + Source/ custom-UI <FILE>
#       entries, neither of which we want clobbered every build).
echo "▸ Running faust2juce…"
DSP_TMP_OUTDIR="$DSP_DIR/combined"
rm -rf "$DSP_TMP_OUTDIR"
( cd "$DSP_DIR" && faust2juce -jucemodulesdir "$JUCE_MODULES" "$(basename "$DSP_FILE")" >/dev/null )
[ -f "$DSP_TMP_OUTDIR/FaustPluginProcessor.cpp" ] || { echo "ERROR: faust2juce produced no .cpp"; exit 1; }
[ -f "$JUCE_PROJECT_DIR/combined.jucer" ] || { echo "ERROR: $JUCE_PROJECT_DIR/combined.jucer missing — should be checked in"; exit 1; }

mkdir -p "$JUCE_PROJECT_DIR"
mv -f "$DSP_TMP_OUTDIR/FaustPluginProcessor.cpp" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -rf "$DSP_TMP_OUTDIR"

# --- 2. Patch FaustPluginProcessor.cpp to use our custom GlitchEditor.
#       Two edits: inject the #include before createEditor(), and swap
#       the return-statement to construct GlitchEditor instead of the
#       default Faust-generated editor.
echo "▸ Patching FaustPluginProcessor.cpp with custom editor hook…"
sed -i.bak \
  -e '/^juce::AudioProcessorEditor\* FaustPlugInAudioProcessor::createEditor/i\
#include "Source/GlitchEditor.h"
' \
  -e 's|return new FaustPlugInAudioProcessorEditor (\*this);|return new GlitchEditor (*this);|' \
  "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -f "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp.bak"
grep -q "new GlitchEditor" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: editor patch did not apply"; exit 1; }

# --- 3. Regenerate xcodeproj from .jucer.
echo "▸ Projucer --resave…"
"$PROJUCER" --resave "$JUCE_PROJECT_DIR/combined.jucer" --fix-missing-dependencies >/dev/null

XCODEPROJ="$JUCE_PROJECT_DIR/Builds/MacOSX/GlitchFX.xcodeproj"
[ -d "$XCODEPROJ" ] || { echo "ERROR: Projucer didn't produce $XCODEPROJ"; exit 1; }

# --- 4. Build the AU target.
echo "▸ Building universal (arm64 + x86_64) AU…"
xcodebuild \
  -project "$XCODEPROJ" \
  -target "GlitchFX - AU" \
  -configuration Release \
  ARCHS='arm64 x86_64' \
  ONLY_ACTIVE_ARCH=NO \
  2>&1 | tail -3

BUILT="$JUCE_PROJECT_DIR/Builds/MacOSX/build/Release/GlitchFX.component"
[ -d "$BUILT" ] || { echo "ERROR: build produced no .component"; exit 1; }

# --- 5. Install.
echo "▸ Installing to $INSTALL_DIR/$INSTALL_NAME…"
rm -rf "$INSTALL_DIR/$INSTALL_NAME"
cp -R "$BUILT" "$INSTALL_DIR/$INSTALL_NAME"

# --- 6. Re-codesign ad-hoc.
echo "▸ Re-codesigning…"
codesign --force --deep --sign - "$INSTALL_DIR/$INSTALL_NAME" 2>&1

# --- 7. Flush AU registry.
echo "▸ Resetting AU registry…"
killall -9 AudioComponentRegistrar 2>&1 || true
sleep 2

# --- 8. Validate.
echo "▸ Validating with auval…"
if auval -v aufx "$PLUGIN_CODE" "$PLUGIN_MFR_CODE" 2>&1 | tail -3 | grep -q "AU VALIDATION SUCCEEDED"; then
  echo
  echo "✓ Build complete. Plugin installed: $INSTALL_DIR/$INSTALL_NAME"
  echo "  Restart your DAW (or rescan AUs) and look for \"$PLUGIN_NAME\" by \"$PLUGIN_MFR_CODE\"."
else
  echo "⚠ auval did not report SUCCESS. Run manually for details:"
  echo "  auval -v aufx $PLUGIN_CODE $PLUGIN_MFR_CODE"
  exit 1
fi
