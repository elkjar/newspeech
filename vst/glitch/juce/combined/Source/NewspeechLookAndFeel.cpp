#include "NewspeechLookAndFeel.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechLookAndFeel::NewspeechLookAndFeel()
{
    setColour (juce::Label::textColourId,         white (alpha::label));
    setColour (juce::Label::backgroundColourId,   juce::Colours::transparentBlack);
    setColour (juce::Slider::backgroundColourId,  juce::Colours::transparentBlack);
    setColour (juce::Slider::trackColourId,       juce::Colours::transparentBlack);
    setColour (juce::Slider::thumbColourId,       juce::Colours::transparentBlack);
    setColour (juce::Slider::rotarySliderFillColourId,    juce::Colours::transparentBlack);
    setColour (juce::Slider::rotarySliderOutlineColourId, juce::Colours::transparentBlack);
}

// Ported from sequencer/src/components/Knob.tsx — three white SVG primitives
// stacked together. Ring (r = size*0.36, opacity 0.12), value arc from -135°
// to -135° + 270°*value (opacity 0.7, sw 1.75, round caps), indicator line
// from inner radius size*0.17 to outer radius size*0.36 at the current angle
// (opacity 0.9, sw 1.75, round caps).
void NewspeechLookAndFeel::drawRotarySlider (juce::Graphics& g,
                                             int x, int y, int w, int h,
                                             float pos,
                                             float /*startAngleRad*/, float /*endAngleRad*/,
                                             juce::Slider& s)
{
    const auto size = (float) juce::jmin (w, h);
    const float cx = x + w * 0.5f;
    const float cy = y + h * 0.5f;
    const float ringR    = size * 0.36f;
    const float tickIn   = size * 0.17f;

    // -135° → +135°, top is 0°. Convert to radians around vertical-up axis.
    constexpr float startDeg = -135.0f;
    constexpr float sweepDeg =  270.0f;
    const float angleDeg = startDeg + sweepDeg * pos;
    const float angleRad = juce::degreesToRadians (angleDeg);
    const float startRad = juce::degreesToRadians (startDeg);

    // Ring.
    const bool over = s.isMouseOverOrDragging();
    g.setColour (white (over ? 0.22f : 0.12f));
    g.drawEllipse (cx - ringR, cy - ringR, ringR * 2.0f, ringR * 2.0f, 1.0f);

    // Value arc (only when there's something to draw).
    if (pos > 0.0001f)
    {
        juce::Path arc;
        arc.addCentredArc (cx, cy, ringR, ringR, 0.0f, startRad, angleRad, true);
        g.setColour (white (alpha::label));
        g.strokePath (arc, juce::PathStrokeType (1.75f,
                                                 juce::PathStrokeType::curved,
                                                 juce::PathStrokeType::rounded));
    }

    // Indicator tick from inner to outer along the current angle. Y-axis is
    // inverted in screen space, so cos drives -y, sin drives x.
    const float tx1 = cx + tickIn * std::sin (angleRad);
    const float ty1 = cy - tickIn * std::cos (angleRad);
    const float tx2 = cx + ringR  * std::sin (angleRad);
    const float ty2 = cy - ringR  * std::cos (angleRad);
    g.setColour (white (alpha::emphasis));
    g.drawLine ({ tx1, ty1, tx2, ty2 }, 1.75f);
}

// Toggle circle the size of a knob ring: filled white when on, hollow ring
// (white at 30%, 1px) when off. The button's bounds are sized by the parent
// component to match the knob ring diameter.
void NewspeechLookAndFeel::drawToggleButton (juce::Graphics& g, juce::ToggleButton& b,
                                             bool /*highlighted*/, bool /*down*/)
{
    const auto bounds = b.getLocalBounds().toFloat();
    const float size = juce::jmin (bounds.getWidth(), bounds.getHeight());
    const float r = size * 0.36f;
    const float cx = bounds.getCentreX();
    const float cy = bounds.getCentreY();

    if (b.getToggleState())
    {
        g.setColour (white (alpha::full));
        g.fillEllipse (cx - r, cy - r, r * 2.0f, r * 2.0f);
    }
    else
    {
        g.setColour (white (b.isMouseOver() ? alpha::full : alpha::hover));
        g.drawEllipse (cx - r, cy - r, r * 2.0f, r * 2.0f, 1.0f);
    }
}

juce::Font NewspeechLookAndFeel::getLabelFont (juce::Label& l)
{
    return monoFont (l.getFont().getHeight(), 0.14f);
}
