#pragma once

#include <JuceHeader.h>
#include "NewspeechSectionPanel.h"
#include "NewspeechSegment.h"
#include "NewspeechTextField.h"
#include "NewspeechButton.h"
#include "NewspeechKnob.h"
#include "SliceReadout.h"
#include "SliceStrip.h"

// PATTERN: the message and how it becomes time. The section box + heading
// come from NewspeechSectionPanel; inside, four lines instead of knob cells:
//   [MORSE|BITS|DATA]  message field                        [RESTORE]
//   readout — the characters with their code, struck where corrupted
//   strip   — the pass as blocks with the playhead
//   DAH · GAP · LETTER · WORD · THRESH — the spacing knobs (page: CLOCK's right half)
class SlicePatternPanel : public NewspeechSectionPanel
{
public:
    SlicePatternPanel (NewspeechSegment& patternSeg, NewspeechTextField& field, NewspeechButton& restore,
                       SliceReadout& readout, SliceStrip& strip,
                       std::initializer_list<juce::Component*> knobs);

    void resized() override;

    static constexpr int fieldH   = NewspeechTextField::height;
    static constexpr int readoutH = 40;
    static constexpr int stripH   = 44;
    static constexpr int gapA = 8, gapB = 8, gapC = 10;
    static constexpr int totalHeightPattern = lineY + pad + fieldH + gapA + readoutH + gapB + stripH + gapC
                                              + NewspeechKnob::totalHeight + pad + 1;

private:
    NewspeechSegment& seg;
    NewspeechTextField& field;
    NewspeechButton& restore;
    SliceReadout& readout;
    SliceStrip& strip;
    juce::Array<juce::Component*> knobs;
};
