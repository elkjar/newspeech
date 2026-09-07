#include "NewspeechKnob.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechKnob::NewspeechKnob (juce::RangedAudioParameter& param,
                              const juce::String& displayLabel)
    : attachment (param, slider)
{
    slider.setRotaryParameters (juce::degreesToRadians (-135.0f),
                                juce::degreesToRadians ( 135.0f),
                                true);
    slider.setVelocityBasedMode (false);
    slider.setMouseDragSensitivity (100); // Knob.tsx pxPerUnit = 100
    addAndMakeVisible (slider);

    label.setText (displayLabel.toUpperCase(), juce::dontSendNotification);
    label.setFont (monoFont (type::label, type::labelTracking));
    label.setJustificationType (juce::Justification::centred);
    label.setColour (juce::Label::textColourId, white (alpha::label));
    label.setInterceptsMouseClicks (false, false);
    addAndMakeVisible (label);
}

void NewspeechKnob::resized()
{
    auto r = getLocalBounds();
    auto knobArea = r.removeFromTop (knobDiameter);
    slider.setBounds (knobArea.withSizeKeepingCentre (knobDiameter, knobDiameter));
    r.removeFromTop (labelGap);
    label.setBounds (r.removeFromTop (labelHeight));
}
