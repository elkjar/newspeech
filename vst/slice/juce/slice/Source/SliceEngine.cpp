#include "SliceEngine.h"
#include <cmath>

namespace slice {

SliceEngine::SliceEngine()
{
    seedRng.setSeedRandomly();
    passSeed = seedRng.nextInt64();
}

void SliceEngine::prepare (double sampleRate, int maxBlockSize)
{
    sr = sampleRate;
    maxBlock = maxBlockSize;
    // 30 s of input: the loop (the previous pass) plus the pass being written
    // must both fit, so the loop is capped at half of this (see refreshLoop).
    ringLen = (int) std::ceil (sr * 30.0);
    ring.setSize (2, ringLen);
    ring.clear();
    freqSm.reset (sr, 0.02);
    levelSm.reset (sr, 0.02);
    reset();
}

void SliceEngine::reset()
{
    writePos = 0;
    loopStart = 0.0; loopLen = 1.0; loopValid = false;
    env = 0.0; phase = 0.0; pitchMult = 1.0; tail = 0;
    bend = {};
    for (auto& v : voices) v.active = false;
    beat = 0.0; passStart = 0.0; hostDriven = false;
    evIdx = 0; activeEv = -1; resync = true;
    everBuilt = false;
}

// --- input / pattern state -------------------------------------------------

void SliceEngine::setInput (const char* text, const char* dataText) noexcept
{
    parseMessage (text, origMsg);
    parseSeries (dataText, origSeries);
    curMsg = origMsg;
    curSeries = origSeries;
    everBuilt = false;   // force a rebuild at the next block
}

void SliceEngine::restore() noexcept
{
    restoreFlag = true;
}

bool SliceEngine::hasPattern (Pattern p) const noexcept
{
    return p == Pattern::data ? curSeries.len > 0 : curMsg.len > 0;
}

void SliceEngine::rebuild (const Params& P) noexcept
{
    diceRng.setSeed (passSeed);
    buildPass (P, curMsg, curSeries, diceRng, pass);
    built = P;
    everBuilt = true;
    evIdx = 0;
    activeEv = -1;
    resync = true;
    publish();
}

void SliceEngine::advancePass (const Params& P, const Controls& c) noexcept
{
    const double prevTotal = pass.total;
    passStart += prevTotal;
    // erosion: decay mutates cur in place; off, fresh dice against the original
    if (P.pattern == Pattern::data)
    {
        if (! c.decay) curSeries = origSeries;
        scrambleSeries (curSeries, c.scramble, seedRng);
    }
    else
    {
        if (! c.decay) curMsg = origMsg;
        scrambleMessage (curMsg, c.scramble, seedRng);
    }
    passSeed = seedRng.nextInt64();
    rebuild (P);
    if (! c.freeze) refreshLoop (prevTotal, P.bpm / 60.0 / sr);
}

void SliceEngine::anchor (const Params& P, const Controls& c) noexcept
{
    passSeed = seedRng.nextInt64();
    rebuild (P);
    const double total = juce::jmax (1.0e-6, pass.total);
    passStart = std::floor (beat / total) * total;
    if (! c.freeze) refreshLoop (total, P.bpm / 60.0 / sr);
}

// The capture loop is always "the previous pass of input": it ends at the write
// head when a pass boundary is crossed. FREEZE stops both the writes and this.
void SliceEngine::refreshLoop (double prevTotalBeats, double bps) noexcept
{
    const double totalSamples = prevTotalBeats / juce::jmax (1.0e-9, bps);
    loopLen = juce::jlimit (16.0, (double) (ringLen / 2 - maxBlock - 8), totalSamples);
    loopStart = (double) writePos - loopLen;
    loopValid = true;
}

void SliceEngine::publish() noexcept
{
    const juce::SpinLock::ScopedTryLockType tl (uiLock);
    if (! tl.isLocked()) { publishPending = true; return; }
    publishPending = false;
    uiPass.pattern = built.pattern;
    uiPass.pass.count = pass.count;
    uiPass.pass.total = pass.total;
    std::copy_n (pass.events.begin(), (size_t) pass.count, uiPass.pass.events.begin());
    uiPass.curMsg = curMsg;   uiPass.origMsg = origMsg;
    uiPass.curSeries = curSeries; uiPass.origSeries = origSeries;
    uiPass.version = ++uiVersion;
}

bool SliceEngine::copyUiPass (UiPass& dst, int& lastVersion)
{
    const juce::SpinLock::ScopedLockType l (uiLock);
    if (uiPass.version == lastVersion) return false;
    lastVersion = uiPass.version;
    dst.version = uiPass.version;
    dst.pattern = uiPass.pattern;
    dst.pass.count = uiPass.pass.count;
    dst.pass.total = uiPass.pass.total;
    std::copy_n (uiPass.pass.events.begin(), (size_t) uiPass.pass.count, dst.pass.events.begin());
    dst.curMsg = uiPass.curMsg;   dst.origMsg = uiPass.origMsg;
    dst.curSeries = uiPass.curSeries; dst.origSeries = uiPass.origSeries;
    return true;
}

// --- ring helpers ----------------------------------------------------------

double SliceEngine::clampRead (double absPos) const noexcept
{
    const double newest = (double) writePos - 2.0;
    const double oldest = (double) writePos - (double) ringLen + 2.0;
    return juce::jlimit (oldest, newest, absPos);
}

float SliceEngine::readRing (int ch, double absPos) const noexcept
{
    const auto i0 = (juce::int64) std::floor (absPos);
    const float frac = (float) (absPos - (double) i0);
    const int a = (int) (((i0 % ringLen) + ringLen) % ringLen);
    const int b = (a + 1) % ringLen;
    const float* d = ring.getReadPointer (ch);
    return d[a] + (d[b] - d[a]) * frac;
}

float SliceEngine::readCaptured (int ch, double absPos, float live) const noexcept
{
    if (absPos < (double) writePos - writtenSamples() || absPos > (double) writePos - 2.0)
        return live;
    return readRing (ch, absPos);
}

float SliceEngine::osc (int wave, double ph) const noexcept
{
    switch (wave)
    {
        case 1:  return (float) (1.0 - 4.0 * std::abs (ph - 0.5));            // TRI
        case 2:  return ph < 0.5 ? 1.0f : -1.0f;                              // SQR
        case 3:  return (float) (2.0 * ph - 1.0);                             // SAW
        default: return (float) std::sin (ph * juce::MathConstants<double>::twoPi);
    }
}

void SliceEngine::startVoice (const Event& ev, double posBeats, const Controls& c, double bps) noexcept
{
    // steal the oldest if all are busy
    Voice* v = nullptr;
    for (auto& cand : voices) if (! cand.active) { v = &cand; break; }
    if (v == nullptr)
    {
        v = &voices[0];
        for (auto& cand : voices) if (cand.started < v->started) v = &cand;
    }
    const double rate = c.speed * (ev.kind != 0 ? c.dahMult : 1.0);
    const double durS = ev.dur / bps;
    v->atk  = juce::jmax (1.0, c.attackS * sr);
    v->rel  = juce::jmax (1.0, c.releaseS * sr);
    v->hold = juce::jmax (v->atk, durS);
    v->peak = ev.level;
    v->rate = rate;
    v->age  = 0.0;
    v->started = ++voiceClock;
    v->start = loopStart;
    v->len   = juce::jmax (1.0, loopLen);
    if (c.mode == 2)   // SCAN: anywhere the slice fits
        v->off = seedRng.nextDouble() * juce::jmax (1.0, v->len - durS * rate);
    else               // CHOP: where continuous playback of the loop would be
        v->off = std::fmod ((posBeats / bps) * c.speed, v->len);
    v->active = true;
}

// --- the block ---------------------------------------------------------------

void SliceEngine::process (juce::AudioBuffer<float>& io, const Controls& c, const HostPos& h) noexcept
{
    const int n = io.getNumSamples();
    const int nCh = io.getNumChannels();
    if (n <= 0 || ringLen <= 0) return;

    // clock source
    const double bpm = (h.hasTransport && h.bpm > 0.0) ? h.bpm : c.bpmFallback;
    const double bps = bpm / 60.0 / sr;   // beats per sample
    Params P = c.build;
    P.bpm = bpm;

    bool relocate = false;
    if (h.playing && h.hasPpq)
    {
        // a jump beyond what one block could account for = the host relocated
        if (! hostDriven || std::abs (h.ppq - beat) > juce::jmax (0.05, 2.0 * n * bps)) relocate = true;
        beat = h.ppq;
        hostDriven = true;
    }
    else
    {
        hostDriven = false;
    }

    if (restoreFlag)
    {
        restoreFlag = false;
        curMsg = origMsg;
        curSeries = origSeries;
        everBuilt = false;
    }
    if (! everBuilt || P.structurallyDiffers (built))
        rebuild (P);
    else if (publishPending)
        publish();
    // Before any pass boundary the "previous pass" is whatever precedes now —
    // on a fresh instance that's unwritten ring, which readCaptured turns
    // into the live input.
    if (! loopValid) refreshLoop (pass.total, bps);
    if (relocate || passStart > beat || beat >= passStart + pass.total * 4.0)
        anchor (P, c);

    freqSm.setTargetValue (juce::jmax (1.0, c.freqHz));
    levelSm.setTargetValue (c.level);

    const bool tone    = c.source == 0;
    const bool gateIn  = ! tone && c.mode == 0;
    const bool bedMode = tone || gateIn;
    const bool writeRing = ! tone && (! c.freeze || gateIn);
    const bool patternOn = hasPattern (P.pattern);
    const double floorV = bedMode ? (1.0 - c.depth) : 0.0;
    const double upRate   = (1.0 - floorV) / juce::jmax (1.0, c.attackS * sr);
    const double downRate = 1.0 / juce::jmax (1.0, c.releaseS * sr);
    const int releaseSamples = (int) juce::jmax (1.0, c.releaseS * sr);

    float* outL = io.getWritePointer (0);
    float* outR = nCh > 1 ? io.getWritePointer (1) : nullptr;

    for (int i = 0; i < n; ++i)
    {
        const float inL = outL[i];
        const float inR = outR != nullptr ? outR[i] : inL;

        if (writeRing)
        {
            const int w = (int) (writePos % ringLen);
            ring.setSample (0, w, inL);
            ring.setSample (1, w, inR);
            ++writePos;
        }

        // --- sequencer position ---
        double pos = beat - passStart;
        if (pos >= pass.total)
        {
            advancePass (P, c);
            pos = beat - passStart;
            if (pos >= pass.total || pos < 0.0) { anchor (P, c); pos = beat - passStart; }
        }
        while (evIdx < pass.count && pass.events[(size_t) evIdx].t + pass.events[(size_t) evIdx].dur <= pos)
            ++evIdx;
        int act = (evIdx < pass.count && pass.events[(size_t) evIdx].t <= pos) ? evIdx : -1;
        if (! patternOn) act = -1;

        if (act != activeEv)
        {
            const bool sounding = act >= 0 && ! pass.events[(size_t) act].dropped;
            if (resync)
            {
                resync = false;   // adopt without retriggering (knob move mid-hit)
            }
            else if (sounding)
            {
                const auto& ev = pass.events[(size_t) act];
                pitchMult = ev.kind != 0 ? c.dahMult : 1.0;
                tail = 0;
                if (gateIn)
                {
                    bend.active = ev.kind != 0 && std::abs (c.dahMult - 1.0) > 1.0e-6;
                    if (bend.active)
                    {
                        // read faster than real time → start far enough back to end at the head
                        const double durS = ev.dur / bps;
                        const double lookback = juce::jmax (0.0, durS * (c.dahMult - 1.0)) + 2.0;
                        bend.pos = clampRead ((double) writePos - lookback);
                        bend.rate = c.dahMult;
                    }
                }
                else if (! tone)
                {
                    startVoice (ev, pos, c, bps);
                }
            }
            else if (activeEv >= 0)
            {
                tail = releaseSamples;   // hold the dah± until the release has closed
            }
            activeEv = act;
        }
        else if (resync)
        {
            resync = false;
        }
        if (tail > 0 && --tail == 0) { pitchMult = 1.0; bend.active = false; }

        const bool open = act >= 0 && ! pass.events[(size_t) act].dropped;
        const double target = open ? (double) pass.events[(size_t) act].level : floorV;
        if (env < target) env = juce::jmin (target, env + upRate);
        else              env = juce::jmax (target, env - downRate);

        // --- render ---
        float sL = 0.0f, sR = 0.0f;
        if (tone)
        {
            const double f = freqSm.getNextValue() * pitchMult;
            const float s = osc (c.wave, phase);
            phase += f / sr;
            if (phase >= 1.0) phase -= std::floor (phase);
            sL = sR = s * (float) env;
        }
        else if (gateIn)
        {
            float gL = inL, gR = inR;
            if (bend.active)
            {
                gL = readCaptured (0, bend.pos, inL);
                gR = readCaptured (1, bend.pos, inR);
                bend.pos = clampRead (bend.pos + bend.rate);
            }
            sL = gL * (float) env;
            sR = gR * (float) env;
        }
        else
        {
            for (auto& v : voices)
            {
                if (! v.active) continue;
                float e;
                if (v.age < v.atk)               e = v.peak * (float) (v.age / v.atk);
                else if (v.age < v.hold)         e = v.peak;
                else if (v.age < v.hold + v.rel) e = v.peak * (float) (1.0 - (v.age - v.hold) / v.rel);
                else { v.active = false; continue; }
                const double p = v.pos();
                sL += readCaptured (0, p, inL) * e;
                sR += readCaptured (1, p, inR) * e;
                v.age += 1.0;
            }
        }

        const float lv = (float) levelSm.getNextValue();
        outL[i] = sL * lv;
        if (outR != nullptr) outR[i] = sR * lv;

        beat += bps;
    }

    for (int ch = 2; ch < nCh; ++ch) io.clear (ch, 0, n);

    uiBeatA.store (beat, std::memory_order_relaxed);
    uiPassStartA.store (passStart, std::memory_order_relaxed);
    uiTotalA.store (pass.total, std::memory_order_relaxed);
    uiBpmA.store (bpm, std::memory_order_relaxed);
    uiHasPatternA.store (patternOn, std::memory_order_relaxed);
}

} // namespace slice
