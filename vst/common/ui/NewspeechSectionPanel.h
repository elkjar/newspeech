#pragma once

#include <JuceHeader.h>
#include "NewspeechKnob.h"

// A control group drawn as Sequence draws a bordered panel: a 1px white/15
// box hugging the row of knob cells with `pad` around the rings and labels,
// and the 9px white/40 uppercase heading riding the top border line (the
// line is interrupted behind the text). Chris's comp, 2026-09-06.
//
// Geometry (panel-local):
//   x: cells run the full width; the box is inset `boxInset` so its edge sits
//      `pad` outside the first/last ring (cells carry an 18px side margin).
//   y: heading text 0..headingHeight, centred on the box's top line at
//      headingHeight/2; controls start `pad` below that line; the box closes
//      `pad` below the labels.
class NewspeechSectionPanel : public juce::Component
{
public:
    explicit NewspeechSectionPanel (const juce::String& title);

    // Controls are laid out left→right as cells. Knobs and toggles take the
    // standard cellWidth; wider controls (a segmented switch, a button) pass
    // their own width and get the same cell height.
    void addControl (juce::Component* control, int width = cellWidth);
    // A control that fills its own width (a segmented switch, a button): the
    // cell gets `pad` either side so it sits inside the box like a knob ring.
    void addWideControl (juce::Component* control, int contentWidth);
    int  preferredWidth() const noexcept;

    void paint (juce::Graphics&) override;
    void resized() override;

    static constexpr int headingHeight = 14;
    static constexpr int controlGap    = 6;
    static constexpr int cellWidth     = 80;   // wide enough for "GRAIN RATE"
    static constexpr int cellMargin    = (cellWidth - NewspeechKnob::knobDiameter) / 2;   // 18
    static constexpr int pad           = 12;   // ring/label → box edge
    static constexpr int boxInset      = cellMargin - pad;                                // 6
    static constexpr int headingLead   = 14;   // box edge → heading text
    static constexpr int headingGapPad = 5;    // border gap either side of the text
    static constexpr int lineY         = headingHeight / 2;
    static constexpr int totalHeight   = lineY + pad + NewspeechKnob::totalHeight + pad + 1;

    // The left rail for the editor crumb: the box's left edge.
    static constexpr int railInset     = boxInset;

    static constexpr int widthFor (int controlCount) noexcept
    {
        return controlCount <= 0 ? 0 : controlCount * cellWidth + (controlCount - 1) * controlGap;
    }

    // Box rectangle in panel-local coordinates.
    juce::Rectangle<int> boxBounds() const noexcept;

private:
    juce::String title;
    juce::Array<juce::Component*> controls;
    juce::Array<int> widths;
};
