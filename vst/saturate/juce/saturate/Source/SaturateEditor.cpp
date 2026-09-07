#include "SaturateEditor.h"

SaturateEditor::SaturateEditor (juce::AudioProcessor& proc)
    : NewspeechEditor (proc, "SATURATE")
{
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
    // string as the literal slider label — so getName(256) returns e.g.
    // "LOOP/threshold", not "threshold".
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

    for (auto* c : std::initializer_list<juce::Component*> { loopEnable.get(), loopThreshold.get(), loopChance.get(),
                     loopWindow.get(), loopAuto.get(), loopDivision.get() })
        loopPanel.addControl (c);

    for (auto* c : std::initializer_list<juce::Component*> { destroyTilt.get(), destroyBias.get(), destroyDrive.get() })
        destroyPanel.addControl (c);

    filterPanel.addControl (filterTone.get());
    filterPanel.addControl (filterBody.get());

    outPanel.addControl (outTrim.get());
    outPanel.addControl (outMix.get());

    for (auto* p : { &loopPanel, &destroyPanel, &filterPanel, &outPanel })
        addAndMakeVisible (p);

    // Three rows: LOOP · DESTROY | FILTER · OUT (with the mark to its right).
    const int contentW = juce::jmax (loopPanel.preferredWidth(),
                                       rowWidth ({ &destroyPanel, &filterPanel }),
                                       outPanel.preferredWidth());
    setContentSize (contentW, 3 * rowH + 2 * rowGap);
}

void SaturateEditor::layoutContent (juce::Rectangle<int> c)
{
    placeRow (c.removeFromTop (rowH), { &loopPanel });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &destroyPanel, &filterPanel });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &outPanel });
}
