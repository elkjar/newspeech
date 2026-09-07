#include "SliceReadout.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

void SliceReadout::paint (juce::Graphics& g)
{
    if (pass == nullptr) return;
    const auto r = getLocalBounds();
    const float W = (float) r.getWidth(), H = (float) r.getHeight();

    if (pass->pattern == slice::Pattern::data)
    {
        const auto& cur = pass->curSeries;
        const auto& orig = pass->origSeries;
        const int n = cur.len;
        g.setFont (monoFont (type::heading, type::headingTracking));
        if (n == 0)
        {
            g.setColour (white (alpha::heading));
            g.drawText ("NO POINTS YET", r, juce::Justification::centredLeft, false);
            return;
        }
        const float bw = W / (float) n;
        int corrupted = 0;
        for (int i = 0; i < n; ++i)
        {
            const float v = cur.v[(size_t) i];
            const float norm = orig.norm (v);
            const float bh = juce::jmax (1.0f, norm * (H - 2.0f));
            const bool bad = v != orig.v[(size_t) i];
            if (bad) ++corrupted;
            g.setColour (white (bad ? 0.95f : (norm >= thresh ? 0.55f : 0.18f)));
            g.fillRect ((float) i * bw, H - bh, juce::jmax (1.0f, bw - juce::jmin (2.0f, bw * 0.2f)), bh);
        }
        // the threshold: points above the line play
        const float ty = H - thresh * (H - 2.0f);
        g.setColour (white (0.6f));
        const float dash[] = { 4.0f, 4.0f };
        g.drawDashedLine (juce::Line<float> (0.0f, ty, W, ty), dash, 2, 1.0f);

        juce::String info;
        info << n << " PTS · " << juce::String (orig.min, 2) << " – " << juce::String (orig.max, 2);
        if (corrupted > 0) info << " · " << corrupted << " CORRUPTED";
        g.setColour (white (alpha::heading));
        g.drawText (info, r.reduced (4, 1), juce::Justification::topRight, false);
        return;
    }

    // text modes: char above, code below
    const bool bits = pass->pattern == slice::Pattern::bits;
    const auto& cur = pass->curMsg;
    const auto& orig = pass->origMsg;
    const auto charFont = monoFont (13.0f, 0.0f);
    const auto codeFont = monoFont (type::label, 0.08f);
    const int  charH = 15, codeH = 12;
    const int  top = juce::jmax (0, (r.getHeight() - (charH + codeH)) / 2);
    float x = 0.0f;
    for (int i = 0; i < cur.len; ++i)
    {
        const char c = cur.ch[(size_t) i];
        if (c == ' ') { x += 20.0f; continue; }
        juce::String code;
        if (bits)
        {
            for (int b = 7; b >= 0; --b) code << ((((unsigned char) c) >> b) & 1u ? "1" : "0");
        }
        else if (const char* m = slice::morseFor (c))
        {
            for (const char* p = m; *p; ++p) code << (*p == '.' ? juce::String (juce::CharPointer_UTF8 ("\xc2\xb7")) : juce::String (juce::CharPointer_UTF8 ("\xe2\x88\x92")));
        }
        const float cw = juce::jmax (14.0f, codeFont.getStringWidthFloat (code) + 2.0f);
        if (x + cw > W) break;   // clipped, like the page's single readout line
        const bool bad = c != orig.ch[(size_t) i];
        const bool now = i == lit;
        const juce::Rectangle<int> cell ((int) x, top, (int) std::ceil (cw), charH);

        g.setFont (charFont);
        g.setColour (white ((bad || now) ? 1.0f : 0.73f));
        g.drawText (juce::String::charToString ((juce::juce_wchar) c), cell, juce::Justification::centred, false);
        if (bad)
        {
            g.setColour (white (0.5f));
            g.fillRect ((float) cell.getX() + 1.0f, (float) cell.getCentreY(), cw - 2.0f, 1.0f);
        }
        g.setFont (codeFont);
        g.setColour (white (now ? 0.8f : 0.33f));
        g.drawText (code, cell.withY (top + charH).withHeight (codeH), juce::Justification::centred, false);
        x += cw + 10.0f;
    }
}
