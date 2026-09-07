#include "NewspeechKnob.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechKnob::NewspeechKnob (juce::RangedAudioParameter& param,
                              const juce::String& displayLabel)
{
    attachment = std::make_unique<juce::SliderParameterAttachment> (param, slider);
    setupCommon (displayLabel);
}

NewspeechKnob::NewspeechKnob (const juce::String& displayLabel, int steps)
{
    slider.setRange (0.0, 1.0, steps > 1 ? 1.0 / (steps - 1) : 0.0);
    slider.onValueChange = [this] { if (onChange) onChange ((float) slider.getValue()); };
    setupCommon (displayLabel);
}

void NewspeechKnob::setValue (float v, bool notify)
{
    slider.setValue (juce::jlimit (0.0f, 1.0f, v), notify ? juce::sendNotificationSync : juce::dontSendNotification);
}

void NewspeechKnob::setLabel (const juce::String& text)
{
    label.setText (text.toUpperCase(), juce::dontSendNotification);
}

void NewspeechKnob::setupCommon (const juce::String& displayLabel)
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

void NewspeechKnob::setBipolar (bool b)
{
    slider.getProperties().set ("bipolar", b);
    slider.repaint();
}

void NewspeechKnob::resized()
{
    auto r = getLocalBounds();
    auto knobArea = r.removeFromTop (knobDiameter);
    slider.setBounds (knobArea.withSizeKeepingCentre (knobDiameter, knobDiameter));
    r.removeFromTop (labelGap);
    label.setBounds (r.removeFromTop (labelHeight));
}
