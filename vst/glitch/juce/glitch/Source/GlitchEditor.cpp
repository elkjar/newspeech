#include "GlitchEditor.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;
using namespace glitch;

// --- GlitchCell ---
GlitchCell::GlitchCell (juce::Component& c, const juce::String& text, int w) : child (c), childW (w)
{
    addAndMakeVisible (child);
    label.setText (text.toUpperCase(), juce::dontSendNotification);
    label.setFont (monoFont (type::label, type::labelTracking));
    label.setJustificationType (juce::Justification::centred);
    label.setColour (juce::Label::textColourId, white (alpha::label));
    label.setInterceptsMouseClicks (false, false);
    addAndMakeVisible (label);
}

void GlitchCell::resized()
{
    auto r = getLocalBounds();
    auto top = r.removeFromTop (NewspeechKnob::knobDiameter);
    child.setBounds (top.withSizeKeepingCentre (childW, NewspeechButton::height));
    r.removeFromTop (NewspeechKnob::labelGap);
    label.setBounds (r.removeFromTop (NewspeechKnob::labelHeight));
}

// --- GlitchPatternPanel ---
GlitchPatternPanel::GlitchPatternPanel (GlitchLaneGrid& g) : NewspeechSectionPanel ("PATTERN"), grid (g)
{
    addAndMakeVisible (grid);
}

void GlitchPatternPanel::resized()
{
    grid.setBounds (wideMargin, lineY + pad, getWidth() - 2 * wideMargin, GlitchLaneGrid::totalHeight);
}

// --- GlitchEditor ---
GlitchEditor::GlitchEditor (GlitchProcessor& p)
    : NewspeechEditor (p, "GLITCH"), proc (p), grid (p)
{
    auto mk  = [this] (const char* name, const juce::String& display) { return std::make_unique<NewspeechKnob>   (paramByName (name), display); };
    auto mkT = [this] (const char* name, const juce::String& display) { return std::make_unique<NewspeechToggle> (paramByName (name), display); };
    auto mkS = [this] (const char* name, const juce::String& display, juce::StringArray names) { return std::make_unique<NewspeechSegment> (paramByName (name), display, names); };

    // CLOCK
    sync    = mkT ("CLOCK/sync", "SYNC");
    bpm     = mk  ("CLOCK/bpm",  "BPM");
    barsSeg = mkS ("CLOCK/bars", "BARS", { "1", "2", "4", "8" });
    gridSeg = mkS ("CLOCK/grid", "GRID", { "1/8", "1/16", "1/32" });
    clockPanel.addControl (sync.get());
    clockPanel.addControl (bpm.get());
    clockPanel.addWideControl (barsSeg.get(), barsSeg->preferredWidth());
    clockPanel.addWideControl (gridSeg.get(), gridSeg->preferredWidth());

    // SEED — the seed populates the grid; RESEED rolls a new one; AUTO re-seeds
    // on every transport start; RESET = a fresh run (pass 0) with this seed.
    seedField.setPlaceholder ("6 hex");
    seedField.setText (proc.seed(), false);
    seedField.setJustification (juce::Justification::centred);
    auto commitSeed = [this]
    {
        proc.applySeed (seedField.getText().trim().toLowerCase());
        seedField.setText (proc.seed(), false);
        select (selLane, -1);
        grid.repaint();
    };
    seedField.onReturnKey = [this, commitSeed] { commitSeed(); seedField.giveAwayKeyboardFocus(); };
    seedField.onFocusLost = commitSeed;
    seedCell   = std::make_unique<GlitchCell> (seedField, "SEED", 96);
    reseedButton.onClick = [this] { proc.newSeed(); seedField.setText (proc.seed(), false); select (selLane, -1); grid.repaint(); };
    reseedCell = std::make_unique<GlitchCell> (reseedButton, "NEW", reseedButton.preferredWidth());
    autoSeed   = mkT ("SEED/auto", "AUTO");
    resetButton.onClick = [this] { proc.resetRun(); };
    resetCell  = std::make_unique<GlitchCell> (resetButton, "RUN", resetButton.preferredWidth());
    seedPanel.addWideControl (seedCell.get(), 96);
    seedPanel.addWideControl (reseedCell.get(), reseedButton.preferredWidth());
    seedPanel.addControl (autoSeed.get());
    seedPanel.addWideControl (resetCell.get(), resetButton.preferredWidth());

    // PATTERN
    grid.onSelect = [this] (int lane, int blockId) { select (lane, blockId); };
    grid.onEdit = [this] { proc.patternEdited(); if (! refreshing) refreshControls(); };

    // STAGE panels
    buildStagePanels();

    // LANE
    mutate = std::make_unique<NewspeechKnob> ("MUTATE");
    lo     = std::make_unique<NewspeechKnob> ("LO", scopeSpec (K_LO).steps);
    hi     = std::make_unique<NewspeechKnob> ("HI", scopeSpec (K_HI).steps);
    mix    = std::make_unique<NewspeechKnob> ("MIX");
    mutate->onChange = [this] (float v) { if (refreshing) return; proc.pattern().lanes[(size_t) selLane].mutate = v; edited(); };
    lo->onChange  = [this] (float v) { if (refreshing) return; editVals().k[K_LO] = v; edited(); };
    hi->onChange  = [this] (float v) { if (refreshing) return; editVals().k[K_HI] = v; edited(); };
    mix->onChange = [this] (float v) { if (refreshing) return; editVals().k[K_MIX] = v; edited(); };
    for (auto* c : std::initializer_list<juce::Component*> { mutate.get(), lo.get(), hi.get(), mix.get() }) lanePanel.addControl (c);

    // BLOCK — accumulator: each time this block fires it climbs one rung, then turns per shape
    accSeg    = std::make_unique<NewspeechSegment> ("ACC", juce::StringArray { "OFF", "WRAP", "BOUNCE", "HOLD" });
    accTarget = std::make_unique<NewspeechKnob> ("TARGET");
    accStep   = std::make_unique<NewspeechKnob> ("STEP", 9);
    accRange  = std::make_unique<NewspeechKnob> ("RANGE", 8);
    accStep->setBipolar (true);
    accSeg->onChange = [this] (int i) { if (refreshing) return; if (auto* b = selectedBlock()) { b->acc.shape = i; edited(); } };
    accTarget->onChange = [this] (float v)
    {
        if (refreshing) return;
        if (auto* b = selectedBlock())
        {
            const int n = numSlots (selLane);
            b->acc.target = juce::jlimit (0, n - 1, juce::roundToInt (v * (n - 1)));
            edited();
            refreshControls();
        }
    };
    accStep->onChange  = [this] (float v) { if (refreshing) return; if (auto* b = selectedBlock()) { b->acc.step = v; edited(); } };
    accRange->onChange = [this] (float v) { if (refreshing) return; if (auto* b = selectedBlock()) { b->acc.range = v; edited(); } };
    allButton.onClick = [this] { applyToAll(); };
    allCell = std::make_unique<GlitchCell> (allButton, "LANE", allButton.preferredWidth());
    blockPanel.addWideControl (accSeg.get(), accSeg->preferredWidth());
    blockPanel.addControl (accTarget.get());
    blockPanel.addControl (accStep.get());
    blockPanel.addControl (accRange.get());
    blockPanel.addWideControl (allCell.get(), allButton.preferredWidth());

    // OUT
    level = mk ("OUT/level", "LEVEL");
    outPanel.addControl (level.get());

    for (auto* c : std::initializer_list<juce::Component*> { &clockPanel, &seedPanel, &patternPanel, &lanePanel, &blockPanel, &outPanel })
        addAndMakeVisible (c);
    for (auto& sp : stagePanels) addChildComponent (sp.get());

    int stageW = 0;
    for (auto& sp : stagePanels) stageW = juce::jmax (stageW, sp->preferredWidth());
    const int contentW = juce::jmax (rowWidth ({ &clockPanel, &seedPanel }), stageW,
                                     rowWidth ({ &lanePanel, &blockPanel }), outPanel.preferredWidth());
    setContentSize (contentW, GlitchPatternPanel::totalHeightPattern + 4 * (rowGap + rowH));

    select (0, -1);
    startTimerHz (30);
}

