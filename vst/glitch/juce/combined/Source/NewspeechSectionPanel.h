#pragma once

#include <JuceHeader.h>

// Section frame with a rounded-rect border, white@15% stroke, and a vertical
// uppercase label running bottom-to-top along the left edge. Children
// (knobs/toggles) are laid out horizontally to the right of the label.
class NewspeechSectionPanel : public juce::Component
{
public:
    explicit NewspeechSectionPanel (const juce::String& title);

    // Add an already-constructed control (knob or toggle). Panel does not
    // take ownership — caller manages lifetime.
    void addControl (juce::Component* control);

    void paint (juce::Graphics&) override;
    void resized() override;

    static constexpr int labelGutter = 22;
    static constexpr int controlGap  = 6;
    static constexpr int cellWidth   = 80;   // wide enough for "GRAIN RATE"

private:
    juce::String title;
    juce::Array<juce::Component*> controls;
};
