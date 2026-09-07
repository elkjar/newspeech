#include "NewspeechTextField.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechTextField::NewspeechTextField (const juce::String& placeholder)
{
    setMultiLine (false);
    setReturnKeyStartsNewLine (false);
    setScrollbarsShown (false);
    setCaretVisible (true);
    setPopupMenuEnabled (false);
    setBorder (juce::BorderSize<int> (0));
    setIndents (8, 0);
    setJustification (juce::Justification::centredLeft);
    applyFontToAllText (monoFont (type::chrome, type::chromeTracking));
    setFont (monoFont (type::chrome, type::chromeTracking));

    setColour (juce::TextEditor::backgroundColourId,      surface);
    setColour (juce::TextEditor::textColourId,            white (alpha::emphasis));
    setColour (juce::TextEditor::highlightColourId,       white (alpha::placeholder));
    setColour (juce::TextEditor::highlightedTextColourId, white (alpha::full));
    setColour (juce::TextEditor::outlineColourId,         juce::Colours::transparentBlack);
    setColour (juce::TextEditor::focusedOutlineColourId,  juce::Colours::transparentBlack);
    setColour (juce::TextEditor::shadowColourId,          juce::Colours::transparentBlack);
    setColour (juce::CaretComponent::caretColourId,       white (alpha::full));

    setPlaceholder (placeholder);
}

void NewspeechTextField::setPlaceholder (const juce::String& placeholder)
{
    setTextToShowWhenEmpty (placeholder, white (alpha::placeholder));
    repaint();
}

// Square 1px border drawn over the editor so it stays crisp at any size.
void NewspeechTextField::paintOverChildren (juce::Graphics& g)
{
    g.setColour (white (hasKeyboardFocus (true) ? alpha::halfway : alpha::border));
    g.drawRect (getLocalBounds(), 1);
}

void NewspeechTextField::focusGained (FocusChangeType t) { juce::TextEditor::focusGained (t); repaint(); }
void NewspeechTextField::focusLost   (FocusChangeType t) { juce::TextEditor::focusLost (t);   repaint(); }
