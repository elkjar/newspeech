#include "NewspeechSectionPanel.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechSectionPanel::NewspeechSectionPanel (const juce::String& t) : title (t) {}

void NewspeechSectionPanel::addControl (juce::Component* c, int width)
{
    controls.add (c);
    widths.add (width);
    addAndMakeVisible (c);
}

void NewspeechSectionPanel::addWideControl (juce::Component* c, int contentWidth)
{
    addControl (c, contentWidth + 2 * wideMargin);
}

int NewspeechSectionPanel::preferredWidth() const noexcept
{
    int w = 0;
    for (int i = 0; i < widths.size(); ++i)
        w += widths[i] + (i > 0 ? controlGap : 0);
    return w;
}

juce::Rectangle<int> NewspeechSectionPanel::boxBounds() const noexcept
{
    return { boxInset, lineY, getWidth() - 2 * boxInset, getHeight() - lineY };
}

void NewspeechSectionPanel::paint (juce::Graphics& g)
{
    const auto box = boxBounds();

    // `border border-white/15`, square.
    g.setColour (border);
    g.drawRect (box, 1);

    // Heading on the line: `text-[9px] uppercase tracking-widest text-white/40`.
    const auto font = monoFont (type::heading, type::headingTracking);
    const auto text = title.toUpperCase();
    const int  textW = juce::roundToInt (font.getStringWidthFloat (text));
    const int  textX = box.getX() + headingLead;

    // Interrupt the border behind the text, then draw it.
    g.setColour (ink);
    g.fillRect (textX - headingGapPad, 0, textW + 2 * headingGapPad, headingHeight);

    g.setColour (white (alpha::heading));
    g.setFont (font);
    g.drawText (text, textX, 0, textW + 4, headingHeight, juce::Justification::centredLeft, false);
}

void NewspeechSectionPanel::resized()
{
    int x = 0;
    const int y = lineY + pad;
    for (int i = 0; i < controls.size(); ++i)
    {
        controls[i]->setBounds (x, y, widths[i], NewspeechKnob::totalHeight);
        x += widths[i] + controlGap;
    }
}
