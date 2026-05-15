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

VST3_INSTALL_NAME="GlitchFX.vst3"
VST3_INSTALL_DIR="$HOME/Library/Audio/Plug-Ins/VST3"

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

# --- 2b. Patch FaustPluginProcessor.cpp to drive Glitch/bpm from the
#         host transport. Injects a host-BPM read above the fDSP->compute
#         call inside the templated process<FloatType>() method. When no
#         playhead / position / BPM is available, the write is skipped and
#         the zone's last value (JUCE param or default) keeps driving.
echo "▸ Patching FaustPluginProcessor.cpp with host-tempo override…"
sed -i.bak \
  -e '/    \/\/ MIDI timestamp is expressed in frames/i\
    // Host-tempo override: drive Glitch/bpm from session BPM each block.\
    if (auto* playHead = getPlayHead()) {\
        if (auto pos = playHead->getPosition()) {\
            if (auto hostBpm = pos->getBpm()) {\
                fStateUI.setParamValue("Glitch/bpm", FAUSTFLOAT(*hostBpm));\
            }\
        }\
    }
' \
  "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -f "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp.bak"
grep -q "Host-tempo override" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: host-tempo patch did not apply"; exit 1; }

# --- 2c. Patch JuceParameterUI to respect [hidden:1] metadata on zones.
#         Faust's stock JuceParameterUI registers every slider/button as an
#         AU AudioParameter unconditionally. Its sibling JuceGUI inherits
#         both `GUI` and `MetaDataUI`, so it has `isHidden()` and can
#         filter; JuceParameterUI inherits only `GUI`, so the `declare()`
#         calls from Faust drop on the floor and every zone becomes an AU
#         param.
#         Two-part patch:
#           (i)  mix `MetaDataUI` into JuceParameterUI's inheritance list,
#                routing metadata declares to MetaDataUI::declare() which
#                populates fHiddenSet.
#           (ii) prepend `if (isHidden(zone)) return;` to each of the 7
#                `fProcessor->addParameter(new ...)` lines.
echo "▸ Patching JuceParameterUI to filter hidden zones from AU params…"
sed -i.bak \
  -e 's|class JuceParameterUI : public GUI, public PathBuilder|class JuceParameterUI : public GUI, public MetaDataUI, public PathBuilder|' \
  -e 's|fProcessor->addParameter(new |if (isHidden(zone)) return; fProcessor->addParameter(new |g' \
  "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp"
rm -f "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp.bak"
grep -q "class JuceParameterUI : public GUI, public MetaDataUI, public PathBuilder" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp" || { echo "ERROR: JuceParameterUI inheritance patch did not apply"; exit 1; }
HIDDEN_GUARD_COUNT="$(grep -c "if (isHidden(zone)) return; fProcessor->addParameter" "$JUCE_PROJECT_DIR/FaustPluginProcessor.cpp")"
[ "$HIDDEN_GUARD_COUNT" -ge 7 ] || { echo "ERROR: JuceParameterUI hidden-guard patch found $HIDDEN_GUARD_COUNT sites, expected ≥7"; exit 1; }

# --- 2d. Patch FaustPlugInAudioParameter{Float,Bool} to override
#         getValue() to read directly from the Faust DSP zone.
#         faust2juce emits setValue overrides that write into the Faust
#         zone but don't update the AudioParameter's internal stored
#         value. Calling the base class's setValue from the override
#         doesn't work in this JUCE version (private member). Without
#         this patch, getValue() returns the stale default forever,
#         which causes: (a) Logic's AU automation panel shows defaults
#         regardless of UI state, (b) the custom UI knobs reset visually
#         on every editor reopen (SliderParameterAttachment reads
#         getValue() to position the slider), and (c) Logic project save/
#         restore captures defaults rather than dialed-in values.
#         Fix: override getValue() in each subclass to derive from the
#         zone — making the zone the single source of truth that both
#         the host and the editor read through.
#         Patch shape: append after the modifyZone line in each setValue
#         override the lines that (i) close setValue with `    }`, (ii)
#         declare and open the new getValue method, and (iii) return the
#         zone-derived value. The original closing `    }` of setValue
#         then becomes the closing brace of getValue — brace balance
#         preserved.
echo "▸ Patching FaustPlugInAudioParameter{Float,Bool}::getValue to read zone…"
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

