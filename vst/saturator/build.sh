#!/usr/bin/env bash
#
# Build & install vst/saturator as the "Saturator" AU + VST3 plugin.
# Adapted from vst/glitch/build.sh — same Faust → JUCE pipeline, but with
# the default Faust-generated editor (no custom Source/ yet) and the
# host-tempo patch rebound to "LOOP/bpm".
#
# Flow:
#   1. faust2juce regenerates FaustPluginProcessor.cpp from saturator.dsp.
#      The .jucer it ALSO emits is discarded — we keep our own checked-in
#      saturator.jucer.
#   2. Patch FaustPluginProcessor.cpp to use our custom SaturatorEditor
#      instead of the default Faust-generated editor.
#   3. Patch FaustPluginProcessor.cpp to drive LOOP/bpm from the host
#      transport via getPlayHead().
#   4. Patch JuceParameterUI to respect [hidden:1] metadata on zones
#      (so the hidden bpm slider doesn't show up as a host param).
#   5. Patch FaustPlugInAudioParameter{Float,Bool}::getValue to read
#      directly from the Faust zone (avoids stale-default getValue() that
#      makes Logic show wrong automation values + reset knobs on reopen).
#   6. Projucer --resave regenerates Builds/MacOSX/Saturator.xcodeproj.
#   7. xcodebuild AU + VST3 (universal arm64 + x86_64).
#   8. Replace ~/Library/Audio/Plug-Ins/Components/Saturator.component
#      and ~/Library/Audio/Plug-Ins/VST3/Saturator.vst3.
#   9. Ad-hoc codesign so Logic + other hosts accept the bundle.
#  10. killall AudioComponentRegistrar to flush AU registry cache.
#  11. auval to verify.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSP_DIR="$SCRIPT_DIR/dsp"
DSP_FILE="$DSP_DIR/saturator.dsp"
JUCE_PROJECT_DIR="$SCRIPT_DIR/juce/saturator"

JUCE_ROOT="$HOME/JUCE"
JUCE_MODULES="$JUCE_ROOT/modules"
PROJUCER="$JUCE_ROOT/extras/Projucer/Builds/MacOSX/build/Release/Projucer.app/Contents/MacOS/Projucer"

PLUGIN_NAME="SATURATOR"
PLUGIN_MFR="newspeech"
PLUGIN_MFR_CODE="Nwsp"
PLUGIN_CODE="Sfx1"
PLUGIN_BUNDLE_ID="com.newspeech.audiounit.Saturator"

INSTALL_NAME="Saturator.component"
INSTALL_DIR="$HOME/Library/Audio/Plug-Ins/Components"

VST3_INSTALL_NAME="Saturator.vst3"
VST3_INSTALL_DIR="$HOME/Library/Audio/Plug-Ins/VST3"

# Preflight: tools and dirs.
command -v faust2juce >/dev/null   || { echo "ERROR: faust2juce not in PATH (brew install faust)"; exit 1; }
[ -d "$JUCE_MODULES" ]             || { echo "ERROR: JUCE not at $JUCE_ROOT — git clone https://github.com/juce-framework/JUCE.git $JUCE_ROOT"; exit 1; }
[ -x "$PROJUCER" ]                 || { echo "ERROR: Projucer not built at $PROJUCER — xcodebuild in $JUCE_ROOT/extras/Projucer/Builds/MacOSX"; exit 1; }

# --- 1. Regenerate FaustPluginProcessor.cpp. Discard the .jucer that
#       faust2juce also emits — we keep our own checked-in saturator.jucer.
echo "▸ Running faust2juce..."
DSP_TMP_OUTDIR="$DSP_DIR/saturator"
rm -rf "$DSP_TMP_OUTDIR"
( cd "$DSP_DIR" && faust2juce -jucemodulesdir "$JUCE_MODULES" "$(basename "$DSP_FILE")" >/dev/null )
[ -f "$DSP_TMP_OUTDIR/FaustPluginProcessor.cpp" ] || { echo "ERROR: faust2juce produced no .cpp"; exit 1; }
[ -f "$JUCE_PROJECT_DIR/saturator.jucer" ] || { echo "ERROR: $JUCE_PROJECT_DIR/saturator.jucer missing — should be checked in"; exit 1; }

