#pragma once

#include <JuceHeader.h>

// Bordered uppercase text button — Sequence's top-bar / transport button
// (`border border-white/15 text-white/60 hover:text-white hover:border-white
// h-[28px]`). Momentary by default; call setClickingTogglesState(true) for a
// latching one, which inverts to white-on-ink while on.
class NewspeechButton : public juce::TextButton
{
public:
    explicit NewspeechButton (const juce::String& text);

    static constexpr int height   = 28;
    static constexpr int paddingX = 8;   // px-2

    // Width that fits the label at the chrome font plus padding.
    int preferredWidth() const;
};
