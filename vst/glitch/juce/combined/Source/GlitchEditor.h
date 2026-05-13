#pragma once

#include <JuceHeader.h>
#include "NewspeechLookAndFeel.h"
#include "NewspeechKnob.h"
#include "NewspeechToggle.h"
#include "NewspeechSectionPanel.h"

class GlitchEditor : public juce::AudioProcessorEditor
{
public:
    explicit GlitchEditor (juce::AudioProcessor& proc);
    ~GlitchEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    juce::RangedAudioParameter& paramByName (const juce::String& faustLabel);

    NewspeechLookAndFeel laf;

    NewspeechSectionPanel tapePanel   { "TAPE"   };
    NewspeechSectionPanel glitchPanel { "GLITCH" };
    NewspeechSectionPanel reverbPanel { "REVERB" };
    NewspeechSectionPanel gainPanel   { "GAIN"   };

    // TAPE controls (6 — REVERSE removed).
    std::unique_ptr<NewspeechKnob>   position, length_, grainRate, grainMix, tapeMix;
    std::unique_ptr<NewspeechToggle> hold;

    // GLITCH controls (2).
    std::unique_ptr<NewspeechKnob> glitchChance, glitchMix;

    // REVERB controls (4).
    std::unique_ptr<NewspeechKnob> reverbDamping, reverbDiffusion, reverbSize, reverbMix;

    // GAIN (1).
    std::unique_ptr<NewspeechKnob> trim;

    juce::Image micrographic;
};
