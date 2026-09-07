#include "GlitchEngine.h"
#include <cmath>

namespace glitch {

namespace {
    constexpr int   DIST_DRIVE_CEIL[4] = { 6, 4, 5, 8 };
    constexpr float DIST_MEMORY[4]     = { 0.05f, 0.18f, 0.1f, 0.0f };
    constexpr float DIST_POST_LP[4]    = { 0.0f, 0.5f, 0.0f, 0.18f };
    constexpr float DIST_OUT_TRIM[4]   = { 1.0f, 0.9f, 0.65f, 0.55f };
    constexpr int QUANTUM = 128;   // block resolution, as the worklet's render quantum

    // slot indices per stage (order = GlitchStages.h tables)
    enum { CR_BITS = K_STAGE0, CR_RATE, CR_ROT };
    enum { NZ_DRIVE = K_STAGE0, NZ_CUTOFF, NZ_RES, NZ_NOISE, NZ_CV, NZ_CLOCK };
    enum { DR_DRIVE = K_STAGE0, DR_BIAS };
    enum { CH_PERIOD = K_STAGE0, CH_DUTY, CH_EDGE, CH_THRESH };
    enum { GL_LEN = K_STAGE0, GL_COUNT, GL_PITCH, GL_CHANCE };
    enum { FB_AMOUNT = K_STAGE0, FB_DELAY, FB_TONE };
    enum { GM_STUTTER = 0, GM_REVERSE, GM_OCTUP, GM_OCTDN, GM_SILENCE, GM_TAPESTOP, GM_SHUFFLE };
}

// --- Biquad ---
void Biquad::set (bool lowpass, double fc, double q, double sr) noexcept
{
    if (! lowpass && fc <= 1.0) { bypass = true; return; }
    // the top of the hi ladder (20k) is "no low-pass" — a real biquad there
    // leaves residue around every stage
    if (lowpass && (fc >= 20000.0 || fc >= sr * 0.49)) { bypass = true; return; }
    bypass = false;
    const double w0 = 2.0 * juce::MathConstants<double>::pi * juce::jmin (fc, sr * 0.49) / sr;
    const double cw = std::cos (w0), sw = std::sin (w0), al = sw / (2.0 * q);
    double nb0, nb1, nb2;
    if (lowpass) { nb0 = (1 - cw) / 2; nb1 = 1 - cw; nb2 = (1 - cw) / 2; }
    else         { nb0 = (1 + cw) / 2; nb1 = -(1 + cw); nb2 = (1 + cw) / 2; }
    const double a0 = 1 + al;
    b0 = (float) (nb0 / a0); b1 = (float) (nb1 / a0); b2 = (float) (nb2 / a0);
    a1 = (float) (-2 * cw / a0); a2 = (float) ((1 - al) / a0);
}

// --- StageBase ---
void StageBase::prepare (int blockId, const LiveBlock* block, const Vals* v, bool entering) noexcept
{
    hasBlock = block != nullptr;
    key = blockId;
    if (v != nullptr) { vals = *v; haveVals = true; }   // keep the last values while engagement decays out
    if (entering || (! hasBlock && wasBlock)) onBlockChange (hasBlock);
    wasBlock = hasBlock;
    if (v == nullptr) return;
    if (vals.k[K_LO] != lastLo) { hp.set (false, ladder (LO_LADDER, vals.k[K_LO]), 0.707, sr); lastLo = vals.k[K_LO]; }
    if (vals.k[K_HI] != lastHi) { lp.set (true,  ladder (HI_LADDER, vals.k[K_HI]), 0.707, sr); lastHi = vals.k[K_HI]; }
}

void StageBase::tick (float* x, double posFrames) noexcept
{
    const double target = hasBlock ? 1.0 : 0.0;
    eng += (target - eng) * engCoef;
    if (eng < 0.0005 && ! hasBlock) return;
    if (! haveVals) return;
    const float g = (float) eng * vals.k[K_MIX];
    for (int ch = 0; ch < 2; ++ch)
    {
        const float dry = x[ch];
        const float bnd = lp.run (ch, hp.run (ch, dry));
        band[ch] = bnd;
        rest[ch] = dry - bnd;
    }
    processBand (band, posFrames);
    for (int ch = 0; ch < 2; ++ch)
    {
        // rest of the spectrum passes; the band crossfades dry→processed
        const float bandDry = x[ch] - rest[ch];
        x[ch] = rest[ch] + bandDry * (1.0f - g) + band[ch] * g;
    }
}

// --- CRUSH: bits · rate divider · bitrot ---
void Crush::processBand (float* b, double)
{
    const int bits = ladder (BITS_LADDER, vals.k[CR_BITS]);
    const int div = ladder (RATE_DIV_LADDER, vals.k[CR_RATE]);
    const float rot = vals.k[CR_ROT];
    if (--holdCount <= 0)
    {
        holdCount = div;
        const float levels = std::pow (2.0f, (float) (bits - 1));
        for (int ch = 0; ch < 2; ++ch)
        {
            int q = juce::roundToInt (b[ch] * levels);
            // bitrot: flip a random bit in the held word — crackle scaling with rot²
            if (rot > 0.0f && rng.unit() < rot * rot * 0.35)
            {
                const int bitIdx = (int) std::floor (rng.unit() * juce::jmax (1, bits - 1));
                q ^= 1 << bitIdx;
            }
            hold[ch] = juce::jlimit (-1.0f, 1.0f, (float) q / levels);
        }
        // dropouts: rot³ chance per ~10ms of a 5–80ms hole
        if (rot > 0.0f && dropLeft <= 0.0)
        {
            rotCountdown -= div;
            if (rotCountdown <= 0.0)
            {
                rotCountdown = sr * 0.01;
                if (rng.unit() < rot * rot * rot * 0.9) dropLeft = sr * (0.005 + rng.unit() * 0.075);
            }
        }
    }
    const float dropTarget = dropLeft > 0.0 ? 0.0f : 1.0f;
    if (dropLeft > 0.0) dropLeft -= 1.0;
    dropGain += (dropTarget - dropGain) * 0.02f;   // ~1ms edge on the hole
    b[0] = hold[0] * dropGain;
    b[1] = hold[1] * dropGain;
}

// --- NOISE: the Mörser ---
double Noise::fcoef() const noexcept
{
    const double base = 40.0 * std::pow (300.0, (double) vals.k[NZ_CUTOFF]);
    const double fc = juce::jlimit (30.0, juce::jmin (sr * 0.24, 14000.0), base * std::pow (2.0, jit * vals.k[NZ_CV] * 2.0));
    return 2.0 * std::sin (juce::MathConstants<double>::pi * fc / (2.0 * sr));
}

void Noise::processBand (float* b, double)
{
    const double abs = frame++;
    const double clkInterval = juce::jmax (4.0, sr / (0.5 * std::pow (16000.0, (double) vals.k[NZ_CLOCK])));
    bool doTick = false;
    if (vals.seg[1] == 1)   // SIGNAL: the band's zero crossings through a /8 divider
    {
        const float cs = 0.5f * (b[0] + b[1]);
        const float thr = 0.005f + 0.2f * 0.12f;
        const int sign = cs > thr ? 1 : cs < -thr ? -1 : 0;
        if (sign != 0)
        {
            if (xingSign != 0 && sign != xingSign)
                if (++xingCount >= 8) { xingCount = 0; doTick = true; }
            xingSign = sign;
        }
    }
    else if (abs >= nextClock)
    {
        doTick = true;
        nextClock = abs + clkInterval;
    }
    if (doTick)
    {
        for (int ch = 0; ch < 2; ++ch)
        {
            const bool nb = rng.bit();
            if (nb != bit[ch]) { ping[ch] = nb ? 1.0f : -1.0f; bit[ch] = nb; pingLed[ch] = 1.0f; }
        }
        jit = ((rng.s >> 1) & 3u) / 1.5 - 1.0;
    }
    const float fCoef = (float) fcoef();
    const float q = 2.0f * (1.0f - juce::jlimit (0.0f, 0.98f, vals.k[NZ_RES]));
    const float inGain = 1.0f + vals.k[NZ_DRIVE] * 23.0f;
    const float comp = 1.0f / (1.0f + vals.k[NZ_DRIVE] * 1.5f);
    const float pingDecay = (float) std::exp (-1.0 / (0.004 * sr));
    const bool bpOut = vals.seg[0] == 1;
    for (int ch = 0; ch < 2; ++ch)
    {
        const float x = (b[ch] + ping[ch] * vals.k[NZ_NOISE] * 1.4f) * inGain;
        ping[ch] *= pingDecay;
        float lpv = svf[ch][0], bpv = svf[ch][1];
        for (int o = 0; o < 2; ++o)
        {
            const float sq = q * (1.0f + 0.6f * std::abs (bpv));
            lpv = (lpv + fCoef * bpv) * 0.9995f;
            const float hpv = x - lpv - sq * bpv;
            const float t = bpv + fCoef * hpv;
            bpv = std::tanh (t + 0.14f * t * t);
        }
        svf[ch][0] = lpv; svf[ch][1] = bpv;
        const float raw = bpOut ? bpv : lpv;
        float* d = dcb[ch];
        const float tap = raw - d[0] + 0.995f * d[1];
        d[0] = raw; d[1] = tap;
        b[ch] = std::tanh (tap * 2.2f * comp) * 0.9f;
    }
}

// --- DRIVE: BOUM modes ---
float Drive::applyMode (float input, int mode, float bias, float driveN) noexcept
{
    switch (mode)
    {
        case 0: return std::tanh (input * 0.8f);
        case 1: { const float bz = input + bias; const float y = bz >= 0 ? std::tanh (bz * 1.4f) : std::tanh (bz * 0.5f) * 0.6f; return y - bias; }
        case 2:
        {
            const float bz = input + bias;
            float s = bz / (1.0f + std::abs (bz * 0.6f));
            if (s > 0.75f) s = 0.75f + (s - 0.75f) * 0.15f; else if (s < -0.75f) s = -0.75f + (s + 0.75f) * 0.15f;
            return juce::jlimit (-0.9f, 0.9f, s) - bias;
        }
        default: { const float thr = 0.35f * (1.0f - driveN * 0.95f); return std::abs (input) > thr ? (input > 0 ? 0.9f : -0.9f) : 0.0f; }
    }
}

void Drive::processBand (float* b, double)
{
    const int mode = juce::jlimit (0, 3, vals.seg[0]);
    const float driveN = vals.k[DR_DRIVE];
    const float biasN = vals.k[DR_BIAS] * 0.2f;
    const bool asymmetric = mode == 1 || mode == 2;
    const bool oversample = mode >= 2;
    const float mem = DIST_MEMORY[mode], omm = 1.0f - mem;
    const float postLpC = DIST_POST_LP[mode], trim = DIST_OUT_TRIM[mode];
    for (int ch = 0; ch < 2; ++ch)
    {
        const float dMul = ch ? 1.005f : 1.0f, bMul = ch ? 0.995f : 1.0f;
        const float driveLin = (1.0f + driveN * (DIST_DRIVE_CEIL[mode] - 1)) * dMul;
        const float yPre = omm * b[ch] * driveLin + mem * prevY[ch];
        const float dr = asymmetric ? (float) std::sin (drift[ch]) * 0.002f : 0.0f;
        const float bias = asymmetric ? biasN * bMul + dr : 0.0f;
        float y;
        if (oversample)
        {
            const float u0 = (prevX[ch] + yPre) * 0.5f;
            y = (applyMode (u0, mode, bias, driveN) + applyMode (yPre, mode, bias, driveN)) * 0.5f;
        }
        else y = applyMode (yPre, mode, bias, driveN);
        prevX[ch] = yPre;
        if (postLpC > 0.0f) { postLp[ch] += postLpC * (y - postLp[ch]); y = postLp[ch]; }
        y *= trim;
        prevY[ch] = y;
        drift[ch] += 2.0 * juce::MathConstants<double>::pi * (ch ? 0.19 : 0.13) / sr;
        b[ch] = y;
    }
}

// --- CHOP: clocked or threshold gate ---
void Chop::processBand (float* b, double posFrames)
{
    bool open;
    if (vals.seg[0] == 1)   // THRESH
    {
        const float a = juce::jmax (std::abs (b[0]), std::abs (b[1]));
        const float rel = (float) std::exp (-1.0 / (0.025 * sr));
        env = a > env ? a : env * rel;
        const float thrDb = -(1.0f - vals.k[CH_THRESH]) * 60.0f;
        open = env > std::pow (10.0f, thrDb / 20.0f);
    }
    else
    {
        // bar-locked clock: period in grid cells, phase from the pattern position
        const double period = juce::jmax (8.0, ladder (CHOP_PERIOD_LADDER, vals.k[CH_PERIOD]) * cellFrames);
        const double ph = std::fmod (posFrames, period) / period;
        open = ph < vals.k[CH_DUTY];
    }
    const float target = open ? 1.0f : 0.0f;
    const double edgeFrames = vals.k[CH_EDGE] < 0.02f ? 1.0 : vals.k[CH_EDGE] * 0.04 * sr;
    const float coef = (float) juce::jmin (1.0, 1.0 / edgeFrames);
    gain += (target - gain) * (coef >= 1.0f ? 1.0f : coef * 3.0f);
    b[0] *= gain;
    b[1] *= gain;
}

// --- GLITCH: capture + repeat, per-block mode ---
void GlitchRepeat::allocate (double sampleRate)
{
    for (auto& c : cap) c.assign ((size_t) (sampleRate * 8.0), 0.0f);
}

void GlitchRepeat::onBlockChange (bool hasBlk)
{
    // a fresh block re-arms: a new capture starts at its first frame
    phase = hasBlk ? arm : idle;
    rep = 0;
}

void GlitchRepeat::trigger() noexcept
{
    capLen = juce::jmax (64, juce::roundToInt (ladder (GLITCH_LEN_LADDER, vals.k[GL_LEN]) * cellFrames));
    capLen = juce::jmin (capLen, (int) cap[0].size());
    i = 0;
    // dice per capture: hit → record then repeat; miss → dry for one slice, then re-roll
    phase = rng.unit() < vals.k[GL_CHANCE] ? record : miss;
}

void GlitchRepeat::startRepeats() noexcept
{
    phase = repeat;
    rep = 0;
    count = 1 + juce::roundToInt (vals.k[GL_COUNT] * 15.0f);
    startRep();
}

void GlitchRepeat::startRep() noexcept
{
    const int mode = vals.seg[0];
    const int oct = ladder (PITCH_LADDER, vals.k[GL_PITCH]);
    double r = std::pow (2.0, (double) oct);
    if (mode == GM_OCTUP) r *= 2.0;
    if (mode == GM_OCTDN) r *= 0.5;
    if (mode == GM_TAPESTOP) r *= juce::jmax (0.0, 1.0 - (double) rep / juce::jmax (1, count));
    rate = r;
    read = mode == GM_REVERSE ? capLen - 1 : 0;
    if (mode == GM_SHUFFLE)
    {
        // each repeat plays a random sub-slice (¼ to 1 of the capture)
        const int sub = juce::jmax (64, juce::roundToInt (capLen * (0.25 + 0.75 * rng.unit())));
        shufOff = (int) std::floor (rng.unit() * juce::jmax (0, capLen - sub));
        subLen = sub;
    }
    else { subLen = capLen; shufOff = 0; }
    i = 0;
}

void GlitchRepeat::processBand (float* b, double)
{
    if (cap[0].empty()) return;
    if (phase == arm) trigger();
    const double fadeF = juce::jmin (0.002 * sr, capLen * 0.1);
    if (phase == record)
    {
        cap[0][(size_t) i] = b[0];
        cap[1][(size_t) i] = b[1];
        if (++i >= capLen) startRepeats();
        return;   // live pass while recording
    }
    if (phase == miss)
    {
        if (++i >= capLen) trigger();
        return;
    }
    if (phase != repeat) return;
    const int mode = vals.seg[0];
    if (mode == GM_SILENCE || (mode == GM_TAPESTOP && rate <= 0.001)) { b[0] = 0.0f; b[1] = 0.0f; }
    else
    {
        const double e = juce::jmin (1.0, (double) i / fadeF, (double) (subLen - i) / fadeF);
        const double rp = shufOff + read;
        const int i0 = juce::jlimit (0, capLen - 1, (int) rp);
        const int i1 = juce::jmin (capLen - 1, i0 + 1);
        const float fr = (float) (rp - i0);
        for (int ch = 0; ch < 2; ++ch)
        {
            const auto& c = cap[ch];
            b[ch] = (c[(size_t) i0] + (c[(size_t) i1] - c[(size_t) i0]) * fr) * (float) juce::jmax (0.0, e);
        }
        if (mode == GM_REVERSE) { read -= rate; if (read < 0) read += subLen; }
        else                    { read += rate; if (read >= subLen) read -= subLen; }
    }
    if (++i >= subLen)
    {
        if (++rep >= count) trigger();
        else startRep();
    }
}

// --- FEEDBACK ---
void Feedback::allocate (double sampleRate)
{
    for (auto& l : line) l.assign ((size_t) sampleRate, 0.0f);
    w = 0;
}

void Feedback::processBand (float* b, double)
{
    if (line[0].empty()) return;
    const float amt = vals.k[FB_AMOUNT] * 1.2f;
    const int N = (int) line[0].size();
    const int dFrames = juce::jmax (1, juce::roundToInt (ladder (FB_DELAY_LADDER, vals.k[FB_DELAY]) / 1000.0f * (float) sr));
    const double toneHz = 200.0 * std::pow (60.0, (double) vals.k[FB_TONE]);
    const float tc = (float) (1.0 - std::exp (-2.0 * juce::MathConstants<double>::pi * toneHz / sr));
    for (int ch = 0; ch < 2; ++ch)
    {
        const int r = (w - dFrames + N) % N;
        const float fb = line[ch][(size_t) r];
        toneLp[ch] += (fb - toneLp[ch]) * tc;
        // soft clip in the loop keeps runaway bounded — it howls, it doesn't blow up
        const float y = std::tanh (b[ch] + toneLp[ch] * amt);
        line[ch][(size_t) w] = y;
        b[ch] = y;
    }
    w = (w + 1) % N;
}

// --- engine ---
GlitchEngine::GlitchEngine()
{
    for (auto& a : uiEngA) a.store (0.0f);
    for (auto& a : uiPingA) a.store (0.0f);
    buildStages();
}

void GlitchEngine::buildStages()
{
    stCrush    = std::make_unique<Crush>        (seed ^ 0x1111u);
    stNoise    = std::make_unique<Noise>        (seed ^ 0x2222u);
    stDrive    = std::make_unique<Drive>        (seed ^ 0x3333u);
    stChop     = std::make_unique<Chop>         (seed ^ 0x4444u);
    stGlitch   = std::make_unique<GlitchRepeat> (seed ^ 0x5555u);
    stFeedback = std::make_unique<Feedback>     (seed ^ 0x6666u);
    stages[crush] = stCrush.get(); stages[noise] = stNoise.get(); stages[drive] = stDrive.get();
    stages[chop] = stChop.get(); stages[glitchStage] = stGlitch.get(); stages[feedback] = stFeedback.get();
    for (auto* s : stages) s->setSampleRate (sr);
    stGlitch->allocate (sr);
    stFeedback->allocate (sr);
    for (int s = 0; s < numStages; ++s) { stageBlockPass[s] = -1; stageKey[s] = -1; }
}

void GlitchEngine::prepare (double sampleRate, int maxBlock)
{
    sr = sampleRate;
    maxBlockSize = maxBlock;
    levelSm.reset (sr, 0.02);
    buildStages();
    beat = 0.0; lastFrac = 0.0; hostDriven = false; wasPlaying = false;
}

void GlitchEngine::setAuthored (const Pattern& p, juce::uint32 seedHash) noexcept
{
    authored = p;
    haveAuthored = true;
    if (seedHash != seed) { seed = seedHash; buildStages(); mutRng = Rng (seed ^ 0x7777u); }
    applyAuthored();
}

// fresh run: pass 0, accumulators home, stages re-seeded, live = authored
void GlitchEngine::reset() noexcept
{
    pass = 0;
    buildStages();
    mutRng = Rng (seed ^ 0x7777u);
    if (haveAuthored) cloneAuthored();
    publishLive();
}

void GlitchEngine::cloneAuthored() noexcept
{
    const auto& p = authored;
    live.grid = p.grid;
    for (int s = 0; s < numStages; ++s)
    {
        const auto& al = p.lanes[(size_t) s];
        auto& ll = live.lanes[(size_t) s];
        ll.on = al.on && al.count > 0;
        ll.mutate = al.mutate;
        ll.count = 0;
        for (int i = 0; i < al.count && ll.count < maxLiveBlocks; ++i)
        {
            const auto& a = al.blocks[(size_t) i];
            LiveBlock b;
            b.id = a.id; b.src = a.id;
            b.a = (double) a.a / p.grid; b.b = (double) a.b / p.grid;
            b.vals = a.vals; b.acc = a.acc; b.fires = 0;
            ll.blocks[(size_t) ll.count++] = b;
        }
    }
    haveLive = true;
    prevGrid = p.grid;
}

// A new authored pattern arrives on every edit. Keep the live geometry
// (mutation so far) but refresh each block's settings from its authored
// source; add blocks the page drew since, drop blocks it erased. A grid
// change resets the live pattern — cells moved under it.
void GlitchEngine::applyAuthored() noexcept
{
    const auto& p = authored;
    if (! haveLive || prevGrid != p.grid) { cloneAuthored(); publishLive(); return; }
    for (int s = 0; s < numStages; ++s)
    {
        const auto& al = p.lanes[(size_t) s];
        auto& ll = live.lanes[(size_t) s];
        ll.on = al.on && al.count > 0;
        ll.mutate = al.mutate;
        // drop live blocks whose source is gone; refresh the rest
        int out = 0;
        for (int i = 0; i < ll.count; ++i)
        {
            auto b = ll.blocks[(size_t) i];
            const Block* src = nullptr;
            for (int j = 0; j < al.count; ++j) if (al.blocks[(size_t) j].id == b.src) { src = &al.blocks[(size_t) j]; break; }
            if (src == nullptr) continue;
            b.vals = src->vals; b.acc = src->acc;
            ll.blocks[(size_t) out++] = b;
        }
        ll.count = out;
        // add authored blocks no live block follows
        for (int j = 0; j < al.count && ll.count < maxLiveBlocks; ++j)
        {
            const auto& a = al.blocks[(size_t) j];
            bool followed = false;
            for (int i = 0; i < ll.count; ++i) if (ll.blocks[(size_t) i].src == a.id) { followed = true; break; }
            if (followed) continue;
            LiveBlock b;
            b.id = a.id; b.src = a.id; b.a = (double) a.a / p.grid; b.b = (double) a.b / p.grid;
            b.vals = a.vals; b.acc = a.acc; b.fires = 0;
            ll.blocks[(size_t) ll.count++] = b;
        }
        std::sort (ll.blocks.begin(), ll.blocks.begin() + ll.count, [] (const LiveBlock& x, const LiveBlock& y) { return x.a < y.a; });
    }
    publishLive();
}

void GlitchEngine::publishLive() noexcept
{
    const juce::SpinLock::ScopedTryLockType tl (uiLock);
    if (! tl.isLocked()) { publishPending = true; return; }
    publishPending = false;
    uiView.pass = pass;
    for (int s = 0; s < numStages; ++s)
    {
        const auto& ll = live.lanes[(size_t) s];
        auto& lv = uiView.lanes[(size_t) s];
        lv.count = haveLive ? ll.count : 0;
        for (int i = 0; i < lv.count; ++i) lv.blocks[i] = { ll.blocks[(size_t) i].a, ll.blocks[(size_t) i].b, ll.blocks[(size_t) i].src };
    }
    uiView.version = ++uiVersion;
}

bool GlitchEngine::copyLive (LiveView& dst, int& lastVersion)
{
    const juce::SpinLock::ScopedLockType l (uiLock);
    if (uiView.version == lastVersion) return false;
    lastVersion = uiView.version;
    dst.version = uiView.version;
    dst.pass = uiView.pass;
    for (int s = 0; s < numStages; ++s)
    {
        dst.lanes[(size_t) s].count = uiView.lanes[(size_t) s].count;
        for (int i = 0; i < dst.lanes[(size_t) s].count; ++i) dst.lanes[(size_t) s].blocks[i] = uiView.lanes[(size_t) s].blocks[i];
    }
    return true;
}

// One generation step, at the wrap. Per lane, MUTATE is the probability
// mass: blocks shift or resize by a cell, occasionally split; removal is
// easier than addition (Sequence's tie-flip asymmetry) so a lane thins
// rather than saturates.
void GlitchEngine::mutate() noexcept
{
    auto& p = live;
    const int grid = p.grid;
    const double cell = 1.0 / grid;
    auto& rng = mutRng;
    auto snap = [grid] (double v) { return std::round (v * grid) / grid; };
    bool changed = false;
    std::array<LiveBlock, maxLiveBlocks> next;
    for (auto& lane : p.lanes)
    {
        const double m = lane.mutate;
        if (m <= 0.0 || lane.count == 0) continue;
        int n = 0;
        for (int i = 0; i < lane.count; ++i)
        {
            const auto& b = lane.blocks[(size_t) i];
            const double r = rng.unit();
            if (r < m * 0.2 && lane.count > 1) { changed = true; continue; }   // remove
            double a = b.a, e = b.b;
            if (rng.unit() < m * 0.5) { const double d = rng.bit() ? cell : -cell; a = snap (a + d); e = snap (e + d); changed = true; }   // shift
            if (rng.unit() < m * 0.4) { if (rng.bit()) e = snap (e + (rng.bit() ? cell : -cell)); else a = snap (a + (rng.bit() ? cell : -cell)); changed = true; }   // resize
            a = juce::jmax (0.0, a); e = juce::jmin (1.0, e);
            if (e - a < cell * 0.5) { e = juce::jmin (1.0, a + cell); if (e - a < cell * 0.5) a = e - cell; }
            if (rng.unit() < m * 0.15 && e - a >= 2 * cell)   // split
            {
                const double cut = snap (a + cell * (1 + std::floor (rng.unit() * std::round ((e - a) / cell - 1))));
                if (cut > a && cut < e && n + 2 <= maxLiveBlocks)
                {
                    LiveBlock left = b; left.a = a; left.b = cut; next[(size_t) n++] = left;
                    LiveBlock right = b; right.id = liveNextId++; right.a = cut; right.b = e; next[(size_t) n++] = right;
                    changed = true;
                    continue;
                }
            }
            if (n < maxLiveBlocks) { LiveBlock nb = b; nb.a = a; nb.b = e; next[(size_t) n++] = nb; }
        }
        // rare add: a one-cell block on an empty cell
        if (rng.unit() < m * 0.08 && n < maxLiveBlocks)
        {
            const double c = std::floor (rng.unit() * grid) * cell;
            bool occupied = false;
            for (int i = 0; i < n; ++i) if (c >= next[(size_t) i].a && c < next[(size_t) i].b) { occupied = true; break; }
            if (! occupied)
            {
                const LiveBlock& parent = n > 0 ? next[(size_t) (int) std::floor (rng.unit() * n)] : lane.blocks[0];
                LiveBlock nb = parent; nb.id = liveNextId++; nb.a = c; nb.b = c + cell; nb.fires = 0;
                next[(size_t) n++] = nb;
                changed = true;
            }
        }
        // merge overlaps
        std::sort (next.begin(), next.begin() + n, [] (const LiveBlock& x, const LiveBlock& y) { return x.a < y.a; });
        int out = 0;
        for (int i = 0; i < n; ++i)
        {
            if (out > 0 && next[(size_t) i].a < lane.blocks[(size_t) out - 1].b)
                lane.blocks[(size_t) out - 1].b = juce::jmax (lane.blocks[(size_t) out - 1].b, next[(size_t) i].b);
            else
                lane.blocks[(size_t) out++] = next[(size_t) i];
        }
        lane.count = out;
    }
    if (changed) publishLive();
}

const LiveBlock* GlitchEngine::blockAt (const LiveLane& lane, double frac) const noexcept
{
    for (int i = 0; i < lane.count; ++i)
        if (frac >= lane.blocks[(size_t) i].a && frac < lane.blocks[(size_t) i].b) return &lane.blocks[(size_t) i];
    return nullptr;
}

// block values with the accumulator applied: each fire of the block adds
// `step` rungs to the target knob, turning per shape
Vals GlitchEngine::effectiveVals (int stage, const LiveBlock& block, int count) const noexcept
{
    const auto& acc = block.acc;
    if (acc.shape == accOff) return block.vals;
    const int range = 1 + juce::roundToInt (acc.range * 7.0f);
    const int stepRungs = juce::roundToInt ((acc.step - 0.5f) * 8.0f);
    int rung;
    if (range <= 1) rung = 0;
    else if (acc.shape == accHold) rung = juce::jmin (count, range - 1);
    else if (acc.shape == accBounce) { const int period = 2 * (range - 1); const int ph = count % period; rung = ph < range ? ph : period - ph; }
    else rung = count % range;
    Vals v = block.vals;
    const int t = juce::jlimit (0, maxKnobs - 1, acc.target);
    v.k[(size_t) t] = juce::jlimit (0.0f, 1.0f, block.vals.k[(size_t) t] + (float) (rung * stepRungs) * rungUnit (stage, t));
    return v;
}

void GlitchEngine::process (juce::AudioBuffer<float>& io, const Controls& c, const HostPos& h) noexcept
{
    const int n = io.getNumSamples();
    const int nCh = io.getNumChannels();
    if (n <= 0) return;
    float* outL = io.getWritePointer (0);
    float* outR = nCh > 1 ? io.getWritePointer (1) : nullptr;

    // clock
    const bool useHost = c.sync && h.hasTransport;
    const double bpm = (useHost && h.bpm > 0.0) ? h.bpm : c.bpmFallback;
    const double bps = bpm / 60.0 / sr;
    const int beatsPerBar = juce::jmax (1, h.beatsPerBar);
    const double patBeats = (double) juce::jmax (1, c.bars) * beatsPerBar;
    const double patFrames = patBeats / juce::jmax (1.0e-9, bps);
    const bool playing = useHost && h.playing && h.hasPpq;
    if (playing)
    {
        beat = h.ppq;
        hostDriven = true;
    }
    else hostDriven = false;
    // transport start = a fresh run (the page's PLAY)
    if (playing && ! wasPlaying) { resetFlag = true; startedFlag.store (true); }
    wasPlaying = playing;

    if (resetFlag) { resetFlag = false; reset(); }
    else if (publishPending) publishLive();

    levelSm.setTargetValue (c.level);

    if (! haveLive || ! haveAuthored)
    {
        for (int i = 0; i < n; ++i) { const float lv = levelSm.getNextValue(); outL[i] *= lv; if (outR) outR[i] *= lv; }
        return;
    }

    const double cellFrames = patFrames / juce::jmax (1, live.grid);
    for (auto* s : stages) s->cellFrames = cellFrames;

    double frac = std::fmod (beat, patBeats) / patBeats;
    if (frac < 0.0) frac += 1.0;
    // the host looping back (or a relocate to an earlier bar) is a wrap too: a new generation
    if (hostDriven && frac < lastFrac - 0.5) { ++pass; mutate(); }
    const double dFrac = bps / patBeats;

    float x[2];
    float peakL = 0.0f;
    for (int i0 = 0; i0 < n; i0 += QUANTUM)
    {
        const int end = juce::jmin (n, i0 + QUANTUM);
        // resolve the block under the head per stage for this quantum
        for (int s = 0; s < numStages; ++s)
        {
            auto* st = stages[s];
            auto& lane = live.lanes[(size_t) s];
            if (! lane.on) { st->prepare (-1, nullptr, nullptr, false); stageKey[s] = -1; continue; }
            auto* blk = const_cast<LiveBlock*> (blockAt (lane, frac));
            if (blk == nullptr) { st->prepare (-1, nullptr, nullptr, false); stageKey[s] = -1; continue; }
            // the block FIRES when the head enters it, and again on every new
            // pass. First entry reads rung 0 (home); the count advances after.
            const bool entering = stageKey[s] != blk->id || stageBlockPass[s] != pass;
            int rung = blk->fires;
            if (entering) { rung = blk->fires; blk->fires = rung + 1; }
            else rung = juce::jmax (0, blk->fires - 1);
            stageKey[s] = blk->id;
            stageBlockPass[s] = pass;
            const Vals ev = effectiveVals (s, *blk, rung);
            st->prepare (blk->id, blk, &ev, entering);
        }
        for (int i = i0; i < end; ++i)
        {
            x[0] = outL[i]; x[1] = outR != nullptr ? outR[i] : outL[i];
            const double posFrames = frac * patFrames;
            for (auto* s : stages) s->tick (x, posFrames);
            const float lv = levelSm.getNextValue();
            outL[i] = x[0] * lv;
            if (outR != nullptr) outR[i] = x[1] * lv;
            peakL = juce::jmax (peakL, std::abs (x[0]));
            frac += dFrac;
            if (frac >= 1.0)
            {
                frac -= 1.0;
                ++pass;
                mutate();
            }
        }
    }
    beat += n * bps;
    lastFrac = frac;

    for (int ch = 2; ch < nCh; ++ch) io.clear (ch, 0, n);

    uiFracA.store (frac, std::memory_order_relaxed);
    uiPassA.store (pass, std::memory_order_relaxed);
    uiBpmA.store (bpm, std::memory_order_relaxed);
    for (int s = 0; s < numStages; ++s) uiEngA[(size_t) s].store (stages[s]->engagement(), std::memory_order_relaxed);
    uiPingA[0].store (stNoise->pingLed[0], std::memory_order_relaxed);
    uiPingA[1].store (stNoise->pingLed[1], std::memory_order_relaxed);
    stNoise->pingLed[0] = 0.0f; stNoise->pingLed[1] = 0.0f;
}

} // namespace glitch
