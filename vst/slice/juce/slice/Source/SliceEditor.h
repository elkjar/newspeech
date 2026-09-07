#pragma once

#include <JuceHeader.h>
#include "NewspeechEditor.h"
#include "NewspeechKnob.h"
#include "NewspeechToggle.h"
#include "NewspeechSegment.h"
#include "NewspeechTextField.h"
#include "NewspeechButton.h"
#include "SlicePatternPanel.h"
#include "SliceReadout.h"
#include "SliceStrip.h"
#include "SliceProcessor.h"

// SLICE editor. Rows:
//   PATTERN            (message · readout · strip · spacing knobs)
//   CLOCK · SHAPE
//   SOURCE · CAPTURE
//   MANGLE                                  [datafield]
class SliceEditor : public NewspeechEditor,
                    private juce::Timer
{
public:
    explicit SliceEditor (SliceProcessor&);
    ~SliceEditor() override;

private:
    void layoutContent (juce::Rectangle<int> content) override;
    void timerCallback() override;
    void syncField (bool force);
    void fieldChanged();
    static void dim (juce::Component&, bool dimmed);

    SliceProcessor& proc;

    // PATTERN
    std::unique_ptr<NewspeechSegment> patternSeg;
    NewspeechTextField field;
    NewspeechButton restoreButton { "RESTORE" };
    SliceReadout readout;
    SliceStrip strip;
    std::unique_ptr<NewspeechKnob> dah, gap, letter, word, thresh;
    std::unique_ptr<SlicePatternPanel> patternPanel;

    // CLOCK
    NewspeechSectionPanel clockPanel { "CLOCK" };
    std::unique_ptr<NewspeechToggle> sync;
    std::unique_ptr<NewspeechKnob> bpm;
    std::unique_ptr<NewspeechSegment> rateSeg, feelSeg;

    // SHAPE
    NewspeechSectionPanel shapePanel { "SHAPE" };
    std::unique_ptr<NewspeechKnob> attack, release, depth, level;

    // SOURCE
    NewspeechSectionPanel sourcePanel { "SOURCE" };
    std::unique_ptr<NewspeechSegment> sourceSeg, waveSeg;
    std::unique_ptr<NewspeechKnob> freq, dahPitch;

    // CAPTURE
    NewspeechSectionPanel capturePanel { "CAPTURE" };
    std::unique_ptr<NewspeechSegment> modeSeg;
    std::unique_ptr<NewspeechToggle> freeze;
    std::unique_ptr<NewspeechKnob> speed;

    // MANGLE
    NewspeechSectionPanel manglePanel { "MANGLE" };
    std::unique_ptr<NewspeechKnob> flip, ratchet, drop, scramble;
    std::unique_ptr<NewspeechToggle> decay;

    // live state from the engine
    slice::UiPass uiPass;
    int uiVersion = -1;
    int shownPattern = -1;   // which field content is loaded (0/1 text, 2 data)
    bool suppressFieldCallback = false;
};
