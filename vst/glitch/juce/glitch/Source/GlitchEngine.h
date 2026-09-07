#pragma once

#include <JuceHeader.h>
#include "GlitchStages.h"
#include <vector>

// The audio half of GLITCH: glitch-worklet.js in C++, with the file timebase
// replaced by the host's bars. See GlitchStages.h for the chain and the model.
//
// Clock (as slice): transport running → position = host PPQ; stopped or no
// transport → free-run at host bpm / the BPM knob; SYNC off → the knob always.
// The pattern is `bars` long; frac = position within it. Every wrap of frac
// (natural, or the host looping back) is one generation: MUTATE reshapes the
// live pattern, blocks re-fire their accumulators. Transport start = fresh run
// (pass 0, live = authored, accumulators home) — the page's PLAY.
namespace glitch {

struct Controls
{
    bool   sync = true;
    double bpmFallback = 120.0;
    int    bars = 4;
    float  level = 1.0f;
};

struct HostPos
{
    bool   hasTransport = false, playing = false, hasPpq = false;
    double bpm = 0.0, ppq = 0.0;
    int    beatsPerBar = 4;
};

// The live (mutated) pattern — authored geometry evolved per pass.
struct LiveBlock
{
    int    id = 0, src = 0;   // src = the authored block whose settings this one follows
    double a = 0.0, b = 0.0;  // pattern fractions
    Vals   vals;
    Acc    acc;
    int    fires = 0;         // accumulator count
};
struct LiveLane
{
    bool  on = false;
    float mutate = 0.0f;
    int   count = 0;
    std::array<LiveBlock, maxLiveBlocks> blocks;
};
struct LivePattern
{
    int grid = 64;
    std::array<LiveLane, numStages> lanes;
};

// What the editor draws of the live pattern (geometry only).
struct LiveView
{
    int version = 0;
    int pass = 0;
    struct LaneView { int count = 0; struct B { double a, b; int src; } blocks[maxLiveBlocks]; };
    std::array<LaneView, numStages> lanes;
};

// --- DSP helpers ---
struct Biquad
{
    float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    float z[2][2] {};
    bool bypass = true;
    void set (bool lowpass, double fc, double q, double sr) noexcept;
    float run (int ch, float x) noexcept
    {
        if (bypass) return x;
        auto& s = z[ch];
        const float y = b0 * x + s[0];
        s[0] = b1 * x - a1 * y + s[1];
        s[1] = b2 * x - a2 * y;
        return y;
    }
};

class StageBase
{
public:
    StageBase (int stageIndex, juce::uint32 seed) : stage (stageIndex), rng (seed) {}
    virtual ~StageBase() = default;

    void   setSampleRate (double s) noexcept { sr = s; engCoef = 1.0 - std::exp (-1.0 / (0.002 * sr)); }
    void   prepare (int blockId, const LiveBlock* block, const Vals* vals, bool entering) noexcept;
    void   tick (float* x, double posFrames) noexcept;   // x[2] in/out
    float  engagement() const noexcept { return (float) eng; }
    virtual void reseed (juce::uint32 seed) noexcept { rng = Rng (seed); }

    double cellFrames = 1.0;

protected:
    virtual void onBlockChange (bool hasBlock) { juce::ignoreUnused (hasBlock); }
    virtual void processBand (float* b, double posFrames) = 0;

