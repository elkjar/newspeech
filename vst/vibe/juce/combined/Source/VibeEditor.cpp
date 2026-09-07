#include "VibeEditor.h"

VibeEditor::VibeEditor (juce::AudioProcessor& proc)
    : NewspeechEditor (proc, "VIBE")
{
    auto mk = [this] (const juce::String& faustLabel, const juce::String& display)
    {
        return std::make_unique<NewspeechKnob> (paramByName (faustLabel), display);
    };
    auto mkT = [this] (const juce::String& faustLabel, const juce::String& display)
    {
        return std::make_unique<NewspeechToggle> (paramByName (faustLabel), display);
    };

    position  = mk  ("position",  "POSITION");
    length_   = mk  ("length",    "LENGTH");
    hold      = mkT ("hold",      "HOLD");
    grainRate = mk  ("grainRate", "GRAIN RATE");
    grainMix  = mk  ("grainMix",  "GRAIN MIX");
    tapeMix   = mk  ("tape mix",  "MIX");

    repeatChance = mk ("chance",     "CHANCE");
    repeatMix    = mk ("repeat mix", "MIX");

    reverbDamping   = mk ("damping",    "DAMPING");
    reverbDiffusion = mk ("diffusion",  "DIFFUSION");
    reverbSize      = mk ("size",       "SIZE");
    reverbMix       = mk ("reverb mix", "MIX");

    trim = mk ("gain", "TRIM");

    for (auto* c : std::initializer_list<juce::Component*> { position.get(), length_.get(), hold.get(),
                     grainRate.get(), grainMix.get(), tapeMix.get() })
        tapePanel.addControl (c);

    repeatPanel.addControl (repeatChance.get());
    repeatPanel.addControl (repeatMix.get());

    for (auto* c : std::initializer_list<juce::Component*> { reverbDamping.get(), reverbDiffusion.get(), reverbSize.get(), reverbMix.get() })
        reverbPanel.addControl (c);

    outPanel.addControl (trim.get());

    for (auto* p : { &tapePanel, &repeatPanel, &reverbPanel, &outPanel })
        addAndMakeVisible (p);

    // Three rows: TAPE · REPEAT | REVERB · OUT (with the mark to its right).
    const int contentW = juce::jmax (tapePanel.preferredWidth(),
                                       rowWidth ({ &repeatPanel, &reverbPanel }),
                                       outPanel.preferredWidth());
    setContentSize (contentW, 3 * rowH + 2 * rowGap);
}

void VibeEditor::layoutContent (juce::Rectangle<int> c)
{
    placeRow (c.removeFromTop (rowH), { &tapePanel });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &repeatPanel, &reverbPanel });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &outPanel });
}
