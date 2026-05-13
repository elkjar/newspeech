#include "NewspeechToggle.h"
#include "NewspeechColors.h"
#include "NewspeechKnob.h"

using namespace newspeech::colors;

NewspeechToggle::NewspeechToggle (juce::RangedAudioParameter& param,
                                  const juce::String& displayLabel)
    : parameter (param)
{
    button.setClickingTogglesState (true);
    button.setToggleState (parameter.getValue() >= 0.5f, juce::dontSendNotification);
    button.onClick = [this]
    {
        parameter.beginChangeGesture();
        parameter.setValueNotifyingHost (button.getToggleState() ? 1.0f : 0.0f);
        parameter.endChangeGesture();
    };
    addAndMakeVisible (button);

    label.setText (displayLabel, juce::dontSendNotification);
    label.setFont (monoFont (10.0f, 0.14f));
    label.setJustificationType (juce::Justification::centred);
    label.setColour (juce::Label::textColourId, white (alpha::label));
    label.setInterceptsMouseClicks (false, false);
    addAndMakeVisible (label);

    parameter.addListener (this);
    latest = parameter.getValue();
}

NewspeechToggle::~NewspeechToggle()
{
    parameter.removeListener (this);
}

void NewspeechToggle::resized()
{
    auto r = getLocalBounds();
    auto knobArea = r.removeFromTop (NewspeechKnob::knobDiameter);
    button.setBounds (knobArea.withSizeKeepingCentre (NewspeechKnob::knobDiameter,
                                                      NewspeechKnob::knobDiameter));
    r.removeFromTop (4);
    label.setBounds (r.removeFromTop (NewspeechKnob::labelHeight));
}

// Parameter callbacks fire on the audio thread; bounce to message thread
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
