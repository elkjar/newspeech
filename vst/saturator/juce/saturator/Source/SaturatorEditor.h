#pragma once

#include <JuceHeader.h>
#include "NewspeechLookAndFeel.h"
#include "NewspeechKnob.h"
#include "NewspeechToggle.h"
#include "NewspeechSectionPanel.h"

class SaturatorEditor : public juce::AudioProcessorEditor
{
public:
    explicit SaturatorEditor (juce::AudioProcessor& proc);
    ~SaturatorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    juce::RangedAudioParameter& paramByName (const juce::String& faustLabel);

    NewspeechLookAndFeel laf;

    NewspeechSectionPanel loopPanel    { "LOOP"    };
    NewspeechSectionPanel destroyPanel { "DESTROY" };
    NewspeechSectionPanel filterPanel  { "FILTER"  };
    NewspeechSectionPanel outPanel     { "OUT"     };

    // LOOP (6): enable + threshold + chance + window + auto + division.
    std::unique_ptr<NewspeechToggle> loopEnable, loopAuto;
    std::unique_ptr<NewspeechKnob>   loopThreshold, loopChance, loopWindow, loopDivision;

    // DESTROY (3).
    std::unique_ptr<NewspeechKnob>   destroyTilt, destroyBias, destroyDrive;

    // FILTER (2).
    std::unique_ptr<NewspeechKnob>   filterTone, filterBody;

    // OUT (2): trim + mix.
    std::unique_ptr<NewspeechKnob>   outTrim, outMix;

    juce::Image micrographic;
};
