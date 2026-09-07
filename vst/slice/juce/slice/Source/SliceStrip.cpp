#include "SliceStrip.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

void SliceStrip::setPosition (double ph, double totalBeats, double b, bool has) noexcept
{
    phase = ph; total = totalBeats; bpm = b; hasPattern = has;
    repaint();
}

void SliceStrip::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds();
    const float W = (float) r.getWidth(), H = (float) r.getHeight();
    g.fillAll (surface);
    g.setColour (border);
    g.drawRect (r, 1);
    if (pass == nullptr || total <= 0.0) return;

    // tempo grid: a hairline per beat, brighter every 4
    const double beats = total;
    if (beats <= W / 3.0)
        for (int b = 1; b < (int) std::ceil (beats); ++b)
        {
            g.setColour (white (b % 4 == 0 ? 0.16f : 0.06f));
            g.fillRect ((float) std::floor ((b / total) * W), 0.0f, 1.0f, H);
        }

    const bool data = pass->pattern == slice::Pattern::data;
    const double pos = phase >= 0.0 ? phase * total : -1.0;
    for (int i = 0; i < pass->pass.count; ++i)
    {
        const auto& ev = pass->pass.events[(size_t) i];
        const float x = (float) (ev.t / total) * W;
        const float w = juce::jmax (2.0f, (float) (ev.dur / total) * W);
        const float h = data ? H * (0.2f + 0.6f * ev.level) : (ev.kind != 0 ? H * 0.72f : H * 0.44f);
        const float y = (H - h) * 0.5f;
        const bool active = hasPattern && pos >= ev.t && pos < ev.t + ev.dur;
        if (ev.dropped)
        {
            g.setColour (white (0.15f));
            g.drawRect (juce::Rectangle<float> (x, y, w, h), 1.0f);
        }
        else
        {
            g.setColour (white (active ? 0.95f : 0.25f + 0.25f * ev.level));
            g.fillRect (x, y, w, h);
        }
    }

    if (hasPattern && phase >= 0.0 && phase <= 1.0)
    {
        g.setColour (white (1.0f));
        g.fillRect ((float) std::floor (phase * W), 0.0f, 1.0f, H);
    }

    // pass length — the one clock change the normalised strip can't show as shape
    g.setFont (monoFont (type::label, 0.0f));
    g.setColour (white (0.45f));
    const double secs = total * 60.0 / juce::jmax (1.0, bpm);
    g.drawText (juce::String (secs, 1) + "S", r.reduced (6, 3), juce::Justification::bottomRight, false);
}
