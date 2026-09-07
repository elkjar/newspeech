#pragma once

#include <JuceHeader.h>
#include "NewspeechTelemetry.h"
#include "SliceEngine.h"

// SLICE — pattern slicer. Parameters live in an APVTS (names are the suite's
// "SECTION/knob" convention, which the editor binds by name); the message /
// data text rides beside them in the state. The engine owns all pattern state
// on the audio thread; the UI hands it text through a lock-free-for-audio
// mailbox and reads back a snapshot of the current pass.
class SliceProcessor : public juce::AudioProcessor,
                       public newspeech::TelemetrySource
{
public:
    SliceProcessor();
    ~SliceProcessor() override = default;

    // --- AudioProcessor ---
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
    double getTailLengthSeconds() const override { return 1.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    // --- TelemetrySource ---
    newspeech::Telemetry& telemetry() noexcept override { return nsTelemetry; }

    // --- editor API (message thread) ---
    juce::AudioProcessorValueTreeState apvts;
    slice::SliceEngine& engine() noexcept { return sliceEngine; }

    // The two input fields (text modes share one, DATA has its own).
    void         setInputText (const juce::String&, bool isData);
    juce::String getInputText (bool isData) const;
    void         restorePattern() noexcept { restoreFlag.store (true, std::memory_order_release); }
    // Host tempo if the transport reports one (0 otherwise) — the BPM knob only
    // drives the clock when this is 0.
    double       hostBpm() const noexcept { return hostBpmA.load (std::memory_order_relaxed); }

    static constexpr int textCapacity = 1024;
    static constexpr int dataCapacity = 8192;

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    void pushMailbox();

    slice::SliceEngine sliceEngine;
    newspeech::Telemetry nsTelemetry;

    // raw parameter pointers, read per block
    std::atomic<float>* pPattern = nullptr; std::atomic<float>* pDah = nullptr; std::atomic<float>* pGap = nullptr;
    std::atomic<float>* pLetter = nullptr;  std::atomic<float>* pWord = nullptr; std::atomic<float>* pThresh = nullptr;
    std::atomic<float>* pSync = nullptr;    std::atomic<float>* pBpm = nullptr;
    std::atomic<float>* pRate = nullptr;    std::atomic<float>* pFeel = nullptr;
    std::atomic<float>* pSource = nullptr;  std::atomic<float>* pWave = nullptr; std::atomic<float>* pFreq = nullptr;
    std::atomic<float>* pDahPitch = nullptr;
    std::atomic<float>* pMode = nullptr;    std::atomic<float>* pFreeze = nullptr; std::atomic<float>* pSpeed = nullptr;
    std::atomic<float>* pAttack = nullptr;  std::atomic<float>* pRelease = nullptr; std::atomic<float>* pDepth = nullptr;
    std::atomic<float>* pLevel = nullptr;
    std::atomic<float>* pFlip = nullptr;    std::atomic<float>* pRatchet = nullptr; std::atomic<float>* pDrop = nullptr;
    std::atomic<float>* pScramble = nullptr; std::atomic<float>* pDecay = nullptr;

    // message-thread copies (state save / field swapping)
    mutable juce::CriticalSection textLock;
    juce::String textInput { "NEWSPEECH" };
    juce::String dataInput { "0.1 0.3 0.7 0.2 0.9 0.4 0.1 0.6 0.8 0.3 0.95 0.5 0.2 0.7 0.4 0.85 0.15 0.6 0.9 0.35 0.75 0.25 0.55 1.0" };

    // mailbox → audio thread. UI writes under the spin lock; audio try-locks
    // and copies when the version moves, so it never blocks.
    juce::SpinLock mailLock;
    std::array<char, textCapacity> mailText {};
    std::array<char, dataCapacity> mailData {};
    std::atomic<int> mailVersion { 0 };
    int mailSeen = -1;
    std::array<char, textCapacity> audioText {};
    std::array<char, dataCapacity> audioData {};

    std::atomic<bool> restoreFlag { false };
    std::atomic<double> hostBpmA { 0.0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SliceProcessor)
};
