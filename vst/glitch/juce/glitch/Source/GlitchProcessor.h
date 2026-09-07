#pragma once

#include <JuceHeader.h>
#include "NewspeechTelemetry.h"
#include "GlitchEngine.h"

// GLITCH — audio destruction lanes on the host's bars. Host parameters are
// only the clock and output (SYNC, BPM, BARS, GRID, LEVEL, AUTO seed); the
// pattern itself — lanes, blocks and every block's settings — is plugin state
// (JSON), owned here on the message thread and handed to the engine through a
// try-lock mailbox so the audio thread never blocks.
class GlitchProcessor : public juce::AudioProcessor,
                        public newspeech::TelemetrySource,
                        private juce::AudioProcessorValueTreeState::Listener,
                        private juce::AsyncUpdater
{
public:
    GlitchProcessor();
    ~GlitchProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 2.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    newspeech::Telemetry& telemetry() noexcept override { return nsTelemetry; }

    // --- editor API (message thread) ---
    juce::AudioProcessorValueTreeState apvts;
    glitch::GlitchEngine& engine() noexcept { return glitchEngine; }

    glitch::Pattern& pattern() noexcept { return authored; }
    void patternEdited();                       // after any model edit: hand it to the engine
    int  cellsPerBar() const noexcept;
    int  barsCount() const noexcept;

    juce::String seed() const { return seedStr; }
    void applySeed (const juce::String&);       // recall: the seed populates the grid
    void newSeed();                             // ⟳
    void resetRun() noexcept { glitchEngine.requestReset(); }

    // While the live pattern has drifted (mutate), touching the grid adopts it
    // as authored — what you see is what you grab.
    void adoptLive (const glitch::LiveView&);

    double hostBpm() const noexcept { return hostBpmA.load (std::memory_order_relaxed); }
    bool   audioRunning() const noexcept { return juce::Time::getMillisecondCounter() - lastBlockMs.load (std::memory_order_relaxed) < 250; }

    static constexpr int barsOptions[4] = { 1, 2, 4, 8 };
    static constexpr int gridOptions[3] = { 8, 16, 32 };   // cells per bar

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    void parameterChanged (const juce::String& id, float value) override;
    void handleAsyncUpdate() override;
    void pushMailbox();
    void syncCellCount();

    glitch::GlitchEngine glitchEngine;
    newspeech::Telemetry nsTelemetry;

    std::atomic<float>* pSync = nullptr; std::atomic<float>* pBpm = nullptr; std::atomic<float>* pBars = nullptr;
    std::atomic<float>* pGrid = nullptr; std::atomic<float>* pLevel = nullptr; std::atomic<float>* pAuto = nullptr;

    // model — message thread
    glitch::Pattern authored;
    juce::String seedStr;
    int lastCellsPerBar = 16, lastBars = 4;

    // mailbox → audio
    juce::SpinLock mailLock;
    glitch::Pattern mailPattern;
    juce::uint32 mailSeed = 1;
    std::atomic<int> mailVersion { 0 };
    int mailSeen = -1;
    glitch::Pattern audioPattern;

    std::atomic<bool> cellsDirty { false }, autoSeedDue { false };
    std::atomic<double> hostBpmA { 0.0 };
    std::atomic<juce::uint32> lastBlockMs { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GlitchProcessor)
};
