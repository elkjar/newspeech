#include "NewspeechButton.h"
#include "NewspeechColors.h"

using namespace newspeech::colors;

NewspeechButton::NewspeechButton (const juce::String& text)
    : juce::TextButton (text)
{
    setMouseCursor (juce::MouseCursor::PointingHandCursor);
}

int NewspeechButton::preferredWidth() const
{
    const auto f = monoFont (type::chrome, type::chromeTracking);
    return juce::roundToInt (f.getStringWidthFloat (getButtonText().toUpperCase())) + 2 * paddingX;
}
