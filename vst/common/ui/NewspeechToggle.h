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
    // Free toggle (no parameter): owner reads isOn() / gets onChange.
    explicit NewspeechToggle (const juce::String& displayLabel);
    ~NewspeechToggle() override;

    std::function<void (bool)> onChange;
    bool isOn() const noexcept { return button.getToggleState(); }
    void setOn (bool on) { button.setToggleState (on, juce::dontSendNotification); }

    void resized() override;

private:
    void parameterValueChanged (int, float newValue) override;
    void parameterGestureChanged (int, bool) override {}
    void handleAsyncUpdate() override;

    void build (const juce::String& displayLabel);

    juce::RangedAudioParameter* parameter = nullptr;   // null for a free toggle
    juce::ToggleButton button;
    juce::Label label;
    std::atomic<float> latest { 0.0f };
};