mkdir -p "$JUCE_PROJECT_DIR"
mv -f "$DSP_TMP_OUTDIR/FaustPluginProcessor.cpp" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -rf "$DSP_TMP_OUTDIR"

# --- 2. Patch FaustPluginProcessor.cpp to use our custom SaturatorEditor.
#        Two edits: inject the #include before createEditor(), and swap the
#        return-statement to construct SaturatorEditor instead of the default
#        Faust-generated editor.
echo "▸ Patching FaustPluginProcessor.cpp with custom editor hook..."
sed -i.bak \
  -e '/^juce::AudioProcessorEditor\* FaustPlugInAudioProcessor::createEditor/i\
#include "Source/SaturatorEditor.h"
' \
  -e 's|return new FaustPlugInAudioProcessorEditor (\*this);|return new SaturatorEditor (*this);|' \
  "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -f "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp.bak"
grep -q "new SaturatorEditor" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: editor patch did not apply"; exit 1; }

# --- 3. Patch host-tempo override. Injects a host-BPM read above the
#        fDSP->compute call inside the templated process<FloatType>().
echo "▸ Patching FaustPluginProcessor.cpp with host-tempo override..."
sed -i.bak \
  -e '/    \/\/ MIDI timestamp is expressed in frames/i\
    // Host-tempo override: drive LOOP/bpm from session BPM each block.\
    if (auto* playHead = getPlayHead()) {\
        if (auto pos = playHead->getPosition()) {\
            if (auto hostBpm = pos->getBpm()) {\
                fStateUI.setParamValue("LOOP/bpm", FAUSTFLOAT(*hostBpm));\
            }\
        }\
    }
' \
  "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -f "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp.bak"
grep -q "Host-tempo override" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: host-tempo patch did not apply"; exit 1; }

# --- 4. Patch JuceParameterUI to respect [hidden:1] metadata on zones.
#        Mix MetaDataUI into the inheritance list so metadata declares
#        populate fHiddenSet, then guard each addParameter call.
echo "▸ Patching JuceParameterUI to filter hidden zones from AU params..."
sed -i.bak \
  -e 's|class JuceParameterUI : public GUI, public PathBuilder|class JuceParameterUI : public GUI, public MetaDataUI, public PathBuilder|' \
  -e 's|fProcessor->addParameter(new |if (isHidden(zone)) return; fProcessor->addParameter(new |g' \
  "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -f "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp.bak"
grep -q "class JuceParameterUI : public GUI, public MetaDataUI, public PathBuilder" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: JuceParameterUI inheritance patch did not apply"; exit 1; }
HIDDEN_GUARD_COUNT="$(grep -c "if (isHidden(zone)) return; fProcessor->addParameter" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp")"
[ "$HIDDEN_GUARD_COUNT" -ge 7 ] || { echo "ERROR: JuceParameterUI hidden-guard patch found $HIDDEN_GUARD_COUNT sites, expected ≥7"; exit 1; }

# --- 5. Patch FaustPlugInAudioParameter{Float,Bool} to override
#        getValue() to read directly from the Faust DSP zone. See
#        vst/glitch/build.sh for the long rationale (Logic shows stale
#        defaults, knobs reset on reopen, etc. without this).
echo "▸ Patching FaustPlugInAudioParameter{Float,Bool}::getValue to read zone..."
sed -i.bak \
  -e '/        modifyZone(FAUSTFLOAT(range.convertFrom0to1(newValue)));/a\
    }\
    virtual float getValue() const override\
    {\
        return range.convertTo0to1(float(*fZone));
