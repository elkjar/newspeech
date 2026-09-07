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
    sync    = mkT ("CLOCK/sync", "SYNC");
    bpm     = mk  ("CLOCK/bpm",  "BPM");
    rateSeg = mkS ("CLOCK/rate", "RATE", { "1/4", "1/8", "1/16", "1/32" });
    feelSeg = mkS ("CLOCK/feel", "FEEL", { "STRAIGHT", "TRIPLET", "DOTTED" });
    clockPanel.addControl (sync.get());
    clockPanel.addControl (bpm.get());
    clockPanel.addWideControl (rateSeg.get(), rateSeg->preferredWidth());
    clockPanel.addWideControl (feelSeg.get(), feelSeg->preferredWidth());

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
    sourcePanel.addWideControl (sourceSeg.get(), sourceSeg->preferredWidth());
    sourcePanel.addWideControl (waveSeg.get(), waveSeg->preferredWidth());
    sourcePanel.addControl (freq.get());
    sourcePanel.addControl (dahPitch.get());

    // CAPTURE
    modeSeg = mkS ("CAPTURE/mode",   "MODE", { "GATE", "CHOP", "SCAN" });
    freeze  = mkT ("CAPTURE/freeze", "FREEZE");
    speed   = mk  ("CAPTURE/speed",  "SPEED");
    capturePanel.addWideControl (modeSeg.get(), modeSeg->preferredWidth());
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

// The pattern as typed, built on the message thread from the same code the
// engine runs — shown whenever the host isn't calling processBlock.
void SliceEditor::updatePreview (double bpm)
{
    auto raw = [this] (const char* id) { return proc.apvts.getRawParameterValue (id)->load(); };
    static constexpr double DIVS[4]  = { 1.0, 0.5, 0.25, 0.125 };
    static constexpr double FEELS[3] = { 1.0, 2.0 / 3.0, 1.5 };
    slice::Params P;
    P.pattern   = (slice::Pattern) juce::jlimit (0, 2, (int) std::lround (raw ("pattern")));
    P.unitBeats = DIVS[juce::jlimit (0, 3, (int) std::lround (raw ("rate")))] * FEELS[juce::jlimit (0, 2, (int) std::lround (raw ("feel")))];
    P.bpm = bpm;
    P.dah = raw ("dah"); P.gap = raw ("gap"); P.letter = raw ("letter"); P.word = raw ("word"); P.thresh = raw ("thresh");

    const bool data = P.pattern == slice::Pattern::data;
    const juce::String text = proc.getInputText (data);
    juce::String key;
    key << (int) P.pattern << '|' << P.unitBeats << '|' << P.dah << ',' << P.gap << ',' << P.letter << ',' << P.word << ',' << P.thresh << '|' << text;
    if (key == previewKey && showingPreview) return;
    previewKey = key;

    if (data) slice::parseSeries (text.toRawUTF8(), previewPass.origSeries);
    else      slice::parseMessage (text.toRawUTF8(), previewPass.origMsg);
    previewPass.curMsg = previewPass.origMsg;
    previewPass.curSeries = previewPass.origSeries;
    previewPass.pattern = P.pattern;
    juce::Random rng (1);
    slice::buildPass (P, previewPass.curMsg, previewPass.curSeries, rng, previewPass.pass);
    readout.repaint();
}

void SliceEditor::timerCallback()
{
    auto& eng = proc.engine();
    syncField (false);

    // A host that restored state after the editor opened, or a change from
    // elsewhere: follow it while the field isn't being typed into.
    if (! field.hasKeyboardFocus (true))
    {
        const auto want = proc.getInputText (shownPattern == 2);
        if (field.getText() != want)
        {
            suppressFieldCallback = true;
            field.setText (want, false);
            suppressFieldCallback = false;
        }
    }

    const bool running = proc.audioRunning();
    const double clockBpm = proc.hostBpm() > 0.0 ? proc.hostBpm() : proc.apvts.getRawParameterValue ("bpm")->load();
    int lit = -1;
    if (! running)
    {
        updatePreview (clockBpm);
        if (! showingPreview) { showingPreview = true; readout.setPass (&previewPass); strip.setPass (&previewPass); readout.repaint(); }
        strip.setPosition (-1.0, previewPass.pass.total, clockBpm, false);
    }
    else
    {
        const bool passChanged = eng.copyUiPass (uiPass, uiVersion);
        if (showingPreview) { showingPreview = false; readout.setPass (&uiPass); strip.setPass (&uiPass); readout.repaint(); }

        const double total = eng.uiTotal();
        const double pos = eng.uiBeat() - eng.uiPassStart();
        const bool has = eng.uiHasPattern();
        const double phase = total > 0.0 ? pos / total : -1.0;
        strip.setPosition (phase, total, eng.uiBpm(), has);

        // which character is sounding right now
        if (has)
            for (int i = 0; i < uiPass.pass.count; ++i)
            {
                const auto& ev = uiPass.pass.events[(size_t) i];
                if (! ev.dropped && pos >= ev.t && pos < ev.t + ev.dur) { lit = ev.ci; break; }
                if (ev.t > pos) break;
            }
        if (passChanged) readout.repaint();
    }
    readout.setLit (lit);
    readout.setThreshold (proc.apvts.getRawParameterValue ("thresh")->load());

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
    // FREEZE and SPEED act on the captured loop — CHOP/SCAN only
    dim (*freeze, mode == 0);
    dim (*speed,  mode == 0);
    dim (*depth, ! tone && mode != 0);
    // SYNC on with a host tempo: the knob has nothing to do; SYNC off: it is the clock
    dim (*bpm, proc.hostBpm() > 0.0);
}