GlitchEditor::~GlitchEditor()
{
    stopTimer();
}

void GlitchEditor::buildStagePanels()
{
    for (int s = 0; s < numStages; ++s)
    {
        const auto& st = stageSpec (s);
        stagePanels[(size_t) s] = std::make_unique<NewspeechSectionPanel> (st.name);
        auto& panel = *stagePanels[(size_t) s];
        for (int i = 0; i < st.numKnobs; ++i)
        {
            auto k = std::make_unique<NewspeechKnob> (st.knobs[i].label, st.knobs[i].steps);
            if (st.knobs[i].bipolar) k->setBipolar (true);
            const int slot = K_STAGE0 + i;
            k->onChange = [this, slot] (float v) { if (refreshing) return; editVals().k[(size_t) slot] = v; edited(); };
            panel.addControl (k.get());
            stageKnobs[(size_t) s].push_back (std::move (k));
        }
        for (int i = 0; i < st.numSegs; ++i)
        {
            juce::StringArray names;
            for (int o = 0; o < st.segs[i].count; ++o) names.add (st.segs[i].names[o]);
            auto seg = std::make_unique<NewspeechSegment> (st.segs[i].label, names);
            seg->onChange = [this, i] (int idx) { if (refreshing) return; editVals().seg[(size_t) i] = idx; edited(); refreshControls(); };
            panel.addWideControl (seg.get(), seg->preferredWidth());
            stageSegs[(size_t) s].push_back (std::move (seg));
        }
    }
}

void GlitchEditor::layoutContent (juce::Rectangle<int> c)
{
    placeRow (c.removeFromTop (rowH), { &clockPanel, &seedPanel });
    c.removeFromTop (rowGap);
    patternPanel.setBounds (c.removeFromTop (GlitchPatternPanel::totalHeightPattern));
    c.removeFromTop (rowGap);
    auto stageRow = c.removeFromTop (rowH);
    for (auto& sp : stagePanels) placeRow (stageRow, { sp.get() });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &lanePanel, &blockPanel });
    c.removeFromTop (rowGap);
    placeRow (c.removeFromTop (rowH), { &outPanel });
}

