#include "GlitchStages.h"
#include <algorithm>

namespace glitch {

void resetPattern (Pattern& p, int grid)
{
    p.grid = grid;
    p.nextId = 1;
    for (int s = 0; s < numStages; ++s)
    {
        auto& l = p.lanes[(size_t) s];
        l.on = true; l.mutate = 0.0f; l.count = 0;
        l.defaults = defaultVals (s);
    }
}

void normalizeLane (Lane& l)
{
    std::sort (l.blocks.begin(), l.blocks.begin() + l.count, [] (const Block& x, const Block& y) { return x.a < y.a; });
    int out = 0;
    for (int i = 0; i < l.count; ++i)
    {
        if (out > 0 && l.blocks[(size_t) i].a < l.blocks[(size_t) out - 1].b)
            l.blocks[(size_t) out - 1].b = juce::jmax (l.blocks[(size_t) out - 1].b, l.blocks[(size_t) i].b);
        else
            l.blocks[(size_t) out++] = l.blocks[(size_t) i];
    }
    l.count = out;
}

void regridPattern (Pattern& p, int newGrid)
{
    const double f = (double) newGrid / (double) p.grid;
    for (auto& l : p.lanes)
    {
        for (int i = 0; i < l.count; ++i)
        {
            auto& b = l.blocks[(size_t) i];
            b.a = juce::roundToInt (b.a * f);
            b.b = juce::jmax (b.a + 1, juce::roundToInt (b.b * f));
            b.a = juce::jlimit (0, newGrid - 1, b.a);
            b.b = juce::jlimit (b.a + 1, newGrid, b.b);
        }
        normalizeLane (l);
    }
    p.grid = newGrid;
}

void resizePatternCells (Pattern& p, int newGrid)
{
    for (auto& l : p.lanes)
    {
        int out = 0;
        for (int i = 0; i < l.count; ++i)
        {
            auto b = l.blocks[(size_t) i];
            if (b.a >= newGrid) continue;
            b.b = juce::jmin (b.b, newGrid);
            l.blocks[(size_t) out++] = b;
        }
        l.count = out;
        normalizeLane (l);
    }
    p.grid = newGrid;
}

Block makeBlock (Pattern& p, int stage, int a, int b)
{
    Block blk;
    blk.id = p.nextId++;
    blk.a = a; blk.b = b;
    blk.vals = p.lanes[(size_t) stage].defaults;
    blk.acc = Acc {};
    blk.acc.target = K_STAGE0;
    return blk;
}

juce::String randomSeed()
{
    juce::Random r;
    return juce::String::toHexString ((int) (r.nextInt (0x1000000))).paddedLeft ('0', 6);
}

// the page's seedRng: FNV-1a of the string, ^ 0x5eed, xorshift32
namespace {
    struct SeedRng
    {
        juce::uint32 r;
        explicit SeedRng (const juce::String& s) noexcept : r (seedFromString (s) ^ 0x5eedu) {}
        double operator()() noexcept { r ^= r << 13; r ^= r >> 17; r ^= r << 5; return r / 4294967296.0; }
    };
    struct Shape { double p; int n0, n1, len0, len1; };
    // how likely each lane takes part, how many blocks, how long (cells at ÷64):
    // small glitches, not slabs — the seed scatters hits, the hand draws slabs
    constexpr Shape SEED_SHAPE[numStages] = {
        { 0.7,  2, 5, 1, 6 },   // crush
        { 0.45, 1, 3, 1, 4 },   // noise
        { 0.6,  2, 5, 1, 6 },   // drive
        { 0.6,  2, 5, 1, 4 },   // chop
        { 0.9,  4, 10, 1, 3 },  // glitch
        { 0.4,  1, 3, 1, 4 },   // feedback
    };
}

void seedGrid (Pattern& p, const juce::String& seed)
{
    SeedRng rnd (seed);
    auto between = [&] (int lo, int hi) { return lo + (int) std::floor (rnd() * (hi - lo + 1)); };
    const double scale = p.grid / 64.0;
    for (int s = 0; s < numStages; ++s)
    {
        auto& lane = p.lanes[(size_t) s];
        lane.count = 0;
        const auto& shape = SEED_SHAPE[s];
        if (rnd() > shape.p) continue;
        const int count = between (shape.n0, shape.n1);
        const auto& st = stageSpec (s);
        for (int k = 0; k < count && lane.count < maxBlocks; ++k)
        {
            const int len = juce::jmax (1, juce::roundToInt (between (shape.len0, shape.len1) * scale));
            const int a = (int) std::floor (rnd() * juce::jmax (1, p.grid - len + 1));
            Block b = makeBlock (p, s, a, juce::jmin (p.grid, a + len));
            // settings: stepped knobs land on a random rung, continuous ones wander
            // ±25% from the lane default; switches pick any option
            for (int i = 0; i < st.numKnobs; ++i)
            {
                const auto& spec = st.knobs[i];
                if (juce::String (spec.key) == "thresh") continue;
                const int slot = K_STAGE0 + i;
                if (spec.steps > 1) b.vals.k[(size_t) slot] = (float) (std::round (rnd() * (spec.steps - 1)) / (spec.steps - 1));
                else b.vals.k[(size_t) slot] = juce::jlimit (0.0f, 1.0f, lane.defaults.k[(size_t) slot] + (float) ((rnd() - 0.5) * 0.5));
            }
            for (int i = 0; i < st.numSegs; ++i)
                b.vals.seg[(size_t) i] = (int) std::floor (rnd() * st.segs[i].count);
            // one in five blocks accumulates
            if (rnd() < 0.2)
            {
                const int shapes[3] = { accWrap, accBounce, accHold };
                b.acc.shape = shapes[(int) std::floor (rnd() * 3)];
                b.acc.target = K_STAGE0 + (int) std::floor (rnd() * st.numKnobs);
                b.acc.step = 0.5f + (rnd() < 0.5 ? 1.0f : -1.0f) / 8.0f;
                const int ranges[3] = { 2, 3, 4 };
                b.acc.range = ranges[(int) std::floor (rnd() * 3)] / 7.0f;
            }
            lane.blocks[(size_t) lane.count++] = b;
        }
        normalizeLane (lane);
    }
}

// --- JSON ---
namespace {
    juce::var valsToVar (int stage, const Vals& v)
    {
        auto* o = new juce::DynamicObject();
        for (int s = 0; s < numSlots (stage); ++s) o->setProperty (slotSpec (stage, s)->key, v.k[(size_t) s]);
        const auto& st = stageSpec (stage);
        for (int i = 0; i < st.numSegs; ++i) o->setProperty (st.segs[i].key, v.seg[(size_t) i]);
        return juce::var (o);
    }
    void valsFromVar (int stage, const juce::var& in, Vals& v)
    {
        v = defaultVals (stage);
        if (auto* o = in.getDynamicObject())
        {
            for (int s = 0; s < numSlots (stage); ++s)
                if (o->hasProperty (slotSpec (stage, s)->key)) v.k[(size_t) s] = juce::jlimit (0.0f, 1.0f, (float) o->getProperty (slotSpec (stage, s)->key));
            const auto& st = stageSpec (stage);
            for (int i = 0; i < st.numSegs; ++i)
                if (o->hasProperty (st.segs[i].key)) v.seg[(size_t) i] = juce::jlimit (0, st.segs[i].count - 1, (int) o->getProperty (st.segs[i].key));
        }
    }
    const char* accNames[] = { "off", "wrap", "bounce", "hold" };
}

juce::var patternToVar (const Pattern& p)
{
    auto* root = new juce::DynamicObject();
    root->setProperty ("grid", p.grid);
    juce::Array<juce::var> lanes;
    for (int s = 0; s < numStages; ++s)
    {
        const auto& l = p.lanes[(size_t) s];
        auto* lo = new juce::DynamicObject();
        lo->setProperty ("stage", stageSpec (s).id);
        lo->setProperty ("on", l.on);
        lo->setProperty ("mutate", l.mutate);
        lo->setProperty ("defaults", valsToVar (s, l.defaults));
        juce::Array<juce::var> blocks;
        for (int i = 0; i < l.count; ++i)
        {
            const auto& b = l.blocks[(size_t) i];
            auto* bo = new juce::DynamicObject();
            bo->setProperty ("id", b.id);
            bo->setProperty ("a", b.a);
            bo->setProperty ("b", b.b);
            bo->setProperty ("vals", valsToVar (s, b.vals));
            auto* ao = new juce::DynamicObject();
            ao->setProperty ("shape", accNames[juce::jlimit (0, 3, b.acc.shape)]);
            ao->setProperty ("target", slotSpec (s, b.acc.target) != nullptr ? slotSpec (s, b.acc.target)->key : "");
            ao->setProperty ("step", b.acc.step);
            ao->setProperty ("range", b.acc.range);
            bo->setProperty ("acc", juce::var (ao));
            blocks.add (juce::var (bo));
        }
        lo->setProperty ("blocks", blocks);
        lanes.add (juce::var (lo));
    }
    root->setProperty ("lanes", lanes);
    root->setProperty ("nextId", p.nextId);
    return juce::var (root);
}

bool patternFromVar (const juce::var& in, Pattern& p)
{
    auto* root = in.getDynamicObject();
    if (root == nullptr) return false;
    resetPattern (p, juce::jlimit (8, 512, (int) root->getProperty ("grid")));
    p.nextId = juce::jmax (1, (int) root->getProperty ("nextId"));
    auto* lanes = root->getProperty ("lanes").getArray();
    if (lanes == nullptr) return false;
    for (int s = 0; s < numStages && s < lanes->size(); ++s)
    {
        auto* lo = (*lanes)[s].getDynamicObject();
        if (lo == nullptr) continue;
        auto& l = p.lanes[(size_t) s];
        l.on = (bool) lo->getProperty ("on");
        l.mutate = juce::jlimit (0.0f, 1.0f, (float) lo->getProperty ("mutate"));
        valsFromVar (s, lo->getProperty ("defaults"), l.defaults);
        l.count = 0;
        if (auto* blocks = lo->getProperty ("blocks").getArray())
            for (const auto& bv : *blocks)
            {
                if (l.count >= maxBlocks) break;
                auto* bo = bv.getDynamicObject();
                if (bo == nullptr) continue;
                Block b;
                b.id = (int) bo->getProperty ("id");
                if (b.id <= 0) b.id = p.nextId++;
                b.a = juce::jlimit (0, p.grid - 1, (int) bo->getProperty ("a"));
                b.b = juce::jlimit (b.a + 1, p.grid, (int) bo->getProperty ("b"));
                valsFromVar (s, bo->getProperty ("vals"), b.vals);
                if (auto* ao = bo->getProperty ("acc").getDynamicObject())
                {
                    const auto shape = ao->getProperty ("shape").toString();
                    for (int k = 0; k < 4; ++k) if (shape == accNames[k]) b.acc.shape = k;
                    const auto tgt = ao->getProperty ("target").toString();
                    for (int k = 0; k < numSlots (s); ++k) if (tgt == slotSpec (s, k)->key) b.acc.target = k;
                    b.acc.step = juce::jlimit (0.0f, 1.0f, (float) ao->getProperty ("step"));
                    b.acc.range = juce::jlimit (0.0f, 1.0f, (float) ao->getProperty ("range"));
                }
                p.nextId = juce::jmax (p.nextId, b.id + 1);
                l.blocks[(size_t) l.count++] = b;
            }
        normalizeLane (l);
    }
    return true;
}

} // namespace glitch
