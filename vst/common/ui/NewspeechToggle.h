#pragma once

#include <JuceHeader.h>

// Dot toggle + uppercase label below, sized to sit in a knob cell. Handles
// both AudioParameterBool and an AudioParameterFloat with step=1, range 0..1 —
// both implement RangedAudioParameter and use 0.0/1.0 normalised values.
class NewspeechToggle : public juce::Component,
                        private juce::AudioProcessorParameter::Listener,
                        private juce::AsyncUpdater
{
public:
    NewspeechToggle (juce::RangedAudioParameter& param, const juce::String& displayLabel);
    ~NewspeechToggle() override;

    void resized() override;

private:
    void parameterValueChanged (int, float newValue) override;
    void parameterGestureChanged (int, bool) override {}
    void handleAsyncUpdate() override;

    juce::RangedAudioParameter& parameter;
    juce::ToggleButton button;
    juce::Label label;
    std::atomic<float> latest { 0.0f };
};
