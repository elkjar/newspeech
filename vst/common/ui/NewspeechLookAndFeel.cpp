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
    setColour (juce::TextButton::buttonColourId,   juce::Colours::transparentBlack);
    setColour (juce::TextButton::buttonOnColourId, juce::Colours::transparentBlack);
}

// sequencer/src/components/Knob.tsx — three white SVG primitives stacked.
// Ring (r = size*0.36, opacity 0.12, 0.22 on hover), value arc from -135° to
// -135° + 270°*value (opacity 0.7, sw 1.75, round caps), indicator line from
// inner radius size*0.17 to the ring at the current angle (opacity 0.9).
void NewspeechLookAndFeel::drawRotarySlider (juce::Graphics& g,
                                             int x, int y, int w, int h,
                                             float pos,
                                             float /*startAngleRad*/, float /*endAngleRad*/,
                                             juce::Slider& s)
{
    const auto size = (float) juce::jmin (w, h);
    const float cx = x + w * 0.5f;
    const float cy = y + h * 0.5f;
    const float ringR  = size * 0.36f;
    const float tickIn = size * 0.17f;

    constexpr float startDeg = -135.0f;
    constexpr float sweepDeg =  270.0f;
    const float angleDeg = startDeg + sweepDeg * pos;
    const float angleRad = juce::degreesToRadians (angleDeg);
    const float startRad = juce::degreesToRadians (startDeg);

    const bool over = s.isMouseOverOrDragging();
    g.setColour (white (over ? 0.22f : 0.12f));
    g.drawEllipse (cx - ringR, cy - ringR, ringR * 2.0f, ringR * 2.0f, 1.0f);

    if (pos > 0.0001f)
    {
        juce::Path arc;
        arc.addCentredArc (cx, cy, ringR, ringR, 0.0f, startRad, angleRad, true);
        g.setColour (white (alpha::label));
        g.strokePath (arc, juce::PathStrokeType (1.75f,
                                                 juce::PathStrokeType::curved,
                                                 juce::PathStrokeType::rounded));
    }

    // Y is inverted in screen space: cos drives -y, sin drives x.
    const float tx1 = cx + tickIn * std::sin (angleRad);
    const float ty1 = cy - tickIn * std::cos (angleRad);
    const float tx2 = cx + ringR  * std::sin (angleRad);
    const float ty2 = cy - ringR  * std::cos (angleRad);
    g.setColour (white (alpha::emphasis));
    g.drawLine ({ tx1, ty1, tx2, ty2 }, 1.75f);
}

// sequencer MacroStrip FreezeButton / AutoButton — a dot 0.36× the cell,
// filled white when on; a white/30 ring when off, white on hover.
void NewspeechLookAndFeel::drawToggleButton (juce::Graphics& g, juce::ToggleButton& b,
                                             bool /*highlighted*/, bool /*down*/)
{
    const auto bounds = b.getLocalBounds().toFloat();
    const float size = juce::jmin (bounds.getWidth(), bounds.getHeight());
    const float r  = size * 0.18f;
    const float cx = bounds.getCentreX();
    const float cy = bounds.getCentreY();

    if (b.getToggleState())
    {
        g.setColour (white (alpha::full));
        g.fillEllipse (cx - r, cy - r, r * 2.0f, r * 2.0f);
    }
    else
    {
        g.setColour (white (b.isMouseOver() ? alpha::full : alpha::ring));
        g.drawEllipse (cx - r, cy - r, r * 2.0f, r * 2.0f, 1.0f);
    }
}

// Transport.tsx button: `px-2 text-[11px] uppercase tracking-widest border
// border-white/15 text-white/60 hover:text-white hover:border-white h-[28px]`.
// A toggled-on button inverts (white fill, ink text) — the StepButton fill.
void NewspeechLookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& b, const juce::Colour&,
                                                 bool highlighted, bool down)
{
    const auto r = b.getLocalBounds().toFloat();
    const bool on = b.getToggleState();
    if (on)
    {
        g.setColour (white (alpha::full));
        g.fillRect (r);
    }
    g.setColour (white ((on || highlighted || down) ? alpha::full : alpha::border));
    g.drawRect (r, 1.0f);
}

void NewspeechLookAndFeel::drawButtonText (juce::Graphics& g, juce::TextButton& b,
                                           bool highlighted, bool down)
{
    g.setFont (getTextButtonFont (b, b.getHeight()));
    const bool on = b.getToggleState();
    g.setColour (on ? ink : white ((highlighted || down) ? alpha::full : alpha::dim));
    g.drawText (b.getButtonText().toUpperCase(), b.getLocalBounds(),
                juce::Justification::centred, false);
}

juce::Font NewspeechLookAndFeel::getTextButtonFont (juce::TextButton&, int)
{
    return monoFont (type::chrome, type::chromeTracking);
}

juce::Font NewspeechLookAndFeel::getLabelFont (juce::Label& l)
{
    return monoFont (l.getFont().getHeight(), type::labelTracking);
}
