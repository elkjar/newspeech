#pragma once

#include <JuceHeader.h>
#include <array>

// GLITCH — the audio destruction chain from glitch.html, re-anchored from a
// dropped file to the host's bars. Six stages in a FIXED serial order:
//
//   in → CRUSH → NOISE → DRIVE → CHOP → GLITCH → FEEDBACK → out
//
// Each stage is a lane on a grid of 1–8 bars; a block = the stage is in the
// path for that span, carrying its own full settings (lo/hi band scope, mix,
// the stage's knobs and switches) and optionally an accumulator that climbs a
// knob each time the block fires. Every pass through the pattern is a
// generation: each lane's MUTATE reshapes its blocks (the live pattern) while
// the grid keeps showing what was drawn (the authored pattern).
//
// This header is the shared vocabulary: stage/knob/switch tables (the page's
// STAGES), the ladders stepped knobs read, and the fixed-capacity pattern
// model that crosses from the editor to the audio thread without allocating.
namespace glitch {

constexpr int numStages = 6;
enum Stage : int { crush = 0, noise, drive, chop, glitchStage, feedback };

constexpr int maxBlocks     = 64;    // authored blocks per lane
constexpr int maxLiveBlocks = 128;   // mutation may split/add — capped
constexpr int maxKnobs      = 9;     // lo · hi · mix + up to 6 stage knobs
constexpr int maxSegs       = 2;
constexpr int maxSegOpts    = 7;

// Block value slots: the three every stage shares, then the stage's own.
enum : int { K_LO = 0, K_HI = 1, K_MIX = 2, K_STAGE0 = 3 };

struct KnobSpec { const char* key; const char* label; int steps; float def; bool bipolar; };
struct SegSpec  { const char* key; const char* label; int count; const char* names[maxSegOpts]; int def; bool onBlock; };

struct StageSpec
{
    const char* id;
    const char* name;
    int numKnobs;                 // stage knobs (excluding lo/hi/mix)
    KnobSpec knobs[6];
    int numSegs;
    SegSpec segs[maxSegs];
};

// --- ladders (the page's constants) ---
inline constexpr float LO_LADDER[]          = { 0, 80, 160, 320, 640, 1200 };
inline constexpr float HI_LADDER[]          = { 20000, 10000, 5000, 2500, 1200, 600 };
inline constexpr int   BITS_LADDER[]        = { 16, 12, 10, 8, 6, 4, 3, 2, 1 };
inline constexpr int   RATE_DIV_LADDER[]    = { 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64 };
inline constexpr float CHOP_PERIOD_LADDER[] = { 4, 2, 1, 0.5f, 0.25f, 0.125f, 0.0625f };
inline constexpr float GLITCH_LEN_LADDER[]  = { 0.0625f, 0.125f, 0.25f, 0.5f, 1, 2 };
inline constexpr int   PITCH_LADDER[]       = { -2, -1, 0, 1, 2 };
inline constexpr float FB_DELAY_LADDER[]    = { 1, 2, 5, 10, 20, 50, 100, 200, 500 };

template <typename T, size_t N>
inline T ladder (const T (&arr)[N], float k) noexcept
{
    const float c = juce::jlimit (0.0f, 1.0f, k);
    return arr[(size_t) juce::roundToInt (c * (float) (N - 1))];
}

// The page's STAGES table. Knob order here = value slot order from K_STAGE0.
inline const StageSpec& stageSpec (int i) noexcept
{
    static const StageSpec specs[numStages] = {
        { "crush", "CRUSH", 3,
          { { "bits", "BITS", 9, 3.0f / 8.0f, false }, { "rate", "RATE", 12, 0.0f, false }, { "rot", "ROT", 0, 0.0f, false } },
          0, {} },
        { "noise", "NOISE", 6,
          { { "drive", "DRIVE", 0, 0.25f, false }, { "cutoff", "CUTOFF", 0, 0.6f, false }, { "res", "RES", 0, 0.4f, false },
            { "noise", "NOISE", 0, 0.3f, false }, { "cv", "CV", 0, 0.2f, false }, { "clock", "CLOCK", 0, 0.63775f, false } },
          2, { { "filter", "FILTER", 2, { "LP", "BP" }, 0, false },
               { "clocksrc", "CLOCK", 2, { "FREE", "SIGNAL" }, 0, false } } },
        { "drive", "DRIVE", 2,
          { { "drive", "DRIVE", 0, 0.34f, false }, { "bias", "BIAS", 0, 0.4f, false } },
          1, { { "mode", "MODE", 4, { "BOOST", "TUBE", "FUZZ", "SQUARE" }, 2, true } } },
        { "chop", "CHOP", 4,
          { { "period", "PERIOD", 7, 3.0f / 6.0f, false }, { "duty", "DUTY", 0, 0.5f, false },
            { "edge", "EDGE", 0, 0.1f, false }, { "thresh", "THRESH", 0, 0.5f, false } },
          1, { { "src", "SRC", 2, { "CLOCK", "THRESH" }, 0, false } } },
        { "glitch", "GLITCH", 4,
          { { "len", "LENGTH", 6, 3.0f / 5.0f, false }, { "count", "COUNT", 16, 3.0f / 15.0f, false },
            { "pitch", "PITCH", 5, 0.5f, true }, { "chance", "CHANCE", 0, 1.0f, false } },
          1, { { "mode", "MODE", 7, { "STUTTER", "REVERSE", "OCT+", "OCT-", "SILENCE", "TAPESTOP", "SHUFFLE" }, 0, true } } },
        { "feedback", "FEEDBACK", 3,
          { { "amount", "AMOUNT", 0, 0.3f, false }, { "delay", "DELAY", 9, 3.0f / 8.0f, false }, { "tone", "TONE", 0, 0.7f, false } },
          0, {} },
    };
    return specs[juce::jlimit (0, numStages - 1, i)];
}

inline const KnobSpec& scopeSpec (int slot) noexcept   // K_LO, K_HI, K_MIX
{
    static const KnobSpec s[3] = { { "lo", "LO", 6, 0.0f, false }, { "hi", "HI", 6, 0.0f, false }, { "mix", "MIX", 0, 1.0f, false } };
    return s[juce::jlimit (0, 2, slot)];
}

// Spec for any value slot of a stage (scope or stage knob); nullptr past the end.
inline const KnobSpec* slotSpec (int stage, int slot) noexcept
{
    if (slot < K_STAGE0) return &scopeSpec (slot);
    const auto& st = stageSpec (stage);
    const int i = slot - K_STAGE0;
    return i < st.numKnobs ? &st.knobs[i] : nullptr;
}
inline int numSlots (int stage) noexcept { return K_STAGE0 + stageSpec (stage).numKnobs; }

// --- pattern model ---
struct Vals
{
    std::array<float, maxKnobs> k {};
    std::array<int, maxSegs> seg {};
};

enum AccShape : int { accOff = 0, accWrap, accBounce, accHold };
struct Acc
{
    int   shape  = accOff;
    int   target = K_STAGE0;        // value slot the accumulator climbs
    float step   = 0.5f + 1.0f / 16.0f;   // −4..+4 rungs, 0.5 = 0
    float range  = 3.0f / 7.0f;           // 1..8 rungs before it turns / resets
};

struct Block
{
    int  id = 0;
    int  a = 0, b = 1;   // grid cells, b exclusive
    Vals vals;
    Acc  acc;
};

struct Lane
{
    bool  on = true;
    float mutate = 0.0f;
    Vals  defaults;        // for the next drawn block
    int   count = 0;
    std::array<Block, maxBlocks> blocks;
};

struct Pattern
{
    int grid = 64;         // total cells = bars × cells per bar
    std::array<Lane, numStages> lanes;
    int nextId = 1;
};

inline Vals defaultVals (int stage) noexcept
{
    Vals v;
    for (int s = 0; s < maxKnobs; ++s) if (auto* sp = slotSpec (stage, s)) v.k[(size_t) s] = sp->def;
    const auto& st = stageSpec (stage);
    for (int i = 0; i < st.numSegs; ++i) v.seg[(size_t) i] = st.segs[i].def;
    return v;
}

// Accumulator rung size: stepped knobs climb in ladder steps, continuous 10%/rung.
inline float rungUnit (int stage, int slot) noexcept
{
    if (auto* sp = slotSpec (stage, slot)) return sp->steps > 1 ? 1.0f / (float) (sp->steps - 1) : 0.1f;
    return 0.1f;
}

// --- seeded randomness (the page's xorshift32 + FNV, so a seed string means the same thing) ---
struct Rng
{
    juce::uint32 s;
    explicit Rng (juce::uint32 seed) noexcept : s (seed != 0 ? seed : 0x9e3779b9u) {}
    juce::uint32 next() noexcept { juce::uint32 r = s; r ^= r << 13; r ^= r >> 17; r ^= r << 5; s = r; return r; }
    double unit() noexcept { return next() / 4294967296.0; }
    bool bit() noexcept { return (next() & 1u) != 0; }
};
inline juce::uint32 seedFromString (const juce::String& str) noexcept
{
    juce::uint32 h = 0x811c9dc5u;
    for (auto c : str.toStdString()) { h ^= (juce::uint8) c; h *= 0x01000193u; }
    return h != 0 ? h : 1u;
}

// --- model operations (message thread) ---
void resetPattern (Pattern&, int grid);
void normalizeLane (Lane&);                       // sort + merge overlaps (dragging onto = join)
void regridPattern (Pattern&, int newGrid);       // rescale cells so spans keep their place
void resizePatternCells (Pattern&, int newGrid);  // keep cell indices, clip to the new length
Block makeBlock (Pattern&, int stage, int a, int b);
void seedGrid (Pattern&, const juce::String& seed);   // the page's SEED_SHAPE scatter
juce::String randomSeed();

// JSON (state): the whole authored pattern, by knob key so it stays readable.
juce::var patternToVar (const Pattern&);
bool patternFromVar (const juce::var&, Pattern&);

} // namespace glitch
