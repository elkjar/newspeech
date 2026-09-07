#include "SliceProcessor.h"
#include "SliceEditor.h"

namespace {
    juce::NormalisableRange<float> logRange (float lo, float hi, float centre)
    {
        juce::NormalisableRange<float> r (lo, hi);
        r.setSkewForCentre (centre);
        return r;
    }
    constexpr double DIVS[4]  = { 1.0, 0.5, 0.25, 0.125 };
    constexpr double FEELS[3] = { 1.0, 2.0 / 3.0, 1.5 };
}

juce::AudioProcessorValueTreeState::ParameterLayout SliceProcessor::createLayout()
{
    using namespace juce;
    using F = AudioParameterFloat;
    using C = AudioParameterChoice;
    using B = AudioParameterBool;
    using I = AudioParameterInt;
    juce::AudioProcessorValueTreeState::ParameterLayout L;

    // PATTERN — the message and how it becomes time
    L.add (std::make_unique<C> (ParameterID { "pattern", 1 }, "PATTERN/pattern", StringArray { "MORSE", "BITS", "DATA" }, 0));
    L.add (std::make_unique<F> (ParameterID { "dah",     1 }, "PATTERN/dah",    NormalisableRange<float> (0.5f, 6.0f), 3.0f));
    L.add (std::make_unique<F> (ParameterID { "gap",     1 }, "PATTERN/gap",    NormalisableRange<float> (0.0f, 4.0f), 1.0f));
    L.add (std::make_unique<F> (ParameterID { "letter",  1 }, "PATTERN/letter", NormalisableRange<float> (0.0f, 8.0f), 3.0f));
    L.add (std::make_unique<F> (ParameterID { "word",    1 }, "PATTERN/word",   NormalisableRange<float> (0.0f, 16.0f), 7.0f));
    L.add (std::make_unique<F> (ParameterID { "thresh",  1 }, "PATTERN/thresh", NormalisableRange<float> (0.0f, 1.0f), 0.35f));

    // CLOCK — SYNC on: host tempo + grid. Off: free-run at the BPM knob, ignoring the transport.
    L.add (std::make_unique<B> (ParameterID { "sync", 1 }, "CLOCK/sync", true));
    L.add (std::make_unique<F> (ParameterID { "bpm",  1 }, "CLOCK/bpm",  NormalisableRange<float> (20.0f, 300.0f), 120.0f));
    L.add (std::make_unique<C> (ParameterID { "rate", 1 }, "CLOCK/rate", StringArray { "1/4", "1/8", "1/16", "1/32" }, 2));
    L.add (std::make_unique<C> (ParameterID { "feel", 1 }, "CLOCK/feel", StringArray { "STRAIGHT", "TRIPLET", "DOTTED" }, 0));

    // SOURCE
    L.add (std::make_unique<C> (ParameterID { "source",   1 }, "SOURCE/source",   StringArray { "TONE", "INPUT" }, 1));
    L.add (std::make_unique<C> (ParameterID { "wave",     1 }, "SOURCE/wave",     StringArray { "SIN", "TRI", "SQR", "SAW" }, 0));
    L.add (std::make_unique<F> (ParameterID { "freq",     1 }, "SOURCE/freq",     logRange (40.0f, 10000.0f, 600.0f), 600.0f));
    L.add (std::make_unique<I> (ParameterID { "dahpitch", 1 }, "SOURCE/dahpitch", -24, 24, 0));

    // CAPTURE (INPUT only)
    L.add (std::make_unique<C> (ParameterID { "mode",   1 }, "CAPTURE/mode",   StringArray { "GATE", "CHOP", "SCAN" }, 0));
    L.add (std::make_unique<B> (ParameterID { "freeze", 1 }, "CAPTURE/freeze", false));
    L.add (std::make_unique<F> (ParameterID { "speed",  1 }, "CAPTURE/speed",  logRange (0.25f, 4.0f, 1.0f), 1.0f));

    // SHAPE
    L.add (std::make_unique<F> (ParameterID { "attack",  1 }, "SHAPE/attack",  logRange (0.5f, 500.0f, 15.8f), 2.0f));
    L.add (std::make_unique<F> (ParameterID { "release", 1 }, "SHAPE/release", logRange (1.0f, 1000.0f, 31.6f), 30.0f));
    L.add (std::make_unique<F> (ParameterID { "depth",   1 }, "SHAPE/depth",   NormalisableRange<float> (0.0f, 1.0f), 1.0f));
    L.add (std::make_unique<F> (ParameterID { "level",   1 }, "SHAPE/level",   NormalisableRange<float> (0.0f, 1.5f), 1.0f));

    // MANGLE
    L.add (std::make_unique<F> (ParameterID { "flip",     1 }, "MANGLE/flip",     NormalisableRange<float> (0.0f, 1.0f), 0.0f));
    L.add (std::make_unique<F> (ParameterID { "ratchet",  1 }, "MANGLE/ratchet",  NormalisableRange<float> (0.0f, 1.0f), 0.0f));
    L.add (std::make_unique<F> (ParameterID { "drop",     1 }, "MANGLE/drop",     NormalisableRange<float> (0.0f, 1.0f), 0.0f));
    L.add (std::make_unique<F> (ParameterID { "scramble", 1 }, "MANGLE/scramble", NormalisableRange<float> (0.0f, 1.0f), 0.0f));
    L.add (std::make_unique<B> (ParameterID { "decay",    1 }, "MANGLE/decay",    true));
    return L;
}

