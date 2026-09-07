#pragma once

#include <JuceHeader.h>
#include "NewspeechLookAndFeel.h"
#include "NewspeechSectionPanel.h"

// Base editor for every newspeech plugin: ink background, a square white/15
// frame, the "NEW SPEECH | TITLE" crumb on the same left rail as the section
// boxes, and the micrographic in the bottom-right corner. Subclasses build
// their controls, call setContentSize() once, and lay rows out in
// layoutContent() using placeRow().
class NewspeechEditor : public juce::AudioProcessorEditor
{
public:
    NewspeechEditor (juce::AudioProcessor& proc, const juce::String& title);
    ~NewspeechEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override final;

    static constexpr int outerPad   = 24;   // ink margin around the frame
    static constexpr int innerPad   = 20;   // frame padding
    static constexpr int headerH    = 20;   // crumb strip
    static constexpr int postHeader = 12;
    static constexpr int rowH       = NewspeechSectionPanel::totalHeight;
    static constexpr int boxGap     = 16;   // gap-4 between section boxes, both axes
    // Panels overlap the box gap by their inset (x) and half-heading (y).
    static constexpr int panelGapX  = boxGap - 2 * NewspeechSectionPanel::boxInset;
    static constexpr int rowGap     = boxGap - NewspeechSectionPanel::lineY;
    static constexpr int microW     = 155;  // micrographic.png is 309×96 @2x
    static constexpr int microH     = 48;

protected:
    // Content = the area below the crumb, inside the frame padding.
    void setContentSize (int contentW, int contentH);
    juce::Rectangle<int> contentBounds() const;

    // Lay panels left→right along `row` at their preferred widths with a
    // boxGap between their boxes. Returns the width consumed.
    int placeRow (juce::Rectangle<int> row, std::initializer_list<NewspeechSectionPanel*> panels);
    static int rowWidth (std::initializer_list<const NewspeechSectionPanel*> panels);

    virtual void layoutContent (juce::Rectangle<int> content) = 0;

    // Look up a host parameter by the name Faust/JUCE reports for it.
    juce::RangedAudioParameter& paramByName (const juce::String& name);

private:
    NewspeechLookAndFeel laf;
    juce::String title;
    juce::Image micrographic;
};