# --- 3. Regenerate xcodeproj from .jucer.
echo "▸ Projucer --resave…"
"$PROJUCER" --resave "$JUCE_PROJECT_DIR/combined.jucer" --fix-missing-dependencies >/dev/null

XCODEPROJ="$JUCE_PROJECT_DIR/Builds/MacOSX/GlitchFX.xcodeproj"
[ -d "$XCODEPROJ" ] || { echo "ERROR: Projucer didn't produce $XCODEPROJ"; exit 1; }

# --- 4. Build both AU and VST3 targets.
#       AU covers Logic + GarageBand. VST3 covers everything else macOS
#       (Ableton Live, Reaper, Bitwig, FL Studio, Studio One, Cubase,
#       Nuendo). Pro Tools needs AAX, which we don't ship — Pro Tools
#       users wrap via Blue Cat PatchWork.
echo "▸ Building universal (arm64 + x86_64) AU…"
xcodebuild \
  -project "$XCODEPROJ" \
  -target "GlitchFX - AU" \
  -configuration Release \
  ARCHS='arm64 x86_64' \
  ONLY_ACTIVE_ARCH=NO \
  2>&1 | tail -3
BUILT="$JUCE_PROJECT_DIR/Builds/MacOSX/build/Release/GlitchFX.component"
[ -d "$BUILT" ] || { echo "ERROR: AU build produced no .component"; exit 1; }

echo "▸ Building universal (arm64 + x86_64) VST3…"
xcodebuild \
  -project "$XCODEPROJ" \
  -target "GlitchFX - VST3" \
  -configuration Release \
  ARCHS='arm64 x86_64' \
  ONLY_ACTIVE_ARCH=NO \
  2>&1 | tail -3
BUILT_VST3="$JUCE_PROJECT_DIR/Builds/MacOSX/build/Release/GlitchFX.vst3"
[ -d "$BUILT_VST3" ] || { echo "ERROR: VST3 build produced no .vst3"; exit 1; }

# --- 5. Install both bundles.
echo "▸ Installing AU to $INSTALL_DIR/$INSTALL_NAME…"
rm -rf "$INSTALL_DIR/$INSTALL_NAME"
cp -R "$BUILT" "$INSTALL_DIR/$INSTALL_NAME"

echo "▸ Installing VST3 to $VST3_INSTALL_DIR/$VST3_INSTALL_NAME…"
mkdir -p "$VST3_INSTALL_DIR"
rm -rf "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"
cp -R "$BUILT_VST3" "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"

# --- 6. Re-codesign both.
#       Default: ad-hoc (fast, fine for local dev — Logic and Ableton/
#       Reaper load ad-hoc-signed bundles).
#       SIGN=1:  run dist/sign-and-notarize.sh for Developer-ID-signed +
#                notarized + stapled distribution. Requires credentials
#                in vst/glitch/dist/.signing-config (see .example for
#                fields). Each format goes through its own notarytool
#                round-trip — slower than one combined submission, but
#                simpler and easier to debug per-format failures. If the
#                wall-clock cost ever bites, batch them into a single zip.
if [ "${SIGN:-0}" = "1" ]; then
  echo "▸ Sign + notarize AU (SIGN=1)…"
  bash "$SCRIPT_DIR/dist/sign-and-notarize.sh" "$INSTALL_DIR/$INSTALL_NAME"
  echo "▸ Sign + notarize VST3 (SIGN=1)…"
  bash "$SCRIPT_DIR/dist/sign-and-notarize.sh" "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME"
else
  echo "▸ Re-codesigning AU ad-hoc (set SIGN=1 to Developer-ID-sign + notarize)…"
  codesign --force --deep --sign - "$INSTALL_DIR/$INSTALL_NAME" 2>&1
  echo "▸ Re-codesigning VST3 ad-hoc…"
  codesign --force --deep --sign - "$VST3_INSTALL_DIR/$VST3_INSTALL_NAME" 2>&1
fi

# --- 7. Flush AU registry.
echo "▸ Resetting AU registry…"
killall -9 AudioComponentRegistrar 2>&1 || true
sleep 2

# --- 8. Validate.
echo "▸ Validating with auval…"
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
