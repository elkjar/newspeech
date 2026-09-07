#pragma once

#include <JuceHeader.h>

// Look-and-feel shared by every newspeech plugin. Draws the Sequence app's
// primitives: the ring/arc/tick knob, the dot toggle, and the bordered
// uppercase text button. Install once per editor (NewspeechEditor does it).
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

    void drawButtonBackground (juce::Graphics&, juce::Button&, const juce::Colour& backgroundColour,
                               bool shouldDrawButtonAsHighlighted, bool shouldDrawButtonAsDown) override;
    void drawButtonText (juce::Graphics&, juce::TextButton&,
                         bool shouldDrawButtonAsHighlighted, bool shouldDrawButtonAsDown) override;
    juce::Font getTextButtonFont (juce::TextButton&, int buttonHeight) override;

    juce::Font getLabelFont (juce::Label&) override;
};
