#pragma once

#include <JuceHeader.h>

// Rotary slider + label-below composite, bound to a RangedAudioParameter.
// The slider's visual is provided by NewspeechLookAndFeel::drawRotarySlider.
class NewspeechKnob : public juce::Component
{
public:
    NewspeechKnob (juce::RangedAudioParameter& param, const juce::String& displayLabel);
    ~NewspeechKnob() override = default;

    void resized() override;

    static constexpr int knobDiameter = 44;
    static constexpr int labelHeight  = 14;
    static constexpr int totalHeight  = knobDiameter + 4 + labelHeight;

private:
    juce::Slider slider { juce::Slider::RotaryHorizontalVerticalDrag,
                          juce::Slider::NoTextBox };
    juce::Label  label;
    juce::SliderParameterAttachment attachment;
};
