#pragma once

#include <JuceHeader.h>
#include <array>

// The pattern half of slice — a straight port of slice.html's builders and
// mangling. Pure data + functions, no audio: a message (or a numeric series)
// plus the timing knobs become one pass of events in beats. Everything is
// fixed-capacity so the audio thread can build passes without allocating.
namespace slice {

constexpr int maxChars  = 128;
constexpr int maxData   = 512;
constexpr int maxEvents = 4096;

enum class Pattern { morse = 0, bits, data };

// Morse code for an uppercase character, or nullptr when it has none.
const char* morseFor (char c) noexcept;

struct Event
{
    double t = 0.0, dur = 0.0;   // beats from the pass start
    int    kind = 0;             // 0 short / 1 long — long hits take the dah± pitch
    int    ci = 0;               // input index (character or data point) for the readout
    float  level = 1.0f;
    bool   dropped = false;      // the slot stays, the sound goes
    bool   ratchet = false;
};

struct Message
{
    int len = 0;
    std::array<char, maxChars> ch {};
};

struct Series
{
    int len = 0;
    std::array<float, maxData> v {};
    float min = 0.0f, max = 1.0f;   // of the original series; scramble stays inside
    float norm (float x) const noexcept { return max > min ? (x - min) / (max - min) : 0.5f; }
};

// The knobs that shape a pass, snapshotted per build.
struct Params
{
    Pattern pattern   = Pattern::morse;
    double  unitBeats = 0.25;   // one dit: DIVS[rate] * FEELS[feel] beats
    double  bpm       = 120.0;  // only for the 12ms / 0.25s floors
    double  dah = 3.0, gap = 1.0, letter = 3.0, word = 7.0;   // in dits
    double  thresh = 0.35;
    double  flip = 0.0, ratchet = 0.0, drop = 0.0;

    // Changes that restructure the pass (the page's CLOCK_KEYS) — dice knobs
    // wait for the next pass instead.
    bool structurallyDiffers (const Params& o) const noexcept
    {
        return pattern != o.pattern || unitBeats != o.unitBeats || dah != o.dah || gap != o.gap
            || letter != o.letter || word != o.word || thresh != o.thresh;
    }
};

struct Pass
{
    int count = 0;
    std::array<Event, maxEvents> events;
    double total = 1.0;   // beats

    void clear() noexcept { count = 0; total = 1.0; }
    void push (const Event& e) noexcept { if (count < maxEvents) events[(size_t) count++] = e; }
};

// Parsing — what's typed becomes the original pattern.
void parseMessage (const char* text, Message& out) noexcept;   // uppercased; keeps ' ' and morse-able chars
void parseSeries  (const char* text, Series& out) noexcept;    // numbers split on space/comma/semicolon

// One pass from the current state. Dice come from `rng` — seed it per pass so
// a hot swap (knob move mid-pass) keeps the same rolls.
void buildPass (const Params&, const Message&, const Series&, juce::Random& rng, Pass& out) noexcept;

// MANGLE's erosion: chance per letter (or point) per pass of being replaced.
void scrambleMessage (Message&, double p, juce::Random& rng) noexcept;
void scrambleSeries  (Series&, double p, juce::Random& rng) noexcept;

} // namespace slice
