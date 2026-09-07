#pragma once

#include <JuceHeader.h>

// Segmented switch bound to a choice parameter (AudioParameterChoice, or any
// RangedAudioParameter with integer steps): a row of abutting bordered
// buttons — the selected one inverts to white-on-ink — with the uppercase
// knob label below, so it sits in a section panel row like a wide knob cell.
// Mirrors the `.seg` rows on the site's tool pages.
class NewspeechSegment : public juce::Component,
                         private juce::AudioProcessorParameter::Listener,
                         private juce::AsyncUpdater
{
public:
    // `names` are the button captions; count must match the parameter's steps.
    NewspeechSegment (juce::RangedAudioParameter& param, const juce::String& displayLabel,
                      const juce::StringArray& names);
    ~NewspeechSegment() override;

    int  preferredWidth() const;
    int  selectedIndex() const noexcept { return current; }
    void resized() override;

    // Compact: buttons only, filling the component's height — for a segment
    // that sits on a text-field line rather than in a knob cell.
    void setCompact (bool shouldBeCompact);

    static constexpr int minButtonWidth = 36;

private:
    void parameterValueChanged (int, float newValue) override;
    void parameterGestureChanged (int, bool) override {}
    void handleAsyncUpdate() override;
    void select (int index, bool notifyHost);
    int  indexFromNormalised (float v) const noexcept;

    juce::RangedAudioParameter& parameter;
    juce::OwnedArray<juce::TextButton> buttons;
    juce::Label label;
    int current = 0;
    bool compact = false;
    std::atomic<float> latest { 0.0f };
};
