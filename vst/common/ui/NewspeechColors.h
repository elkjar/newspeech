#pragma once

#include <JuceHeader.h>

// Newspeech palette + type scale — mirrors the Sequence app as it stands today
// (sequencer/src/index.css, tailwind.config.ts, and the className vocabulary
// used across sequencer/src/components). White-on-ink with opacity tiers, no
// chromatic accents anywhere, square corners, 1px borders. Every plugin editor
// draws from this file so the suite reads as one instrument.
namespace newspeech::colors {

inline const juce::Colour ink     { 0xff050505 };  // page / editor background
inline const juce::Colour surface { 0xff0a0a0a };  // secondary surface (bg-[#0a0a0a])
inline const juce::Colour fg      { 0xffffffff };

inline juce::Colour white (float alpha) noexcept
{
    return fg.withAlpha (alpha);
}

// Opacity tiers, named after the Tailwind classes they came from.
namespace alpha {
    constexpr float divider     = 0.10f;  // w-px bg-white/10 between groups
    constexpr float border      = 0.15f;  // border-white/15 — every box
    constexpr float placeholder = 0.25f;  // placeholder:text-white/25
    constexpr float ring        = 0.30f;  // toggle-off ring, border-white/30
    constexpr float heading     = 0.40f;  // group headings text-white/40
    constexpr float halfway     = 0.50f;
    constexpr float crumb       = 0.55f;  // header crumb opacity-55
    constexpr float dim         = 0.60f;  // button text at rest text-white/60
    constexpr float label       = 0.70f;  // knob labels opacity-70
    constexpr float emphasis    = 0.90f;  // knob indicator tick
    constexpr float full        = 1.00f;
}

inline const juce::Colour border  { fg.withAlpha (alpha::border)  };
inline const juce::Colour divider { fg.withAlpha (alpha::divider) };

// Type scale (px, letter-spacing in em) — the four sizes Sequence uses.
namespace type {
    constexpr float heading         = 9.0f;   // text-[9px] tracking-widest — group headings
    constexpr float headingTracking = 0.10f;
    constexpr float label           = 10.0f;  // text-[10px] tracking-[0.14em] — knob labels
    constexpr float labelTracking   = 0.14f;
    constexpr float chrome          = 11.0f;  // text-[11px] tracking-widest — buttons, fields
    constexpr float chromeTracking  = 0.10f;
    constexpr float crumb           = 12.0f;  // .crumb — header strip
    constexpr float crumbTracking   = 0.12f;
}

// ui-monospace → SF Mono on macOS; JUCE falls back to the system mono if missing.
inline juce::Font monoFont (float heightPx, float letterSpacingEm = 0.0f) noexcept
{
    juce::Font f { "SF Mono", heightPx, juce::Font::plain };
    if (letterSpacingEm != 0.0f)
        f = f.withExtraKerningFactor (letterSpacingEm);
    return f;
}

} // namespace newspeech::colors