SliceProcessor::SliceProcessor()
    : AudioProcessor (BusesProperties().withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                                       .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "SLICE", createLayout())
{
    auto raw = [this] (const char* id) { return apvts.getRawParameterValue (id); };
    pPattern = raw ("pattern"); pDah = raw ("dah"); pGap = raw ("gap"); pLetter = raw ("letter"); pWord = raw ("word"); pThresh = raw ("thresh");
    pSync = raw ("sync"); pBpm = raw ("bpm"); pRate = raw ("rate"); pFeel = raw ("feel");
    pSource = raw ("source"); pWave = raw ("wave"); pFreq = raw ("freq"); pDahPitch = raw ("dahpitch");
    pMode = raw ("mode"); pFreeze = raw ("freeze"); pSpeed = raw ("speed");
    pAttack = raw ("attack"); pRelease = raw ("release"); pDepth = raw ("depth"); pLevel = raw ("level");
    pFlip = raw ("flip"); pRatchet = raw ("ratchet"); pDrop = raw ("drop"); pScramble = raw ("scramble"); pDecay = raw ("decay");

    pushMailbox();
}

void SliceProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    sliceEngine.prepare (sampleRate, samplesPerBlock);
    mailSeen = -1;   // re-deliver the text after a reset
}

bool SliceProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto in  = layouts.getMainInputChannelSet();
    const auto out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo()) return false;
    if (in.isDisabled()) return true;   // a synth-style insert with no input still makes TONE
    if (in != juce::AudioChannelSet::mono() && in != juce::AudioChannelSet::stereo()) return false;
    return true;
}

// --- text mailbox ---

void SliceProcessor::setInputText (const juce::String& s, bool isData)
{
    {
        const juce::ScopedLock l (textLock);
        (isData ? dataInput : textInput) = s;
    }
    pushMailbox();
}

juce::String SliceProcessor::getInputText (bool isData) const
{
    const juce::ScopedLock l (textLock);
    return isData ? dataInput : textInput;
}

void SliceProcessor::pushMailbox()
{
    juce::String t, d;
    {
        const juce::ScopedLock l (textLock);
        t = textInput; d = dataInput;
    }
    const juce::SpinLock::ScopedLockType ml (mailLock);
    mailText.fill (0); mailData.fill (0);
    t.copyToUTF8 (mailText.data(), (size_t) textCapacity);
    d.copyToUTF8 (mailData.data(), (size_t) dataCapacity);
    mailVersion.fetch_add (1, std::memory_order_release);
}

// --- audio ---

void SliceProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    // new text from the editor?
    const int v = mailVersion.load (std::memory_order_acquire);
    if (v != mailSeen)
    {
        const juce::SpinLock::ScopedTryLockType tl (mailLock);
        if (tl.isLocked())
        {
            audioText = mailText;
            audioData = mailData;
            mailSeen = v;
            sliceEngine.setInput (audioText.data(), audioData.data());
        }
    }
    if (restoreFlag.exchange (false, std::memory_order_acq_rel))
        sliceEngine.restore();

    slice::Controls c;
    const int rate = juce::jlimit (0, 3, (int) std::lround (pRate->load()));
    const int feel = juce::jlimit (0, 2, (int) std::lround (pFeel->load()));
    c.build.pattern   = (slice::Pattern) juce::jlimit (0, 2, (int) std::lround (pPattern->load()));
    c.build.unitBeats = DIVS[rate] * FEELS[feel];
    c.build.dah = pDah->load(); c.build.gap = pGap->load(); c.build.letter = pLetter->load(); c.build.word = pWord->load();
    c.build.thresh = pThresh->load();
    c.build.flip = pFlip->load(); c.build.ratchet = pRatchet->load(); c.build.drop = pDrop->load();
    c.source = (int) std::lround (pSource->load());
    c.wave   = (int) std::lround (pWave->load());
    c.mode   = (int) std::lround (pMode->load());
    c.freeze = pFreeze->load() >= 0.5f;
    c.freqHz = pFreq->load();
    c.dahMult = std::pow (2.0, std::lround (pDahPitch->load()) / 12.0);
    c.speed  = pSpeed->load();
    c.attackS  = pAttack->load() * 0.001;
    c.releaseS = pRelease->load() * 0.001;
    c.depth = pDepth->load();
    c.level = pLevel->load();
    c.scramble = pScramble->load();
    c.decay = pDecay->load() >= 0.5f;
    c.bpmFallback = pBpm->load();

    slice::HostPos h;
    const bool sync = pSync->load() >= 0.5f;
    if (auto* ph = sync ? getPlayHead() : nullptr)
    {
        if (auto pos = ph->getPosition())
        {
            h.hasTransport = true;
            h.playing = pos->getIsPlaying();
            if (auto b = pos->getBpm()) h.bpm = *b;
            if (auto p = pos->getPpqPosition()) { h.hasPpq = true; h.ppq = *p; }
        }
    }

    // mono in → both channels see it before the engine runs
    if (getTotalNumInputChannels() == 1 && buffer.getNumChannels() > 1)
        buffer.copyFrom (1, 0, buffer, 0, 0, buffer.getNumSamples());

    sliceEngine.process (buffer, c, h);

    // telemetry → editor datafield
    nsTelemetry.hasTransport.store (h.hasTransport, std::memory_order_relaxed);
    nsTelemetry.playing.store (h.playing, std::memory_order_relaxed);
    nsTelemetry.bpm.store (sliceEngine.uiBpm(), std::memory_order_relaxed);   // effective: host, else the BPM knob
    hostBpmA.store (h.bpm, std::memory_order_relaxed);   // 0 when SYNC is off → the knob is live
    float peak = 0.0f;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        peak = juce::jmax (peak, buffer.getMagnitude (ch, 0, buffer.getNumSamples()));
    nsTelemetry.pushPeak (peak);
}

// --- state ---

void SliceProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    auto state = apvts.copyState();
    {
        const juce::ScopedLock l (textLock);
        state.setProperty ("text", textInput, nullptr);
        state.setProperty ("data", dataInput, nullptr);
    }
    if (auto xml = state.createXml())
        copyXmlToBinary (*xml, dest);
}

void SliceProcessor::setStateInformation (const void* data, int size)
{
    if (auto xml = getXmlFromBinary (data, size))
    {
        if (! xml->hasTagName (apvts.state.getType())) return;
        auto tree = juce::ValueTree::fromXml (*xml);
        {
            const juce::ScopedLock l (textLock);
            if (tree.hasProperty ("text")) textInput = tree.getProperty ("text").toString();
            if (tree.hasProperty ("data")) dataInput = tree.getProperty ("data").toString();
        }
        apvts.replaceState (tree);
        pushMailbox();
    }
}

juce::AudioProcessorEditor* SliceProcessor::createEditor()
{
    return new SliceEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new SliceProcessor();
}
