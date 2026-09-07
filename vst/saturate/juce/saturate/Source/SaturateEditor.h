#pragma once

#include <JuceHeader.h>
#include "NewspeechEditor.h"
#include "NewspeechKnob.h"
#include "NewspeechToggle.h"

class SaturateEditor : public NewspeechEditor
{
public:
    explicit SaturateEditor (juce::AudioProcessor& proc);

private:
    void layoutContent (juce::Rectangle<int> content) override;

    NewspeechSectionPanel loopPanel    { "LOOP"    };
    NewspeechSectionPanel destroyPanel { "DESTROY" };
    NewspeechSectionPanel filterPanel  { "FILTER"  };
    NewspeechSectionPanel outPanel     { "OUT"     };

    // LOOP (6): enable + threshold + chance + window + auto + division.
    std::unique_ptr<NewspeechToggle> loopEnable, loopAuto;
    std::unique_ptr<NewspeechKnob>   loopThreshold, loopChance, loopWindow, loopDivision;

    // DESTROY (3).
    std::unique_ptr<NewspeechKnob> destroyTilt, destroyBias, destroyDrive;

    // FILTER (2).
    std::unique_ptr<NewspeechKnob> filterTone, filterBody;

    // OUT (2): trim + mix.
    std::unique_ptr<NewspeechKnob> outTrim, outMix;
};