    int stage;
    Rng rng;
    double sr = 48000.0, engCoef = 0.01;
    Biquad hp, lp;
    double eng = 0.0;
    bool hasBlock = false, wasBlock = false;
    int key = -1;
    Vals vals;
    bool haveVals = false;
    float lastLo = -1.0f, lastHi = -1.0f;
    float band[2] {}, rest[2] {};
};

class Crush : public StageBase
{
public:
    explicit Crush (juce::uint32 seed) : StageBase (crush, seed) {}
protected:
    void processBand (float* b, double) override;
private:
    float hold[2] {}; int holdCount = 0; double dropLeft = 0.0; float dropGain = 1.0f; double rotCountdown = 0.0;
};

class Noise : public StageBase
{
public:
    explicit Noise (juce::uint32 seed) : StageBase (noise, seed) {}
    float pingLed[2] {};
protected:
    void processBand (float* b, double) override;
private:
    double fcoef() const noexcept;
    float svf[2][2] {}; float dcb[2][2] {}; bool bit[2] {}; float ping[2] {};
    double jit = 0.0; double nextClock = 0.0; int xingSign = 0, xingCount = 0; double frame = 0.0;
};

class Drive : public StageBase
{
public:
    explicit Drive (juce::uint32 seed) : StageBase (drive, seed) {}
protected:
    void processBand (float* b, double) override;
private:
    static float applyMode (float input, int mode, float bias, float driveN) noexcept;
    float prevY[2] {}, postLp[2] {}, prevX[2] {}; double drift[2] { 0.0, juce::MathConstants<double>::pi * 0.37 };
};

class Chop : public StageBase
{
public:
    explicit Chop (juce::uint32 seed) : StageBase (chop, seed) {}
protected:
    void processBand (float* b, double posFrames) override;
private:
    float gain = 1.0f, env = 0.0f;
};

class GlitchRepeat : public StageBase
{
public:
    explicit GlitchRepeat (juce::uint32 seed) : StageBase (glitchStage, seed) {}
    void allocate (double sampleRate);
protected:
    void onBlockChange (bool hasBlock) override;
    void processBand (float* b, double) override;
private:
    enum Phase { idle, arm, record, repeat, miss };
    void trigger() noexcept; void startRepeats() noexcept; void startRep() noexcept;
    std::vector<float> cap[2];
    int capLen = 0, subLen = 0, shufOff = 0, count = 1, rep = 0, i = 0;
    Phase phase = idle;
    double read = 0.0, rate = 1.0;
};

class Feedback : public StageBase
{
public:
    explicit Feedback (juce::uint32 seed) : StageBase (feedback, seed) {}
    void allocate (double sampleRate);
protected:
    void processBand (float* b, double) override;
private:
    std::vector<float> line[2]; int w = 0; float toneLp[2] {};
};

class GlitchEngine
{
public:
    GlitchEngine();
    void prepare (double sampleRate, int maxBlock);

    // audio thread
    void setAuthored (const Pattern& p, juce::uint32 seedHash) noexcept;   // a fresh copy from the mailbox
    void requestReset() noexcept { resetFlag = true; }
    void process (juce::AudioBuffer<float>&, const Controls&, const HostPos&) noexcept;

    // message thread
    bool   copyLive (LiveView& dst, int& lastVersion);
    double uiFrac() const noexcept { return uiFracA.load (std::memory_order_relaxed); }
    int    uiPass() const noexcept { return uiPassA.load (std::memory_order_relaxed); }
    double uiBpm()  const noexcept { return uiBpmA.load (std::memory_order_relaxed); }
    float  uiEng (int s) const noexcept { return uiEngA[(size_t) s].load (std::memory_order_relaxed); }
    float  uiPing (int ch) const noexcept { return uiPingA[(size_t) ch].load (std::memory_order_relaxed); }
    bool   transportStarted() noexcept { return startedFlag.exchange (false); }   // for AUTO seed

private:
    void buildStages();
    void reset() noexcept;
    void cloneAuthored() noexcept;
    void applyAuthored() noexcept;
    void mutate() noexcept;
    void publishLive() noexcept;
    const LiveBlock* blockAt (const LiveLane&, double frac) const noexcept;
    Vals effectiveVals (int stage, const LiveBlock&, int count) const noexcept;

    double sr = 48000.0;
    int maxBlockSize = 512;

    Pattern authored;
    bool haveAuthored = false, havePrev = false;
    int prevGrid = -1;
    LivePattern live;
    bool haveLive = false;
    juce::uint32 seed = 1;
    Rng mutRng { 1 };
    int pass = 0;
    int liveNextId = 1000000;

    std::unique_ptr<Crush> stCrush; std::unique_ptr<Noise> stNoise; std::unique_ptr<Drive> stDrive;
    std::unique_ptr<Chop> stChop; std::unique_ptr<GlitchRepeat> stGlitch; std::unique_ptr<Feedback> stFeedback;
    StageBase* stages[numStages] {};
    int stageBlockPass[numStages] {};
    int stageKey[numStages] {};

    double beat = 0.0;
    bool hostDriven = false, wasPlaying = false;
    double lastFrac = 0.0;
    bool resetFlag = false;

    juce::SmoothedValue<float> levelSm { 1.0f };

    // → editor
    juce::SpinLock uiLock;
    LiveView uiView;
    int uiVersion = 0;
    bool publishPending = false;
    std::atomic<double> uiFracA { 0.0 }, uiBpmA { 120.0 };
    std::atomic<int> uiPassA { 0 };
    std::array<std::atomic<float>, numStages> uiEngA;
    std::array<std::atomic<float>, 2> uiPingA;
    std::atomic<bool> startedFlag { false };
};

} // namespace glitch
