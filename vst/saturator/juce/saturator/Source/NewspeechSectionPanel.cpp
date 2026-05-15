#include "NewspeechSectionPanel.h"
#include "NewspeechKnob.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechSectionPanel::NewspeechSectionPanel (const juce::String& t) : title (t) {}

void NewspeechSectionPanel::addControl (juce::Component* c)
{
    controls.add (c);
    addAndMakeVisible (c);
}

void NewspeechSectionPanel::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds().toFloat();

    juce::Graphics::ScopedSaveState save (g);
    const float cx = (float) labelGutter * 0.5f;
    const float cy = bounds.getCentreY();
    g.addTransform (juce::AffineTransform::rotation (-juce::MathConstants<float>::halfPi, cx, cy));

    g.setColour (white (alpha::secondary));
    auto f = monoFont (10.0f, 0.16f);
    g.setFont (f);
    const float textW = bounds.getHeight();
    const float textH = (float) labelGutter;
    g.drawText (title.toUpperCase(),
                juce::Rectangle<float> (cx - textW * 0.5f, cy - textH * 0.5f, textW, textH),
                juce::Justification::centred, false);
}

void NewspeechSectionPanel::resized()
{
    auto r = getLocalBounds();
    r.removeFromLeft (labelGutter);

    const int n = controls.size();
    if (n == 0) return;

    const int h = NewspeechKnob::totalHeight;
    int x = r.getX();
    const int y = r.getY() + (r.getHeight() - h) / 2;

    for (auto* c : controls)
    {
        c->setBounds (x, y, cellWidth, h);
        x += cellWidth + controlGap;
    }
}
