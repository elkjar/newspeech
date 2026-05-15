#include "SaturatorEditor.h"
#include "NewspeechColors.h"
#include "BinaryData.h"

using namespace newspeech::colors;

namespace {
    // Dimensions copied from GlitchEditor — LOOP row carries 6 controls,
    // same as TAPE there, so the ring-end alignment math holds:
    //   ring-end = labelGutter + 5*(cell+gap) + 18 + 44
    //            = 22 + 5*86 + 18 + 44 = 514
    //   content  = 514
    //   editor   = content + 2*inner + 2*outer = 514 + 48 + 64 = 626
    constexpr int kEditorW    = 626;
    constexpr int kEditorH    = 520;
    constexpr int kOuterPad   = 32;
    constexpr int kCornerR    = 14;
    constexpr int kInnerPad   = 24;
    constexpr int kHeaderH    = 28;
    constexpr int kPostHeader = 16;
    constexpr int kPanelH     = 80;
    constexpr int kGapY       = 18;
}

SaturatorEditor::SaturatorEditor (juce::AudioProcessor& proc)
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

    // Param names are the full slash-path Faust emits. With "[N]SECTION/[N]label"
    // syntax (no vgroup wrappers), Faust passes the entire "SECTION/label"
    // string as the literal slider label rather than expanding it into a
    // vgroup hierarchy — so getName(256) returns e.g. "LOOP/threshold", not
    // "threshold". Matching the bare leaf name routes every control to the
    // fallback param and makes them all move together.
    loopEnable    = mkT ("LOOP/glitch",    "ENABLE");
    loopThreshold = mk  ("LOOP/threshold", "THRESHOLD");
    loopChance    = mk  ("LOOP/chance",    "CHANCE");
    loopWindow    = mk  ("LOOP/window",    "WINDOW");
    loopAuto      = mkT ("LOOP/auto",      "AUTO");
    loopDivision  = mk  ("LOOP/division",  "DIVISION");

    destroyTilt  = mk ("DESTROY/tilt",  "TILT");
    destroyBias  = mk ("DESTROY/bias",  "BIAS");
    destroyDrive = mk ("DESTROY/drive", "DRIVE");

    filterTone = mk ("FILTER/tone", "TONE");
    filterBody = mk ("FILTER/body", "BODY");

    outTrim = mk ("OUT/output", "TRIM");
    outMix  = mk ("OUT/mix",    "MIX");

    loopPanel.addControl (loopEnable.get());
    loopPanel.addControl (loopThreshold.get());
    loopPanel.addControl (loopChance.get());
    loopPanel.addControl (loopWindow.get());
    loopPanel.addControl (loopAuto.get());
    loopPanel.addControl (loopDivision.get());

    destroyPanel.addControl (destroyTilt.get());
    destroyPanel.addControl (destroyBias.get());
    destroyPanel.addControl (destroyDrive.get());

    filterPanel.addControl (filterTone.get());
    filterPanel.addControl (filterBody.get());

    outPanel.addControl (outTrim.get());
    outPanel.addControl (outMix.get());

    addAndMakeVisible (loopPanel);
    addAndMakeVisible (destroyPanel);
    addAndMakeVisible (filterPanel);
    addAndMakeVisible (outPanel);

    setSize (kEditorW, kEditorH);
}

SaturatorEditor::~SaturatorEditor()
{
    setLookAndFeel (nullptr);
}

void SaturatorEditor::paint (juce::Graphics& g)
{
    g.fillAll (ink);

    auto outer = getLocalBounds().toFloat().reduced ((float) kOuterPad);

    g.setColour (border);
    g.drawRoundedRectangle (outer.reduced (0.5f), (float) kCornerR, 1.0f);

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
    g.drawText ("SATURATOR", sep.withTrimmedLeft (sepWidth), juce::Justification::centredLeft, false);

    if (micrographic.isValid())
    {
        constexpr float kMicroW = 154.5f;
        constexpr float kMicroH = 48.0f;
        auto innerArea = getLocalBounds().toFloat()
                                         .reduced ((float) kOuterPad)
                                         .reduced ((float) kInnerPad);
        const juce::Rectangle<float> dest (innerArea.getRight() - kMicroW,
                                           innerArea.getBottom() - kMicroH,
                                           kMicroW, kMicroH);
        g.drawImage (micrographic, dest);
    }
}

void SaturatorEditor::resized()
{
    auto bounds = getLocalBounds().reduced (kOuterPad).reduced (kInnerPad);
    bounds.removeFromTop (kHeaderH);
    bounds.removeFromTop (kPostHeader);

    loopPanel   .setBounds (bounds.removeFromTop (kPanelH));
    bounds.removeFromTop (kGapY);
    destroyPanel.setBounds (bounds.removeFromTop (kPanelH));
    bounds.removeFromTop (kGapY);
    filterPanel .setBounds (bounds.removeFromTop (kPanelH));
    bounds.removeFromTop (kGapY);
    outPanel    .setBounds (bounds.removeFromTop (kPanelH));
}

juce::RangedAudioParameter& SaturatorEditor::paramByName (const juce::String& faustLabel)
{
    for (auto* p : processor.getParameters())
    {
        if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p))
            if (r->getName (256) == faustLabel)
                return *r;
    }
    DBG ("SaturatorEditor: no param named '" << faustLabel << "'. Available:");
    for (auto* p : processor.getParameters())
        if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p))
            DBG ("  name='" << r->getName (256) << "' id='" << r->getParameterID() << "'");
    jassertfalse;
    static juce::AudioParameterFloat fallback { "fallback", "fallback", 0.0f, 1.0f, 0.0f };
    return fallback;
}
