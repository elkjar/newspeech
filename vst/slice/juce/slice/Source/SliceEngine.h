#pragma once

#include <JuceHeader.h>
#include "SlicePattern.h"

// The audio half of slice: a pattern sequencer anchored to the host clock and
// three ways of sounding it.
//
//   TONE          an internal oscillator, gated by the pattern (dah± = pitch).
//   INPUT / GATE  the live input, gated (depth = bleed between hits; dah± bends
//                 the input's speed for the length of a long hit).
//   INPUT / CHOP  each hit punches into the CAPTURE loop — the previous pass of
//                 input — where continuous playback would be.
//   INPUT / SCAN  each hit grabs from a random position in that loop.
//
// Clock: while the host transport runs, position = host PPQ, so the pattern
// sits on the session grid and survives loops/relocates. Stopped (or no
// transport, e.g. the standalone), it free-runs at the host bpm (or the BPM
// knob) so the plugin plays without pressing play. A pass is anchored at
// passStart (beats); knob moves rebuild the current pass in place, phase
// preserved; the dice are seeded per pass so a rebuild keeps the same rolls.
namespace slice {

struct Controls
{
    Params build;                          // pattern-shaping params (see SlicePattern.h)
    int    source = 0;                     // 0 TONE · 1 INPUT
    int    wave   = 0;                     // 0 SIN · 1 TRI · 2 SQR · 3 SAW
    int    mode   = 0;                     // 0 GATE · 1 CHOP · 2 SCAN
    bool   freeze = false;                 // hold the capture loop
    double freqHz = 600.0, dahMult = 1.0, speed = 1.0;
    double attackS = 0.002, releaseS = 0.03, depth = 1.0, level = 1.0;
    double scramble = 0.0;
    bool   decay = true;
    double bpmFallback = 120.0;
};

struct HostPos
{
    bool   hasTransport = false, playing = false, hasPpq = false;
    double bpm = 0.0, ppq = 0.0;
};

// What the editor draws — copied out under a lock when the version changes.
struct UiPass
{
    int     version = 0;
    Pattern pattern = Pattern::morse;
    Pass    pass;
    Message curMsg, origMsg;
    Series  curSeries, origSeries;
};

class SliceEngine
{
public:
    SliceEngine();

    void prepare (double sampleRate, int maxBlockSize);
    void reset();

    // --- audio thread ---
    void setInput (const char* text, const char* dataText) noexcept;   // both raw fields; the pattern picks
    void restore() noexcept;                                            // cur = orig
    void process (juce::AudioBuffer<float>& io, const Controls&, const HostPos&) noexcept;

    // --- message thread ---
    bool   copyUiPass (UiPass& dst, int& lastVersion);
    double uiBeat()      const noexcept { return uiBeatA.load (std::memory_order_relaxed); }
    double uiPassStart() const noexcept { return uiPassStartA.load (std::memory_order_relaxed); }
    double uiTotal()     const noexcept { return uiTotalA.load (std::memory_order_relaxed); }
    double uiBpm()       const noexcept { return uiBpmA.load (std::memory_order_relaxed); }
    bool   uiHasPattern() const noexcept { return uiHasPatternA.load (std::memory_order_relaxed); }

    static constexpr int numVoices = 8;

private:
    void rebuild (const Params&) noexcept;                 // same seed → same dice
    void advancePass (const Params&, const Controls&) noexcept;
    void anchor (const Params&, const Controls&) noexcept; // relocate: pass boundary at a multiple of total
    void refreshLoop (double prevTotalBeats, double bps) noexcept;
    void publish() noexcept;
    bool hasPattern (Pattern) const noexcept;

    float readRing (int ch, double absPos) const noexcept;
    double clampRead (double absPos) const noexcept;
    float osc (int wave, double phase) const noexcept;

    double sr = 48000.0;
    int    maxBlock = 512;

    // pattern state — orig is what's typed, cur is what plays (scramble erodes it)
    Message origMsg, curMsg;
    Series  origSeries, curSeries;
    Pass    pass;
    Params  built;                 // params the current pass was built with
    bool    everBuilt = false;
    juce::Random seedRng, diceRng;
    juce::int64 passSeed = 1;

    // clock
    double beat = 0.0;             // current position, beats
    double passStart = 0.0;
    bool   hostDriven = false;
    int    evIdx = 0, activeEv = -1;
    bool   resync = true;          // after a rebuild: adopt the event under the head without retriggering

    // pending from the UI (set on the audio thread by the processor)
    bool restoreFlag = false;

    // tone
    double phase = 0.0;
    juce::SmoothedValue<double, juce::ValueSmoothingTypes::Multiplicative> freqSm { 600.0 };
    juce::SmoothedValue<double> levelSm { 1.0 };
    double pitchMult = 1.0;        // current dah± multiplier (long hit held through its release)
    int    tail = 0;               // samples of release left after the last hit closed

    // bed envelope (TONE + GATE)
    double env = 0.0;

    // capture ring of the input; absolute (monotonic) write index
    juce::AudioBuffer<float> ring;
    int ringLen = 0;
    juce::int64 writePos = 0;
    double loopStart = 0.0, loopLen = 1.0;   // absolute sample positions into the ring

    // GATE dah± bend reads the ring at a shifted speed for the length of a long hit
    struct Bend { bool active = false; double pos = 0.0, rate = 1.0; } bend;

    // CHOP / SCAN voices
    struct Voice
    {
        bool   active = false;
        double pos = 0.0, rate = 1.0;
        double age = 0.0, atk = 1.0, hold = 1.0, rel = 1.0;
        float  peak = 1.0f;
        juce::int64 started = 0;
    };
    std::array<Voice, numVoices> voices;
    juce::int64 voiceClock = 0;
    void startVoice (const Event&, double posBeats, const Controls&, double bps) noexcept;

    // → editor
    juce::SpinLock uiLock;
    UiPass uiPass;
    int uiVersion = 0;
    bool publishPending = false;
    std::atomic<double> uiBeatA { 0.0 }, uiPassStartA { 0.0 }, uiTotalA { 1.0 }, uiBpmA { 120.0 };
    std::atomic<bool> uiHasPatternA { false };
};

} // namespace slice
