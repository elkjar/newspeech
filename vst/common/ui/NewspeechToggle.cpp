#include "NewspeechToggle.h"
#include "NewspeechColors.h"
#include "NewspeechKnob.h"

using namespace newspeech::colors;

NewspeechToggle::NewspeechToggle (juce::RangedAudioParameter& param,
                                  const juce::String& displayLabel)
    : parameter (&param)
{
    build (displayLabel);
    button.setToggleState (parameter->getValue() >= 0.5f, juce::dontSendNotification);
    parameter->addListener (this);
    latest = parameter->getValue();
}

NewspeechToggle::NewspeechToggle (const juce::String& displayLabel)
{
    build (displayLabel);
}

void NewspeechToggle::build (const juce::String& displayLabel)
{
    button.setClickingTogglesState (true);
    button.onClick = [this]
    {
        if (parameter != nullptr)
        {
            parameter->beginChangeGesture();
            parameter->setValueNotifyingHost (button.getToggleState() ? 1.0f : 0.0f);
            parameter->endChangeGesture();
        }
        else if (onChange)
        {
            onChange (button.getToggleState());
        }
    };
    addAndMakeVisible (button);

    label.setText (displayLabel.toUpperCase(), juce::dontSendNotification);
    label.setFont (monoFont (type::label, type::labelTracking));
    label.setJustificationType (juce::Justification::centred);
    label.setColour (juce::Label::textColourId, white (alpha::label));
    label.setInterceptsMouseClicks (false, false);
    addAndMakeVisible (label);
}

NewspeechToggle::~NewspeechToggle()
{
    if (parameter != nullptr) parameter->removeListener (this);
}

void NewspeechToggle::resized()
{
    auto r = getLocalBounds();
    auto knobArea = r.removeFromTop (NewspeechKnob::knobDiameter);
    button.setBounds (knobArea.withSizeKeepingCentre (NewspeechKnob::knobDiameter,
                                                      NewspeechKnob::knobDiameter));
    r.removeFromTop (NewspeechKnob::labelGap);
    label.setBounds (r.removeFromTop (NewspeechKnob::labelHeight));
}

// Parameter callbacks fire on the audio thread; bounce to the message thread
// via AsyncUpdater before touching the UI.
void NewspeechToggle::parameterValueChanged (int, float newValue)
{
    latest = newValue;
    triggerAsyncUpdate();
}

void NewspeechToggle::handleAsyncUpdate()
{
    button.setToggleState (latest.load() >= 0.5f, juce::dontSendNotification);
}
