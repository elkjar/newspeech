#pragma once

#include <JuceHeader.h>

// Single-line mono text field — the site's `#msginput` / Sequence's text
// inputs: surface background, square white/15 border (white/50 focused),
// 11px SF Mono with wide tracking, white/25 placeholder. Use onTextChange /
// onReturnKey from juce::TextEditor.
class NewspeechTextField : public juce::TextEditor
{
public:
    explicit NewspeechTextField (const juce::String& placeholder = {});

    void setPlaceholder (const juce::String& placeholder);

    static constexpr int height = 28;

private:
    void paintOverChildren (juce::Graphics&) override;
    void focusGained (FocusChangeType) override;
    void focusLost (FocusChangeType) override;
};
