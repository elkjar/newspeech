#include "GlitchEditor.h"
#include "NewspeechColors.h"
#include "BinaryData.h"

using namespace newspeech::colors;

namespace {
    // Width chosen so the MIX knob's RING (not its cell) right-edge sits
    // flush with the inner-padding right edge — and therefore lines up with
    // the micrographic's right edge in the bottom corner. The ring is 44px
    // wide and centred in its 80px cell, so the cell extends 18px past the
    // ring on each side; that 18px of trailing empty cell-space falls
    // outside the inner content area and gets clipped (it's blank anyway).
    //   ring-end = labelGutter + 5*(cell+gap) + 18 + 44
    //            = 22 + 5*86 + 18 + 44 = 514
    //   content  = 514
    //   editor   = content + 2*inner + 2*outer = 514 + 48 + 64 = 626
    constexpr int kEditorW    = 626;
    constexpr int kEditorH    = 520;
    constexpr int kOuterPad   = 32;   // black bg padding around main container
    constexpr int kCornerR    = 14;
    constexpr int kInnerPad   = 24;   // main container internal padding
    constexpr int kHeaderH    = 28;
    constexpr int kPostHeader = 16;
    constexpr int kPanelH     = 80;
    constexpr int kGapY       = 18;
}

GlitchEditor::GlitchEditor (juce::AudioProcessor& proc)
    : juce::AudioProcessorEditor (proc)
{
    setLookAndFeel (&laf);

    micrographic = juce::ImageCache::getFromMemory (BinaryData::micrographic_png,
                                                    BinaryData::micrographic_pngSize);

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

    glitchChance = mk ("chance",     "CHANCE");
    glitchMix    = mk ("glitch mix", "MIX");

    reverbDamping   = mk ("damping",    "DAMPING");
    reverbDiffusion = mk ("diffusion",  "DIFFUSION");
    reverbSize      = mk ("size",       "SIZE");
    reverbMix       = mk ("reverb mix", "MIX");

    trim         = mk ("gain",       "TRIM");

    tapePanel.addControl (position.get());
    tapePanel.addControl (length_.get());
    tapePanel.addControl (hold.get());
    tapePanel.addControl (grainRate.get());
    tapePanel.addControl (grainMix.get());
    tapePanel.addControl (tapeMix.get());

    glitchPanel.addControl (glitchChance.get());
    glitchPanel.addControl (glitchMix.get());

    reverbPanel.addControl (reverbDamping.get());
    reverbPanel.addControl (reverbDiffusion.get());
    reverbPanel.addControl (reverbSize.get());
    reverbPanel.addControl (reverbMix.get());

    gainPanel.addControl (trim.get());

    addAndMakeVisible (tapePanel);
    addAndMakeVisible (reverbPanel);
    addAndMakeVisible (glitchPanel);
    addAndMakeVisible (gainPanel);

    // setSize last — triggers the layout cascade with all children wired up.
    setSize (kEditorW, kEditorH);
}

GlitchEditor::~GlitchEditor()
{
    setLookAndFeel (nullptr);
}

void GlitchEditor::paint (juce::Graphics& g)
{
    g.fillAll (ink);

    auto outer = getLocalBounds().toFloat().reduced ((float) kOuterPad);

    // Main container: 1px solid #1E1E1E rounded rect wrapping the controls.
    g.setColour (border);
    g.drawRoundedRectangle (outer.reduced (0.5f), (float) kCornerR, 1.0f);

    // Header strip inside the main container: "NEW SPEECH │ GLITCH"
    auto inner = outer.reduced ((float) kInnerPad);
    auto header = inner.removeFromTop ((float) kHeaderH);
    g.setFont (monoFont (12.0f, 0.12f));

    g.setColour (white (alpha::crumb));
    g.drawText ("NEW SPEECH", header, juce::Justification::centredLeft, false);

    const auto nsWidth = g.getCurrentFont().getStringWidthFloat ("NEW SPEECH ");
    auto sep = header.withTrimmedLeft (nsWidth);

    g.setColour (white (alpha::hover));
    g.drawText ("|", sep, juce::Justification::centredLeft, false);

    const auto sepWidth = g.getCurrentFont().getStringWidthFloat ("| ");
    g.setColour (white (alpha::crumb));
    g.drawText ("GLITCH", sep.withTrimmedLeft (sepWidth), juce::Justification::centredLeft, false);

    // Branding micrographic — bottom-right inside the main container.
    // Asset is 309×96 @2x; drawn at 155×48 logical so it stays crisp on Retina.
    if (micrographic.isValid())
    {
        constexpr float kMicroW = 154.5f;  // half of 309
        constexpr float kMicroH = 48.0f;   // half of 96
        auto innerArea = getLocalBounds().toFloat()
                                         .reduced ((float) kOuterPad)
                                         .reduced ((float) kInnerPad);
        const juce::Rectangle<float> dest (innerArea.getRight() - kMicroW,
                                           innerArea.getBottom() - kMicroH,
                                           kMicroW, kMicroH);
        g.drawImage (micrographic, dest);
    }
}

void GlitchEditor::resized()
{
    auto bounds = getLocalBounds().reduced (kOuterPad).reduced (kInnerPad);
    bounds.removeFromTop (kHeaderH);
    bounds.removeFromTop (kPostHeader);

    // One row per effect, full inner width each. Same layout math throughout —
    // every row is left-aligned with the default control gap.
    tapePanel  .setBounds (bounds.removeFromTop (kPanelH));
    bounds.removeFromTop (kGapY);
    reverbPanel.setBounds (bounds.removeFromTop (kPanelH));
    bounds.removeFromTop (kGapY);
    glitchPanel.setBounds (bounds.removeFromTop (kPanelH));
    bounds.removeFromTop (kGapY);
    gainPanel  .setBounds (bounds.removeFromTop (kPanelH));
}

juce::RangedAudioParameter& GlitchEditor::paramByName (const juce::String& faustLabel)
{
    for (auto* p : processor.getParameters())
    {
        if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p))
            if (r->getName (256) == faustLabel)
                return *r;
    }
    DBG ("GlitchEditor: no param named '" << faustLabel << "'. Available:");
    for (auto* p : processor.getParameters())
        if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p))
            DBG ("  name='" << r->getName (256) << "' id='" << r->getParameterID() << "'");
    jassertfalse;
    static juce::AudioParameterFloat fallback { "fallback", "fallback", 0.0f, 1.0f, 0.0f };
    return fallback;
}
