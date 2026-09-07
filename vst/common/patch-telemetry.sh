#!/usr/bin/env bash
#
# Patch a faust2juce-generated FaustPluginProcessor.cpp so the processor
# publishes live telemetry (host bpm, transport state, per-block output peak)
# for the editor's datafield. Three edits, each self-verified:
#   1. include NewspeechTelemetry.h (resolved via the common/ui -I flag)
#   2. the processor (both the PLUGIN_MAGIC and plain class variants) implements
#      newspeech::TelemetrySource and owns a Telemetry
#   3. after fDSP->compute(...), record bpm/playing and the block's peak
#
# Usage: patch-telemetry.sh <path/to/FaustPluginProcessor.cpp>
set -euo pipefail
CPP="$1"
[ -f "$CPP" ] || { echo "ERROR: $CPP not found"; exit 1; }

sed -i.bak \
  -e '/^#include "JuceLibraryCode\/JuceHeader.h"$/a\
#include "NewspeechTelemetry.h"
' \
  -e 's|^class FaustPlugInAudioProcessor : public foleys::MagicProcessor, private juce::Timer$|class FaustPlugInAudioProcessor : public foleys::MagicProcessor, private juce::Timer, public newspeech::TelemetrySource|' \
  -e 's|^class FaustPlugInAudioProcessor : public juce::AudioProcessor, private juce::Timer$|class FaustPlugInAudioProcessor : public juce::AudioProcessor, private juce::Timer, public newspeech::TelemetrySource|' \
  -e '/^        FaustPlugInAudioProcessor();$/a\
        newspeech::Telemetry nsTelemetry;\
        newspeech::Telemetry\& telemetry() noexcept override { return nsTelemetry; }
' \
  -e '/^                  (FAUSTFLOAT\*\*)buffer.getArrayOfWritePointers());$/a\
    {   // newspeech telemetry → editor datafield (see vst/common/patch-telemetry.sh)\
        if (auto* ph = getPlayHead()) {\
            if (auto pos = ph->getPosition()) {\
                nsTelemetry.hasTransport.store (true, std::memory_order_relaxed);\
                nsTelemetry.playing.store (pos->getIsPlaying(), std::memory_order_relaxed);\
                if (auto b = pos->getBpm()) nsTelemetry.bpm.store (*b, std::memory_order_relaxed);\
            }\
        }\
        float nsPeak = 0.0f;\
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)\
            nsPeak = juce::jmax (nsPeak, (float) buffer.getMagnitude (ch, 0, buffer.getNumSamples()));\
        nsTelemetry.pushPeak (nsPeak);\
    }
' \
  "$CPP"
rm -f "$CPP.bak"

grep -q '#include "NewspeechTelemetry.h"' "$CPP"                  || { echo "ERROR: telemetry include patch did not apply"; exit 1; }
[ "$(grep -c 'public newspeech::TelemetrySource' "$CPP")" -eq 2 ] || { echo "ERROR: TelemetrySource inheritance patch expected 2 class sites"; exit 1; }
grep -q 'newspeech::Telemetry nsTelemetry;' "$CPP"                || { echo "ERROR: telemetry member patch did not apply"; exit 1; }
grep -q 'nsTelemetry.pushPeak (nsPeak);' "$CPP"                   || { echo "ERROR: telemetry block patch did not apply"; exit 1; }
