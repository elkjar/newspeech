#pragma once

#include <JuceHeader.h>

// Binary control rendered as a filled (on) or hollow (off) circle, sized to
// match the knob ring. Handles both AudioParameterBool (HOLD) and an
// AudioParameterFloat with step=1, range 0..1 (REVERSE) — both implement
// RangedAudioParameter and use 0.0/1.0 normalised values, so one wrapper
// covers both.
class NewspeechToggle : public juce::Component,
                        private juce::AudioProcessorParameter::Listener,
                        private juce::AsyncUpdater
{
public:
    NewspeechToggle (juce::RangedAudioParameter& param, const juce::String& displayLabel);
    ~NewspeechToggle() override;

    void resized() override;

    static constexpr int totalHeight = 44 + 4 + 14;

private:
    void parameterValueChanged (int, float newValue) override;
    void parameterGestureChanged (int, bool) override {}
    void handleAsyncUpdate() override;

    juce::RangedAudioParameter& parameter;
    juce::ToggleButton button;
    juce::Label label;
    std::atomic<float> latest { 0.0f };
};
