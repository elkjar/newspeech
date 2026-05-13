#pragma once

#include <JuceHeader.h>

// Custom LookAndFeel matching the newspeech sequencer's visual language.
// Three SVG-style primitives composed for each knob (ring + arc + tick).
// Toggle buttons draw as filled-or-hollow circles. See sequencer/src/components/Knob.tsx
// and FXPanel.tsx for the source-of-truth web implementation.
class NewspeechLookAndFeel : public juce::LookAndFeel_V4
{
public:
    NewspeechLookAndFeel();

    void drawRotarySlider (juce::Graphics&, int x, int y, int w, int h,
                           float sliderPosProportional,
                           float rotaryStartAngle, float rotaryEndAngle,
                           juce::Slider&) override;

    void drawToggleButton (juce::Graphics&, juce::ToggleButton&,
                           bool shouldDrawButtonAsHighlighted,
                           bool shouldDrawButtonAsDown) override;

    juce::Font getLabelFont (juce::Label&) override;
};
