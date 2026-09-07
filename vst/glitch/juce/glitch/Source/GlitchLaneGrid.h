#pragma once

#include <JuceHeader.h>
#include "GlitchProcessor.h"

// The lane timeline: six stage lanes over a grid of bars. Blocks are drawn,
// moved, resized (edges), split (double-click) and erased (right-click / alt).
// The dot before a lane name switches the lane; the name selects it. While
// the live pattern has drifted from the drawn one (MUTATE), the authored
// blocks drop to reduced weight and the live ones draw outlined on top; a
// touch adopts the live picture as authored first, so what you see is what
// you grab. Ported from glitch.html's lane canvas.
class GlitchLaneGrid : public juce::Component
{
public:
    explicit GlitchLaneGrid (GlitchProcessor&);

    std::function<void (int lane, int blockId)> onSelect;   // blockId −1 = lane only
    std::function<void()> onEdit;                            // the model changed

    void setSelection (int lane, int blockId) { selLane = lane; selBlock = blockId; repaint(); }
    int  selectedLane() const noexcept { return selLane; }
    int  selectedBlock() const noexcept { return selBlock; }
    void setLive (const glitch::LiveView* view, bool drifted) { live = view; liveDrifted = drifted; }

    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
    void mouseMove (const juce::MouseEvent&) override;

    static constexpr int labelW = 92;
    static constexpr int laneH  = 26;
    static constexpr int rulerH = 14;
    static constexpr int totalHeight = rulerH + glitch::numStages * laneH;

private:
    struct Hit { int lane = -1; double cellF = 0.0; glitch::Block* block = nullptr; int edge = 0; bool onLabel = false, onDot = false; };
    Hit hitTest (juce::Point<int>) const;
    juce::Rectangle<int> gridArea() const { return getLocalBounds().withTrimmedLeft (labelW).withTrimmedTop (rulerH); }
    glitch::Block* findBlock (int lane, int id);
    void edited();

    GlitchProcessor& proc;
    int selLane = 0, selBlock = -1;
    const glitch::LiveView* live = nullptr;
    bool liveDrifted = false;

    struct Drag { enum Kind { none, draw, edgeA, edgeB, move } kind = none; int lane = -1, blockId = -1, anchorCell = 0, startA = 0, startB = 0; double grabOff = 0.0; } drag;
};
