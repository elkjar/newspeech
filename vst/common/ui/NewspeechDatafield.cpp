#include "NewspeechDatafield.h"
#include "NewspeechColors.h"
#include <vector>

using namespace newspeech::colors;

namespace {
    // The micrographic PNG sat around white/30 — keep that quieter register.
    constexpr float kTextAlpha = 0.30f;
    constexpr float kBarFloor  = 0.30f;   // idle bar brightness = text; peaks lift toward white
    const juce::Font& dataFont()
    {
        static const juce::Font f = monoFont (type::label, type::labelTracking);
        return f;
    }

    // Code 39. Each symbol is 9 elements alternating bar/space starting with a
    // bar; '1' = wide (3 units), '0' = narrow (1 unit); a narrow space between
    // symbols. The strip is a real, scannable barcode — the live level only
    // sets each bar's brightness.
    const char* code39 (juce::juce_wchar c)
    {
        switch (c)
        {
            case '0': return "000110100"; case '1': return "100100001"; case '2': return "001100001";
            case '3': return "101100000"; case '4': return "000110001"; case '5': return "100110000";
            case '6': return "001110000"; case '7': return "000100101"; case '8': return "100100100";
            case '9': return "001100100"; case 'A': return "100001001"; case 'B': return "001001001";
            case 'C': return "101001000"; case 'D': return "000011001"; case 'E': return "100011000";
            case 'F': return "001011000"; case 'G': return "000001101"; case 'H': return "100001100";
            case 'I': return "001001100"; case 'J': return "000011100"; case 'K': return "100000011";
            case 'L': return "001000011"; case 'M': return "101000010"; case 'N': return "000010011";
            case 'O': return "100010010"; case 'P': return "001010010"; case 'Q': return "000000111";
            case 'R': return "100000110"; case 'S': return "001000110"; case 'T': return "000010110";
            case 'U': return "110000001"; case 'V': return "011000001"; case 'W': return "111000000";
            case 'X': return "010010001"; case 'Y': return "110010000"; case 'Z': return "011010000";
            case '-': return "010000101"; case '.': return "110000100"; case ' ': return "011000100";
            case '*': return "010010100"; case '$': return "010101000"; case '/': return "010100010";
            case '+': return "010001010"; case '%': return "000101010";
            default:  return "011000100"; // unencodable → space
        }
    }

    struct Bar { float x, w; };

    // Lay the barcode out in narrow-units across `width`, returning bar rects.
    std::vector<Bar> barcodeBars (const juce::String& payload, float width)
    {
        const juce::String text = "*" + payload.toUpperCase() + "*";
        constexpr int wide = 3, narrow = 1;
        // symbols: 6 narrow + 3 wide = 15 units each, plus a narrow gap between
        const int units = text.length() * 15 + (text.length() - 1) * narrow;
        const float unit = width / (float) units;

        std::vector<Bar> bars;
        float x = 0.0f;
        for (int i = 0; i < text.length(); ++i)
        {
            const char* pat = code39 (text[i]);
            for (int e = 0; e < 9; ++e)
            {
                const float w = (pat[e] == '1' ? wide : narrow) * unit;
                if ((e % 2) == 0) bars.push_back ({ x, w });
                x += w;
            }
            x += narrow * unit;
        }
        return bars;
    }
}

NewspeechDatafield::NewspeechDatafield (juce::AudioProcessor& p)
    : proc (p)
{
    if (auto* src = dynamic_cast<newspeech::TelemetrySource*> (&proc))
        telemetry = &src->telemetry();

    versionLine = juce::String ("[NS-AE] V") + JucePlugin_VersionString;
    siteLine    = "WWW.NEWSPEECHSOUND.COM";

    setInterceptsMouseClicks (false, false);
    startTimerHz (30);
}

NewspeechDatafield::~NewspeechDatafield()
{
    stopTimer();
}

int NewspeechDatafield::preferredWidth() const
{
    // Widest plausible live line sets the width so nothing reflows.
    const auto& f = dataFont();
    const float w = juce::jmax (f.getStringWidthFloat (siteLine),
                                f.getStringWidthFloat ("192.0KHZ · 4096 · 999.9BPM · STOP"));
    return juce::roundToInt (w) + 2;
}

juce::String NewspeechDatafield::liveLine() const
{
    const double sr = proc.getSampleRate();
    const int    bs = proc.getBlockSize();

    juce::String s;
    s << (sr > 0.0 ? juce::String (sr / 1000.0, 1) + "KHZ" : juce::String ("--.-KHZ"));
    s << " · " << (bs > 0 ? juce::String (bs) : juce::String ("--"));

    if (telemetry != nullptr && telemetry->hasTransport.load())
    {
        const double bpm = telemetry->bpm.load();
        s << " · " << (bpm > 0.0 ? juce::String (bpm, 1) + "BPM" : juce::String ("--.-BPM"));
        s << " · " << (telemetry->playing.load() ? "RUN" : "STOP");
    }
    else
    {
        s << " · --.-BPM · ----";
    }
    return s;
}

void NewspeechDatafield::paint (juce::Graphics& g)
{
    auto r = getLocalBounds();
    g.setFont (dataFont());
    g.setColour (white (kTextAlpha));

    g.drawText (versionLine, r.removeFromTop (lineHeight), juce::Justification::centredRight, false);
    g.drawText (siteLine,    r.removeFromTop (lineHeight), juce::Justification::centredRight, false);
    g.drawText (liveLine(),  r.removeFromTop (lineHeight), juce::Justification::centredRight, false);
    r.removeFromTop (barcodeGap);

    // Barcode: a real Code 39 of "NEWSPEECH"; each bar's brightness follows the
    // recent output peak at its position (idle = text gray, peaks lift to white),
    // newest at the right edge like the Sequence scope.
    auto strip = r.removeFromTop (barcodeH).toFloat();
    const auto bars = barcodeBars ("NEWSPEECH", strip.getWidth());
    const int n = (int) bars.size();
    for (int i = 0; i < n; ++i)
    {
        const int slot = juce::jlimit (0, newspeech::Telemetry::bars - 1,
                                       juce::roundToInt ((float) i / (float) juce::jmax (1, n - 1)
                                                         * (float) (newspeech::Telemetry::bars - 1)));
        const float level = telemetry != nullptr ? juce::jlimit (0.0f, 1.0f, telemetry->peakAt (slot)) : 0.0f;
        g.setColour (white (kBarFloor + level * (0.9f - kBarFloor)));
        g.fillRect (strip.getX() + bars[(size_t) i].x, strip.getY(), bars[(size_t) i].w, strip.getHeight());
    }
}
