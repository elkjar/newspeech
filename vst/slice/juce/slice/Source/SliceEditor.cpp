#include "SliceEditor.h"

SliceEditor::SliceEditor (SliceProcessor& p)
    : NewspeechEditor (p, "SLICE"), proc (p)
{
    auto mk  = [this] (const char* name, const juce::String& display) { return std::make_unique<NewspeechKnob>   (paramByName (name), display); };
    auto mkT = [this] (const char* name, const juce::String& display) { return std::make_unique<NewspeechToggle> (paramByName (name), display); };
    auto mkS = [this] (const char* name, const juce::String& display, juce::StringArray names)
    {
        return std::make_unique<NewspeechSegment> (paramByName (name), display, names);
    };

    // PATTERN
    patternSeg = mkS ("PATTERN/pattern", "PATTERN", { "MORSE", "BITS", "DATA" });
    dah    = mk ("PATTERN/dah",    "DAH");
    gap    = mk ("PATTERN/gap",    "GAP");
    letter = mk ("PATTERN/letter", "LETTER");
    word   = mk ("PATTERN/word",   "WORD");
    thresh = mk ("PATTERN/thresh", "THRESH");
    field.onTextChange = [this] { fieldChanged(); };
    field.onReturnKey  = [this] { field.giveAwayKeyboardFocus(); };
    restoreButton.onClick = [this] { proc.restorePattern(); };
    readout.setPass (&uiPass);
    strip.setPass (&uiPass);
    patternPanel = std::make_unique<SlicePatternPanel> (*patternSeg, field, restoreButton, readout, strip,
        std::initializer_list<juce::Component*> { dah.get(), gap.get(), letter.get(), word.get(), thresh.get() });

    // CLOCK
    bpm     = mk  ("CLOCK/bpm",  "BPM");
    rateSeg = mkS ("CLOCK/rate", "RATE", { "1/4", "1/8", "1/16", "1/32" });
    feelSeg = mkS ("CLOCK/feel", "FEEL", { "STRAIGHT", "TRIPLET", "DOTTED" });
    clockPanel.addControl (bpm.get());
    clockPanel.addControl (rateSeg.get(), rateSeg->preferredWidth());
    clockPanel.addControl (feelSeg.get(), feelSeg->preferredWidth());

    // SHAPE
    attack  = mk ("SHAPE/attack",  "ATTACK");
    release = mk ("SHAPE/release", "RELEASE");
    depth   = mk ("SHAPE/depth",   "DEPTH");
    level   = mk ("SHAPE/level",   "LEVEL");
    for (auto* c : { attack.get(), release.get(), depth.get(), level.get() }) shapePanel.addControl (c);

    // SOURCE
    sourceSeg = mkS ("SOURCE/source", "SOURCE", { "TONE", "INPUT" });
    waveSeg   = mkS ("SOURCE/wave",   "WAVE",   { "SIN", "TRI", "SQR", "SAW" });
    freq      = mk  ("SOURCE/freq",     "FREQ");
    dahPitch  = mk  ("SOURCE/dahpitch", juce::String (juce::CharPointer_UTF8 ("DAH\xc2\xb1")));
    dahPitch->setBipolar (true);
    sourcePanel.addControl (sourceSeg.get(), sourceSeg->preferredWidth());
    sourcePanel.addControl (waveSeg.get(), waveSeg->preferredWidth());
    sourcePanel.addControl (freq.get());
    sourcePanel.addControl (dahPitch.get());

    // CAPTURE
    modeSeg = mkS ("CAPTURE/mode",   "MODE", { "GATE", "CHOP", "SCAN" });
    freeze  = mkT ("CAPTURE/freeze", "FREEZE");
    speed   = mk  ("CAPTURE/speed",  "SPEED");
    capturePanel.addControl (modeSeg.get(), modeSeg->preferredWidth());
    capturePanel.addControl (freeze.get());
    capturePanel.addControl (speed.get());

    // MANGLE
    flip     = mk  ("MANGLE/flip",     "FLIP");
    ratchet  = mk  ("MANGLE/ratchet",  "RATCHET");
    drop     = mk  ("MANGLE/drop",     "DROP");
    scramble = mk  ("MANGLE/scramble", "SCRAMBLE");
    decay    = mkT ("MANGLE/decay",    "DECAY");
    for (auto* c : std::initializer_list<juce::Component*> { flip.get(), ratchet.get(), drop.get(), scramble.get(), decay.get() })
        manglePanel.addControl (c);

    for (auto* p : std::initializer_list<juce::Component*> { patternPanel.get(), &clockPanel, &shapePanel, &sourcePanel, &capturePanel, &manglePanel })
        addAndMakeVisible (p);

    const int contentW = juce::jmax (rowWidth ({ &clockPanel, &shapePanel }),
                                     rowWidth ({ &sourcePanel, &capturePanel }),
                                     manglePanel.preferredWidth());
    setContentSize (contentW, SlicePatternPanel::totalHeightPattern + 3 * (rowGap + rowH));

    syncField (true);
    timerCallback();
    startTimerHz (30);
}