void GlitchEditor::dim (juce::Component& c, bool d)
{
    c.setEnabled (! d);
    c.setAlpha (d ? 0.3f : 1.0f);
}

Block* GlitchEditor::selectedBlock()
{
    if (selBlock < 0) return nullptr;
    auto& lane = proc.pattern().lanes[(size_t) selLane];
    for (int i = 0; i < lane.count; ++i) if (lane.blocks[(size_t) i].id == selBlock) return &lane.blocks[(size_t) i];
    return nullptr;
}

Vals& GlitchEditor::editVals()
{
    if (auto* b = selectedBlock()) return b->vals;
    return proc.pattern().lanes[(size_t) selLane].defaults;
}

void GlitchEditor::edited()
{
    proc.patternEdited();
    grid.repaint();
}

// copy this block's settings to every block in the lane, and to the lane defaults
void GlitchEditor::applyToAll()
{
    auto* b = selectedBlock();
    if (b == nullptr) return;
    auto& lane = proc.pattern().lanes[(size_t) selLane];
    const Vals v = b->vals; const Acc a = b->acc;
    lane.defaults = v;
    for (int i = 0; i < lane.count; ++i) { lane.blocks[(size_t) i].vals = v; lane.blocks[(size_t) i].acc = a; }
    edited();
}

void GlitchEditor::select (int lane, int blockId)
{
    selLane = juce::jlimit (0, numStages - 1, lane);
    selBlock = blockId;
    grid.setSelection (selLane, selBlock);
    for (int s = 0; s < numStages; ++s) stagePanels[(size_t) s]->setVisible (s == selLane);
    refreshControls();
}

void GlitchEditor::refreshControls()
{
    refreshing = true;
    auto& lane = proc.pattern().lanes[(size_t) selLane];
    auto* blk = selectedBlock();
    if (selBlock >= 0 && blk == nullptr) { selBlock = -1; grid.setSelection (selLane, -1); }
    const Vals& v = blk != nullptr ? blk->vals : lane.defaults;
    const auto& st = stageSpec (selLane);

    for (int i = 0; i < st.numKnobs; ++i) stageKnobs[(size_t) selLane][(size_t) i]->setValue (v.k[(size_t) (K_STAGE0 + i)]);
    for (int i = 0; i < st.numSegs; ++i) stageSegs[(size_t) selLane][(size_t) i]->setSelectedIndex (v.seg[(size_t) i]);
    // CHOP's threshold only matters in THRESH mode
    if (selLane == chop) dim (*stageKnobs[(size_t) chop][3], v.seg[0] != 1);

    mutate->setValue (lane.mutate);
    lo->setValue (v.k[K_LO]); hi->setValue (v.k[K_HI]); mix->setValue (v.k[K_MIX]);

    const bool hasBlock = blk != nullptr;
    dim (blockPanel, ! hasBlock);
    if (hasBlock)
    {
        const int n = numSlots (selLane);
        const int t = juce::jlimit (0, n - 1, blk->acc.target);
        accSeg->setSelectedIndex (blk->acc.shape);
        accTarget->setValue ((float) t / (float) (n - 1));
        accTarget->setLabel (juce::String (juce::CharPointer_UTF8 ("\xe2\x86\x92 ")) + slotSpec (selLane, t)->label);
        accStep->setValue (blk->acc.step);
        accRange->setValue (blk->acc.range);
        const bool off = blk->acc.shape == accOff;
        dim (*accTarget, off); dim (*accStep, off); dim (*accRange, off);
    }
    else accTarget->setLabel ("TARGET");
    refreshing = false;
}

bool GlitchEditor::liveIsDrifted() const
{
    const auto& p = proc.pattern();
    for (int s = 0; s < numStages; ++s)
    {
        const auto& al = p.lanes[(size_t) s];
        const auto& lv = liveView.lanes[(size_t) s];
        if (al.count != lv.count) return true;
        for (int i = 0; i < al.count; ++i)
            if (std::abs (lv.blocks[i].a - (double) al.blocks[(size_t) i].a / p.grid) > 1e-6
             || std::abs (lv.blocks[i].b - (double) al.blocks[(size_t) i].b / p.grid) > 1e-6) return true;
    }
    return false;
}

void GlitchEditor::timerCallback()
{
    proc.engine().copyLive (liveView, liveVersion);
    const bool drifted = proc.audioRunning() && liveVersion >= 0 && liveIsDrifted();
    grid.setLive (&liveView, drifted);
    grid.repaint();

    if (! seedField.hasKeyboardFocus (true) && seedField.getText() != proc.seed())
    {
        seedField.setText (proc.seed(), false);
        refreshControls();
    }
    if (selBlock >= 0 && selectedBlock() == nullptr) select (selLane, -1);

    dim (*bpm, proc.hostBpm() > 0.0);
}
