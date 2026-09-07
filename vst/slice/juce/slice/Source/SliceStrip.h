#pragma once

#include <JuceHeader.h>
#include "SliceEngine.h"

// The pass as a strip: one block per hit (tall = long, short = dit; DATA scales
// by level), hollow = dropped, a hairline per beat (brighter every 4), the
// playhead, and the pass length in seconds bottom-right. Mirrors slice.html's
// #strip canvas.
class SliceStrip : public juce::Component
{
public:
    // The editor owns the snapshot and refreshes these each tick.
    void setPass (const slice::UiPass* p) noexcept { pass = p; }
    void setPosition (double phase, double totalBeats, double bpm, bool hasPattern) noexcept;

    void paint (juce::Graphics&) override;

private:
    const slice::UiPass* pass = nullptr;
    double phase = -1.0, total = 1.0, bpm = 120.0;
    bool hasPattern = false;
};
