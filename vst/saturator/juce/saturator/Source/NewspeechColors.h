#pragma once

#include <JuceHeader.h>

// Newspeech palette — ported from the sequencer (see sequencer/src/index.css
// and tailwind.config.ts). Everything is white-on-ink with opacity variants;
// no chromatic accent colors exist in the system.
namespace newspeech::colors {

inline const juce::Colour ink     { 0xff050505 };  // background
inline const juce::Colour fg      { 0xffffffff };  // foreground
inline const juce::Colour border  { 0xff1e1e1e };  // main-container border

inline juce::Colour white (float alpha) noexcept
{
    return fg.withAlpha (alpha);
}

// Common opacity tiers used across the sequencer.
namespace alpha {
    constexpr float disabled   = 0.10f;
    constexpr float subtle     = 0.15f;  // borders, section frames
    constexpr float hover      = 0.30f;
    constexpr float secondary  = 0.40f;  // vertical section labels
    constexpr float halfway    = 0.50f;
    constexpr float crumb      = 0.55f;  // header strip text
    constexpr float dim        = 0.60f;
    constexpr float label      = 0.70f;  // knob labels
    constexpr float emphasis   = 0.90f;  // knob indicator tick
    constexpr float full       = 1.00f;
}

// SF Mono on macOS; JUCE falls back to the system mono if missing.
inline juce::Font monoFont (float heightPt, float letterSpacingEm = 0.0f) noexcept
{
    juce::Font f { "SF Mono", heightPt, juce::Font::plain };
    if (letterSpacingEm != 0.0f)
        f = f.withExtraKerningFactor (letterSpacingEm);
    return f;
}

} // namespace newspeech::colors
