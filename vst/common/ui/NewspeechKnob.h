#pragma once

#include <JuceHeader.h>

// Rotary slider + uppercase label below. Bound to a RangedAudioParameter, or
// "free" (no parameter: the owner reads/writes the 0..1 value — for settings
// that live in plugin state rather than as host parameters, e.g. a glitch
// block's own knobs). The knob visual comes from
// NewspeechLookAndFeel::drawRotarySlider; the label matches Sequence's
// `text-[10px] uppercase tracking-[0.14em] opacity-70`.
class NewspeechKnob : public juce::Component
{
public:
    NewspeechKnob (juce::RangedAudioParameter& param, const juce::String& displayLabel);
    // Free knob: 0..1, optionally stepped (`steps` positions, 0 = continuous).
    explicit NewspeechKnob (const juce::String& displayLabel, int steps = 0);
    ~NewspeechKnob() override = default;

    // Free-knob API (no-ops on a parameter-bound knob).
    std::function<void (float)> onChange;          // user moved it (0..1)
    void  setValue (float v01, bool notify = false);
    float getValue() const noexcept { return (float) slider.getValue(); }
    void  setLabel (const juce::String& text);

    void resized() override;

    // Bipolar knobs (a ± offset) fill their arc from the top (centre value)
    // rather than from the left end, as the site's dah± knob does.
    void setBipolar (bool shouldBeBipolar);

    static constexpr int knobDiameter = 44;
    static constexpr int labelGap     = 4;
    static constexpr int labelHeight  = 14;
    static constexpr int totalHeight  = knobDiameter + labelGap + labelHeight;

private:
    void setupCommon (const juce::String& displayLabel);

    juce::Slider slider { juce::Slider::RotaryHorizontalVerticalDrag,
                          juce::Slider::NoTextBox };
    juce::Label  label;
    std::unique_ptr<juce::SliderParameterAttachment> attachment;
};
