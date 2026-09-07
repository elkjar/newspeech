#include "GlitchProcessor.h"
#include "GlitchEditor.h"

juce::AudioProcessorValueTreeState::ParameterLayout GlitchProcessor::createLayout()
{
    using namespace juce;
    AudioProcessorValueTreeState::ParameterLayout L;
    L.add (std::make_unique<AudioParameterBool>   (ParameterID { "sync",  1 }, "CLOCK/sync",  true));
    L.add (std::make_unique<AudioParameterFloat>  (ParameterID { "bpm",   1 }, "CLOCK/bpm",   NormalisableRange<float> (20.0f, 300.0f), 120.0f));
    L.add (std::make_unique<AudioParameterChoice> (ParameterID { "bars",  1 }, "CLOCK/bars",  StringArray { "1", "2", "4", "8" }, 2));
    L.add (std::make_unique<AudioParameterChoice> (ParameterID { "grid",  1 }, "CLOCK/grid",  StringArray { "1/8", "1/16", "1/32" }, 1));
    L.add (std::make_unique<AudioParameterBool>   (ParameterID { "auto",  1 }, "SEED/auto",   false));
    L.add (std::make_unique<AudioParameterFloat>  (ParameterID { "level", 1 }, "OUT/level",   NormalisableRange<float> (0.0f, 1.5f), 1.0f));
    return L;
}

GlitchProcessor::GlitchProcessor()
    : AudioProcessor (BusesProperties().withInput ("Input", juce::AudioChannelSet::stereo(), true)
                                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "GLITCH", createLayout())
{
    pSync = apvts.getRawParameterValue ("sync"); pBpm = apvts.getRawParameterValue ("bpm");
    pBars = apvts.getRawParameterValue ("bars"); pGrid = apvts.getRawParameterValue ("grid");
    pLevel = apvts.getRawParameterValue ("level"); pAuto = apvts.getRawParameterValue ("auto");
    apvts.addParameterListener ("bars", this);
    apvts.addParameterListener ("grid", this);

    lastCellsPerBar = cellsPerBar(); lastBars = barsCount();
    glitch::resetPattern (authored, lastBars * lastCellsPerBar);
    // first open: a seed populates an empty grid so the plugin is audible at once
    seedStr = glitch::randomSeed();
    glitch::seedGrid (authored, seedStr);
    pushMailbox();
}

GlitchProcessor::~GlitchProcessor()
{
    apvts.removeParameterListener ("bars", this);
    apvts.removeParameterListener ("grid", this);
}

int GlitchProcessor::cellsPerBar() const noexcept { return gridOptions[juce::jlimit (0, 2, (int) std::lround (pGrid->load()))]; }
int GlitchProcessor::barsCount() const noexcept   { return barsOptions[juce::jlimit (0, 3, (int) std::lround (pBars->load()))]; }

void GlitchProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    glitchEngine.prepare (sampleRate, samplesPerBlock);
    mailSeen = -1;
}

bool GlitchProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto in = layouts.getMainInputChannelSet(), out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo()) return false;
    if (in != juce::AudioChannelSet::mono() && in != juce::AudioChannelSet::stereo()) return false;
    return true;
}

// --- model ---
void GlitchProcessor::patternEdited() { pushMailbox(); }

void GlitchProcessor::pushMailbox()
{
    const juce::SpinLock::ScopedLockType l (mailLock);
    mailPattern = authored;
    mailSeed = glitch::seedFromString (seedStr);
    mailVersion.fetch_add (1, std::memory_order_release);
}

void GlitchProcessor::applySeed (const juce::String& s)
{
    seedStr = s.isEmpty() ? glitch::randomSeed() : s;
    glitch::seedGrid (authored, seedStr);
    pushMailbox();
}

void GlitchProcessor::newSeed() { applySeed (glitch::randomSeed()); }

void GlitchProcessor::adoptLive (const glitch::LiveView& live)
{
    const int grid = authored.grid;
    for (int s = 0; s < glitch::numStages; ++s)
    {
        auto& lane = authored.lanes[(size_t) s];
        const auto& lv = live.lanes[(size_t) s];
        std::array<glitch::Block, glitch::maxBlocks> old = lane.blocks;
        const int oldCount = lane.count;
        lane.count = 0;
        for (int i = 0; i < lv.count && lane.count < glitch::maxBlocks; ++i)
        {
            const auto& b = lv.blocks[i];
            const glitch::Block* src = nullptr;
            for (int j = 0; j < oldCount; ++j) if (old[(size_t) j].id == b.src) { src = &old[(size_t) j]; break; }
            const int a = juce::jlimit (0, grid - 1, juce::roundToInt (b.a * grid));
            const int bb = juce::jlimit (a + 1, grid, juce::roundToInt (b.b * grid));
            glitch::Block nb = glitch::makeBlock (authored, s, a, bb);
            if (src != nullptr) { nb.vals = src->vals; nb.acc = src->acc; }
            lane.blocks[(size_t) lane.count++] = nb;
        }
        glitch::normalizeLane (lane);
    }
    pushMailbox();
}

