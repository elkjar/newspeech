#pragma once

#include <JuceHeader.h>
#include "NewspeechEditor.h"
#include "NewspeechKnob.h"
#include "NewspeechToggle.h"

class VibeEditor : public NewspeechEditor
{
public:
    explicit VibeEditor (juce::AudioProcessor& proc);

private:
    void layoutContent (juce::Rectangle<int> content) override;

    NewspeechSectionPanel tapePanel   { "TAPE"   };
    NewspeechSectionPanel repeatPanel { "REPEAT" };
    NewspeechSectionPanel reverbPanel { "REVERB" };
    NewspeechSectionPanel outPanel    { "OUT"    };

    // TAPE (6).
    std::unique_ptr<NewspeechKnob>   position, length_, grainRate, grainMix, tapeMix;
    std::unique_ptr<NewspeechToggle> hold;

    // REPEAT (2) — the tempo-synced beat repeat, diced by chance.
    std::unique_ptr<NewspeechKnob> repeatChance, repeatMix;

    // REVERB (4).
    std::unique_ptr<NewspeechKnob> reverbDamping, reverbDiffusion, reverbSize, reverbMix;

    // OUT (1).
    std::unique_ptr<NewspeechKnob> trim;
};
