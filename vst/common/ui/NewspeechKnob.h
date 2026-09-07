#pragma once

#include <JuceHeader.h>

// Rotary slider + uppercase label below, bound to a RangedAudioParameter.
// The knob visual comes from NewspeechLookAndFeel::drawRotarySlider; the
// label matches Sequence's `text-[10px] uppercase tracking-[0.14em] opacity-70`.
class NewspeechKnob : public juce::Component
{
public:
    NewspeechKnob (juce::RangedAudioParameter& param, const juce::String& displayLabel);
    ~NewspeechKnob() override = default;

    void resized() override;

    static constexpr int knobDiameter = 44;
    static constexpr int labelGap     = 4;
    static constexpr int labelHeight  = 14;
    static constexpr int totalHeight  = knobDiameter + labelGap + labelHeight;

private:
    juce::Slider slider { juce::Slider::RotaryHorizontalVerticalDrag,
                          juce::Slider::NoTextBox };
    juce::Label  label;
    juce::SliderParameterAttachment attachment;
};