// BARS / GRID changes reshape the cell count: GRID rescales spans (cells moved
// under them), BARS keeps cell positions and adds or clips room.
void GlitchProcessor::parameterChanged (const juce::String&, float)
{
    cellsDirty.store (true);
    triggerAsyncUpdate();
}

void GlitchProcessor::syncCellCount()
{
    const int cpb = cellsPerBar(), bars = barsCount();
    if (cpb != lastCellsPerBar)
    {
        glitch::regridPattern (authored, lastBars * cpb);
        lastCellsPerBar = cpb;
    }
    if (bars != lastBars)
    {
        glitch::resizePatternCells (authored, bars * cpb);
        lastBars = bars;
    }
    pushMailbox();
}

void GlitchProcessor::handleAsyncUpdate()
{
    if (cellsDirty.exchange (false)) syncCellCount();
    if (autoSeedDue.exchange (false)) newSeed();
}

// --- audio ---
void GlitchProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    lastBlockMs.store (juce::Time::getMillisecondCounter(), std::memory_order_relaxed);

    const int v = mailVersion.load (std::memory_order_acquire);
    if (v != mailSeen)
    {
        const juce::SpinLock::ScopedTryLockType tl (mailLock);
        if (tl.isLocked())
        {
            audioPattern = mailPattern;
            mailSeen = v;
            glitchEngine.setAuthored (audioPattern, mailSeed);
        }
    }

    glitch::Controls c;
    c.sync = pSync->load() >= 0.5f;
    c.bpmFallback = pBpm->load();
    c.bars = barsCount();
    c.level = pLevel->load();

    glitch::HostPos h;
    if (auto* ph = getPlayHead())
        if (auto pos = ph->getPosition())
        {
            h.hasTransport = true;
            h.playing = pos->getIsPlaying();
            if (auto b = pos->getBpm()) h.bpm = *b;
            if (auto p = pos->getPpqPosition()) { h.hasPpq = true; h.ppq = *p; }
            if (auto ts = pos->getTimeSignature()) h.beatsPerBar = juce::jmax (1, ts->numerator);
        }

    if (getTotalNumInputChannels() == 1 && buffer.getNumChannels() > 1)
        buffer.copyFrom (1, 0, buffer, 0, 0, buffer.getNumSamples());

    glitchEngine.process (buffer, c, h);

    if (glitchEngine.transportStarted() && pAuto->load() >= 0.5f) { autoSeedDue.store (true); triggerAsyncUpdate(); }

    nsTelemetry.hasTransport.store (h.hasTransport, std::memory_order_relaxed);
    nsTelemetry.playing.store (h.playing, std::memory_order_relaxed);
    nsTelemetry.bpm.store (glitchEngine.uiBpm(), std::memory_order_relaxed);
    hostBpmA.store (c.sync ? h.bpm : 0.0, std::memory_order_relaxed);
    float peak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        peak = juce::jmax (peak, buffer.getMagnitude (ch, 0, buffer.getNumSamples()));
    nsTelemetry.pushPeak (peak);
}

// --- state ---
void GlitchProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    auto state = apvts.copyState();
    state.setProperty ("pattern", juce::JSON::toString (glitch::patternToVar (authored), true), nullptr);
    state.setProperty ("seed", seedStr, nullptr);
    if (auto xml = state.createXml()) copyXmlToBinary (*xml, dest);
}

void GlitchProcessor::setStateInformation (const void* data, int size)
{
    if (auto xml = getXmlFromBinary (data, size))
    {
        if (! xml->hasTagName (apvts.state.getType())) return;
        auto tree = juce::ValueTree::fromXml (*xml);
        apvts.replaceState (tree);
        lastCellsPerBar = cellsPerBar(); lastBars = barsCount();
        if (tree.hasProperty ("seed")) seedStr = tree.getProperty ("seed").toString();
        glitch::Pattern p;
        if (tree.hasProperty ("pattern") && glitch::patternFromVar (juce::JSON::parse (tree.getProperty ("pattern").toString()), p))
        {
            authored = p;
            if (authored.grid != lastBars * lastCellsPerBar) glitch::regridPattern (authored, lastBars * lastCellsPerBar);
        }
        cellsDirty.store (false);
        pushMailbox();
    }
}

juce::AudioProcessorEditor* GlitchProcessor::createEditor() { return new GlitchEditor (*this); }

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new GlitchProcessor(); }
