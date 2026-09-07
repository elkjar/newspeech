#include "NewspeechEditor.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechEditor::NewspeechEditor (juce::AudioProcessor& proc, const juce::String& t)
    : juce::AudioProcessorEditor (proc), title (t), datafield (proc)
{
    setLookAndFeel (&laf);
    addAndMakeVisible (datafield);
    setResizable (false, false);
}

NewspeechEditor::~NewspeechEditor()
{
    setLookAndFeel (nullptr);
}

void NewspeechEditor::setContentSize (int contentW, int contentH)
{
    const int chrome = 2 * (outerPad + innerPad);
    const int w = juce::jmax (contentW, minContentWidth) + chrome;
    const int h = headerH + postHeader + contentH + chrome;
    setResizeLimits (w, h, w, h);
    setSize (w, h);
}

juce::Rectangle<int> NewspeechEditor::contentBounds() const
{
    auto r = getLocalBounds().reduced (outerPad).reduced (innerPad);
    r.removeFromTop (headerH + postHeader);
    return r;
}

int NewspeechEditor::rowWidth (std::initializer_list<const NewspeechSectionPanel*> panels)
{
    int w = 0, n = 0;
    for (auto* p : panels) { w += p->preferredWidth(); ++n; }
    if (n > 1) w += (n - 1) * panelGapX;
    return w;
}

int NewspeechEditor::placeRow (juce::Rectangle<int> row, std::initializer_list<NewspeechSectionPanel*> panels)
{
    int x = row.getX();
    bool first = true;
    for (auto* p : panels)
    {
        if (! first) x += panelGapX;
        const int w = p->preferredWidth();
        p->setBounds (x, row.getY(), w, row.getHeight());
        x += w;
        first = false;
    }
    rowsRight = juce::jmax (rowsRight, x);
    return x - row.getX();
}

void NewspeechEditor::resized()
{
    const auto content = contentBounds();
    rowsRight = content.getX();
    layoutContent (content);

    // Datafield bottom-right: its right edge on the widest row's box right
    // edge (boxes sit boxInset inside their panels), its bottom on the last
    // row's box bottom. Rows only run under it when a plugin's last row is
    // short (vibe/saturate: OUT).
    datafield.setBounds (rowsRight - NewspeechSectionPanel::boxInset - datafield.preferredWidth(),
                         content.getBottom() - NewspeechDatafield::totalHeight,
                         datafield.preferredWidth(), NewspeechDatafield::totalHeight);
}

void NewspeechEditor::paint (juce::Graphics& g)
{
    g.fillAll (ink);

    // Frame: `border border-white/15`, square.
    auto frame = getLocalBounds().reduced (outerPad);
    g.setColour (border);
    g.drawRect (frame, 1);

    // Crumb: "NEW SPEECH | TITLE" — .crumb (12px, 0.12em, opacity 0.55, sep 0.35).
    auto inner  = frame.reduced (innerPad);
    // The crumb sits on the same left rail as the section boxes.
    auto header = inner.removeFromTop (headerH).withTrimmedLeft (NewspeechSectionPanel::railInset);
    g.setFont (monoFont (type::crumb, type::crumbTracking));

    g.setColour (white (alpha::crumb));
    g.drawText ("NEW SPEECH", header, juce::Justification::centredLeft, false);

    const auto nsWidth = g.getCurrentFont().getStringWidthFloat ("NEW SPEECH ");
    auto sep = header.toFloat().withTrimmedLeft (nsWidth);
    g.setColour (white (0.35f));
    g.drawText ("|", sep, juce::Justification::centredLeft, false);

    const auto sepWidth = g.getCurrentFont().getStringWidthFloat ("| ");
    g.setColour (white (alpha::crumb));
    g.drawText (title.toUpperCase(), sep.withTrimmedLeft (sepWidth), juce::Justification::centredLeft, false);
}

juce::RangedAudioParameter& NewspeechEditor::paramByName (const juce::String& name)
{
    for (auto* p : processor.getParameters())
        if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p))
            if (r->getName (256) == name)
                return *r;

    DBG ("NewspeechEditor: no param named '" << name << "'. Available:");
    for (auto* p : processor.getParameters())
        if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p))
            DBG ("  name='" << r->getName (256) << "' id='" << r->getParameterID() << "'");
    jassertfalse;
    static juce::AudioParameterFloat fallback { "fallback", "fallback", 0.0f, 1.0f, 0.0f };
    return fallback;
}
