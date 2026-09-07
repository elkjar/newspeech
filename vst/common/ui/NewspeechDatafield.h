#pragma once

#include <JuceHeader.h>
#include "NewspeechTelemetry.h"

// The bottom-right "datafield" — the micrographic mark, rebuilt from live
// elements. Three right-aligned mono lines and a barcode:
//   [NS-AE] V1.0.0
//   WWW.NEWSPEECHSOUND.COM
//   48.0KHZ · 512 · 120.0BPM · RUN      ← sample rate, block, host bpm, transport
//   ▌▌ ▌▌▌ ▌ ▌▌ …                        ← rolling output level, newest right
class NewspeechDatafield : public juce::Component,
                           private juce::Timer
{
public:
    explicit NewspeechDatafield (juce::AudioProcessor& processor);
    ~NewspeechDatafield() override;

    void paint (juce::Graphics&) override;

    int preferredWidth() const;

    static constexpr int lineHeight  = 13;
    static constexpr int barcodeGap  = 4;
    static constexpr int barcodeH    = 14;
    static constexpr int totalHeight = 3 * lineHeight + barcodeGap + barcodeH;

private:
    void timerCallback() override { repaint(); }
    juce::String liveLine() const;

    juce::AudioProcessor& proc;
    newspeech::Telemetry* telemetry = nullptr;   // null when the processor has no hook
    juce::String versionLine, siteLine;
};
