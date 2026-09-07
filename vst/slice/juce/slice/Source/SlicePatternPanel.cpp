#include "SlicePatternPanel.h"

SlicePatternPanel::SlicePatternPanel (NewspeechSegment& s, NewspeechTextField& f, NewspeechButton& rb,
                                      SliceReadout& ro, SliceStrip& st,
                                      std::initializer_list<juce::Component*> ks)
    : NewspeechSectionPanel ("PATTERN"), seg (s), field (f), restore (rb), readout (ro), strip (st)
{
    seg.setCompact (true);
    for (auto* c : std::initializer_list<juce::Component*> { &seg, &field, &restore, &readout, &strip })
        addAndMakeVisible (c);
    for (auto* k : ks) { knobs.add (k); addAndMakeVisible (k); }
}

void SlicePatternPanel::resized()
{
    // Inner column: the box edge + pad → same left as a knob ring (cellMargin).
    const int left  = cellMargin;
    const int right = getWidth() - cellMargin;
    int y = lineY + pad;

    // line 1: segment · field · RESTORE
    {
        const int segW = seg.preferredWidth();
        const int rbW  = restore.preferredWidth();
        seg.setBounds (left, y, segW, fieldH);
        restore.setBounds (right - rbW, y, rbW, fieldH);
        field.setBounds (left + segW + 8, y, right - rbW - 8 - (left + segW + 8), fieldH);
        y += fieldH + gapA;
    }
    readout.setBounds (left, y, right - left, readoutH);
    y += readoutH + gapB;
    strip.setBounds (left, y, right - left, stripH);
    y += stripH + gapC;

    int x = 0;
    for (auto* k : knobs)
    {
        k->setBounds (x, y, cellWidth, NewspeechKnob::totalHeight);
        x += cellWidth + controlGap;
    }
}
