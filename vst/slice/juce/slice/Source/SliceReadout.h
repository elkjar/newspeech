#pragma once

#include <JuceHeader.h>
#include "SliceEngine.h"

// The message as it plays: each character with its morse (or bits) under it,
// struck through where MANGLE has corrupted it, lit while its hit sounds. In
// DATA mode, a sparkline of the series with the threshold line — points above
// it play, corrupted points burn white. Mirrors slice.html's #readout.
class SliceReadout : public juce::Component
{
public:
    void setPass (const slice::UiPass* p) noexcept { pass = p; }
    void setLit (int ci) noexcept { if (lit != ci) { lit = ci; repaint(); } }
    void setThreshold (float t) noexcept { if (thresh != t) { thresh = t; repaint(); } }

    void paint (juce::Graphics&) override;

private:
    const slice::UiPass* pass = nullptr;
    int lit = -1;
    float thresh = 0.35f;
};
