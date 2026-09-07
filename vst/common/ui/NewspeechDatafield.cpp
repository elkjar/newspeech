#include "NewspeechDatafield.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

namespace {
    constexpr float kTextAlpha = 0.45f;
    const juce::Font& dataFont()
    {
        static const juce::Font f = monoFont (type::label, type::labelTracking);
        return f;
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

    // Barcode: one bar per recent block, brightness = output peak (the ping-LED
    // mapping, 0.12 floor). Newest at the right edge, like the Sequence scope.
    auto strip = r.removeFromTop (barcodeH).toFloat();
    const int n = newspeech::Telemetry::bars;
    const float colW = strip.getWidth() / (float) n;
    const float barW = juce::jmax (1.0f, std::floor (colW * 0.6f));
    for (int i = 0; i < n; ++i)
    {
        const float level = telemetry != nullptr ? juce::jlimit (0.0f, 1.0f, telemetry->peakAt (i)) : 0.0f;
        g.setColour (white (0.12f + level * 0.88f));
        g.fillRect (strip.getX() + i * colW + (colW - barW), strip.getY(), barW, strip.getHeight());
    }
}
