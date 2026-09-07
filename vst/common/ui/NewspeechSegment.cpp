#include "NewspeechSegment.h"
#include "NewspeechColors.h"
#include "NewspeechKnob.h"
#include "NewspeechButton.h"

using namespace newspeech::colors;

NewspeechSegment::NewspeechSegment (juce::RangedAudioParameter& param, const juce::String& displayLabel,
                                    const juce::StringArray& names)
    : parameter (param)
{
    for (int i = 0; i < names.size(); ++i)
    {
        auto* b = buttons.add (new juce::TextButton (names[i]));
        b->setClickingTogglesState (false);
        b->setMouseCursor (juce::MouseCursor::PointingHandCursor);
        b->onClick = [this, i] { select (i, true); };
        addAndMakeVisible (b);
    }

    label.setText (displayLabel.toUpperCase(), juce::dontSendNotification);
    label.setFont (monoFont (type::label, type::labelTracking));
    label.setJustificationType (juce::Justification::centred);
    label.setColour (juce::Label::textColourId, white (alpha::label));
    label.setInterceptsMouseClicks (false, false);
    addAndMakeVisible (label);

    parameter.addListener (this);
    latest = parameter.getValue();
    select (indexFromNormalised (latest.load()), false);
}

NewspeechSegment::~NewspeechSegment()
{
    parameter.removeListener (this);
}

int NewspeechSegment::indexFromNormalised (float v) const noexcept
{
    return juce::jlimit (0, buttons.size() - 1, juce::roundToInt (parameter.convertFrom0to1 (v)));
}

int NewspeechSegment::preferredWidth() const
{
    const auto f = monoFont (type::chrome, type::chromeTracking);
    int w = 0;
    for (auto* b : buttons)
        w += juce::jmax (minButtonWidth,
                         juce::roundToInt (f.getStringWidthFloat (b->getButtonText().toUpperCase()))
                             + 2 * NewspeechButton::paddingX);
    // Abutting buttons share their 1px borders.
    return w - (buttons.size() - 1);
}

void NewspeechSegment::setCompact (bool c)
{
    compact = c;
    label.setVisible (! c);
    resized();
}

void NewspeechSegment::resized()
{
    auto r = getLocalBounds();
    auto row = compact ? r : r.removeFromTop (NewspeechKnob::knobDiameter);
    const auto f = monoFont (type::chrome, type::chromeTracking);

    int x = row.getX() + (row.getWidth() - preferredWidth()) / 2;
    const int y = row.getCentreY() - NewspeechButton::height / 2;
    for (auto* b : buttons)
    {
        const int w = juce::jmax (minButtonWidth,
                                  juce::roundToInt (f.getStringWidthFloat (b->getButtonText().toUpperCase()))
                                      + 2 * NewspeechButton::paddingX);
        b->setBounds (x, y, w, NewspeechButton::height);
        x += w - 1;
    }

    if (compact) return;
    r.removeFromTop (NewspeechKnob::labelGap);
    label.setBounds (r.removeFromTop (NewspeechKnob::labelHeight));
}

void NewspeechSegment::select (int index, bool notifyHost)
{
    current = juce::jlimit (0, buttons.size() - 1, index);
    for (int i = 0; i < buttons.size(); ++i)
    {
        buttons[i]->setToggleState (i == current, juce::dontSendNotification);
        // The selected button sits on top so its border wins the shared edge.
        if (i == current) buttons[i]->toFront (false);
    }
    if (notifyHost)
    {
        parameter.beginChangeGesture();
        parameter.setValueNotifyingHost (parameter.convertTo0to1 ((float) current));
        parameter.endChangeGesture();
    }
}

void NewspeechSegment::parameterValueChanged (int, float newValue)
{
    latest = newValue;
    triggerAsyncUpdate();
}

void NewspeechSegment::handleAsyncUpdate()
{
    select (indexFromNormalised (latest.load()), false);
}
