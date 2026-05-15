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
    slider.setMouseDragSensitivity (100);
    addAndMakeVisible (slider);

    label.setText (displayLabel, juce::dontSendNotification);
    label.setFont (monoFont (10.0f, 0.14f));
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
    r.removeFromTop (4);
    label.setBounds (r.removeFromTop (labelHeight));
}