' \
  -e '/        modifyZone(FAUSTFLOAT(newValue));/a\
    }\
    virtual float getValue() const override\
    {\
        return float(*fZone);
' \
  "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -f "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp.bak"
grep -q "return range.convertTo0to1(float(\*fZone));" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: Float getValue patch did not apply"; exit 1; }
grep -q "return float(\*fZone);" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: Bool getValue patch did not apply"; exit 1; }

# --- 6. Regenerate xcodeproj from .jucer.
echo "▸ Projucer --resave..."
"$PROJUCER" --resave "$JUCE_PROJECT_DIR/saturator.jucer" --fix-missing-dependencies >/dev/null

XCODEPROJ="$JUCE_PROJECT_DIR/Builds/MacOSX/Saturator.xcodeproj"
[ -d "$XCODEPROJ" ] || { echo "ERROR: Projucer didn't produce $XCODEPROJ"; exit 1; }

# --- 7. Build AU and VST3 (universal arm64 + x86_64).
echo "▸ Building universal AU..."
xcodebuild \
  -project "$XCODEPROJ" \
  -target "Saturator - AU" \
  -configuration Release \
  ARCHS='arm64 x86_64' \
  ONLY_ACTIVE_ARCH=NO \
  2>&1 | tail -3
BUILT="$JUCE_PROJECT_DIR/Builds/MacOSX/build/Release/Saturator.component"
[ -d "$BUILT" ] || { echo "ERROR: AU build produced no .component"; exit 1; }

echo "▸ Building universal VST3..."
xcodebuild \
  -project "$XCODEPROJ" \
  -target "Saturator - VST3" \
  -configuration Release \
  ARCHS='arm64 x86_64' \
  ONLY_ACTIVE_ARCH=NO \
  2>&1 | tail -3
BUILT_VST3="$JUCE_PROJECT_DIR/Builds/MacOSX/build/Release/Saturator.vst3"
[ -d "$BUILT_VST3" ] || { echo "ERROR: VST3 build produced no .vst3"; exit 1; }

# --- 8. Install both bundles.
echo "▸ Installing AU to $INSTALL_DIR/$INSTALL_NAME..."
rm -rf "$INSTALL_DIR/$INSTALL_NAME"
cp -R "$BUILT" "$INSTALL_DIR/$INSTALL_NAME"

echo "▸ Installing VST3 to $VST3_INSTALL_DIR/$VST3_INSTALL_NAME..."
mkdir -p "$VST3_INSTALL_DIR"
rm -rf "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"
cp -R "$BUILT_VST3" "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"

# --- 9. Re-codesign.
#        Default: ad-hoc (fast, fine for local dev — Logic and Ableton/
#        Reaper load ad-hoc-signed bundles).
#        SIGN=1:  run dist/sign-and-notarize.sh for Developer-ID-signed +
#                 notarized + stapled distribution. Requires credentials
#                 in vst/saturator/dist/.signing-config (see .example for
#                 fields). Each format goes through its own notarytool
#                 round-trip — slower than one combined submission, but
#                 simpler and easier to debug per-format failures.
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

# --- 10. Flush AU registry.
echo "▸ Resetting AU registry..."
killall -9 AudioComponentRegistrar 2>&1 || true
sleep 2

# --- 11. Validate.
echo "▸ Validating with auval..."
if auval -v aufx "$PLUGIN_CODE" "$PLUGIN_MFR_CODE" 2>&1 | tail -3 | grep -q "AU VALIDATION SUCCEEDED"; then
  echo
  echo "✓ Build complete. Plug-in installed in both formats:"
  echo "    AU   $INSTALL_DIR/$INSTALL_NAME"
  echo "    VST3 $VST3_INSTALL_DIR/$VST3_INSTALL_NAME"
  echo "  Restart your DAW (or rescan plug-ins) and look for \"$PLUGIN_NAME\" by \"$PLUGIN_MFR\"."
  echo "  (No VST3 equivalent of auval ships with macOS — load the .vst3 in a host to smoke-test.)"
else
  echo "⚠ auval did not report SUCCESS. Run manually for details:"
  echo "  auval -v aufx $PLUGIN_CODE $PLUGIN_MFR_CODE"
  exit 1
fi