SliceEditor::~SliceEditor()
{
    stopTimer();
}

void SliceEditor::layoutContent (juce::Rectangle<int> c)
{
    patternPanel->setBounds (c.removeFromTop (SlicePatternPanel::totalHeightPattern));
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &clockPanel, &shapePanel });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &sourcePanel, &capturePanel });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &manglePanel });
}

void SliceEditor::dim (juce::Component& c, bool dimmed)
{
    c.setEnabled (! dimmed);
    c.setAlpha (dimmed ? 0.3f : 1.0f);
}

// Text modes share one field; DATA keeps its own — switching swaps the content.
void SliceEditor::syncField (bool force)
{
    const int pat = patternSeg->selectedIndex();
    if (! force && pat == shownPattern) return;
    shownPattern = pat;
    const bool data = pat == 2;
    suppressFieldCallback = true;
    field.setText (proc.getInputText (data), false);
    suppressFieldCallback = false;
    field.setPlaceholder (data ? "paste numbers — comma or space separated"
                        : pat == 1 ? "type a message — each character plays as its bits"
                                   : "type a message");
}

void SliceEditor::fieldChanged()
{
    if (suppressFieldCallback) return;
    proc.setInputText (field.getText(), shownPattern == 2);
}

void SliceEditor::timerCallback()
{
    auto& eng = proc.engine();
    syncField (false);

    const bool passChanged = eng.copyUiPass (uiPass, uiVersion);

    const double total = eng.uiTotal();
    const double pos = eng.uiBeat() - eng.uiPassStart();
    const bool has = eng.uiHasPattern();
    const double phase = total > 0.0 ? pos / total : -1.0;
    strip.setPosition (phase, total, eng.uiBpm(), has);

    // which character is sounding right now
    int lit = -1;
    if (has)
        for (int i = 0; i < uiPass.pass.count; ++i)
        {
            const auto& ev = uiPass.pass.events[(size_t) i];
            if (! ev.dropped && pos >= ev.t && pos < ev.t + ev.dur) { lit = ev.ci; break; }
            if (ev.t > pos) break;
        }
    readout.setLit (lit);
    readout.setThreshold (proc.apvts.getRawParameterValue ("thresh")->load());
    if (passChanged) readout.repaint();

    // dimming follows the page: what the current pattern / source can't use
    const int pat  = patternSeg->selectedIndex();
    const bool tone = sourceSeg->selectedIndex() == 0;
    const int mode = modeSeg->selectedIndex();
    dim (*dah,    pat != 0);
    dim (*gap,    pat != 0);
    dim (*letter, pat == 2);
    dim (*word,   pat == 2);
    dim (*thresh, pat != 2);
    dim (*freq,    ! tone);
    dim (*waveSeg, ! tone);
    dim (capturePanel, tone);
    dim (*depth, ! tone && mode != 0);
    // host tempo wins while a transport is attached; the knob is the standalone clock
    dim (*bpm, proc.hostBpm() > 0.0);
}
