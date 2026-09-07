#pragma once

#include <JuceHeader.h>
#include "NewspeechEditor.h"
#include "NewspeechKnob.h"
#include "NewspeechToggle.h"
#include "NewspeechSegment.h"
#include "NewspeechTextField.h"
#include "NewspeechButton.h"
#include "GlitchProcessor.h"
#include "GlitchLaneGrid.h"

// A 28px control (text field, button) sitting in a knob cell with the label below.
class GlitchCell : public juce::Component
{
public:
    GlitchCell (juce::Component& child, const juce::String& label, int childWidth);
    void resized() override;
    int preferredWidth() const noexcept { return childW; }
private:
    juce::Component& child;
    juce::Label label;
    int childW;
};

// PATTERN box hosting the lane grid.
class GlitchPatternPanel : public NewspeechSectionPanel
{
public:
    explicit GlitchPatternPanel (GlitchLaneGrid& grid);
    void resized() override;
    static constexpr int totalHeightPattern = lineY + pad + GlitchLaneGrid::totalHeight + pad + 1;
private:
    GlitchLaneGrid& grid;
};

// GLITCH editor. Rows:
//   CLOCK · SEED
//   PATTERN (lane grid)
//   <STAGE> — the selected lane's stage knobs + switches
//   LANE (mutate · lo · hi · mix) · BLOCK (accumulator · → all)
//   OUT                                          [datafield]
// Knobs edit the selected block's own settings, or the lane's defaults (for
// the next drawn block) when no block is selected — the page's model.
class GlitchEditor : public NewspeechEditor,
                     private juce::Timer
{
public:
    explicit GlitchEditor (GlitchProcessor&);
    ~GlitchEditor() override;

private:
    void layoutContent (juce::Rectangle<int> content) override;
    void timerCallback() override;
    void buildStagePanels();
    void select (int lane, int blockId);
    void refreshControls();
    glitch::Block* selectedBlock();
    glitch::Vals& editVals();
    void edited();
    void applyToAll();
    static void dim (juce::Component&, bool dimmed);
    bool liveIsDrifted() const;

    GlitchProcessor& proc;

    // CLOCK · SEED
    NewspeechSectionPanel clockPanel { "CLOCK" };
    std::unique_ptr<NewspeechToggle> sync;
    std::unique_ptr<NewspeechKnob> bpm;
    std::unique_ptr<NewspeechSegment> barsSeg, gridSeg;
    NewspeechSectionPanel seedPanel { "SEED" };
    NewspeechTextField seedField;
    NewspeechButton reseedButton { "RESEED" }, resetButton { "RESET" }, allButton { juce::String (juce::CharPointer_UTF8 ("\xe2\x86\x92 ALL")) };
    std::unique_ptr<GlitchCell> seedCell, reseedCell, resetCell, allCell;
    std::unique_ptr<NewspeechToggle> autoSeed;

    // PATTERN
    GlitchLaneGrid grid;
    GlitchPatternPanel patternPanel { grid };

    // STAGE (one per stage, one visible)
    std::array<std::unique_ptr<NewspeechSectionPanel>, glitch::numStages> stagePanels;
    std::array<std::vector<std::unique_ptr<NewspeechKnob>>, glitch::numStages> stageKnobs;
    std::array<std::vector<std::unique_ptr<NewspeechSegment>>, glitch::numStages> stageSegs;

    // LANE · BLOCK
    NewspeechSectionPanel lanePanel { "LANE" };
    std::unique_ptr<NewspeechKnob> mutate, lo, hi, mix;
    NewspeechSectionPanel blockPanel { "BLOCK" };
    std::unique_ptr<NewspeechSegment> accSeg;
    std::unique_ptr<NewspeechKnob> accTarget, accStep, accRange;

    // OUT
    NewspeechSectionPanel outPanel { "OUT" };
    std::unique_ptr<NewspeechKnob> level;

    int selLane = 0, selBlock = -1;
    bool refreshing = false;
    glitch::LiveView liveView;
    int liveVersion = -1;
};
