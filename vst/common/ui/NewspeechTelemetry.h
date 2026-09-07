#pragma once

#include <JuceHeader.h>
#include <array>
#include <atomic>

// Live numbers the editor's datafield shows. Written on the audio thread by
// a small block patched into the Faust processor at build time
// (vst/common/patch-telemetry.sh), read on the message thread by
// NewspeechDatafield. Everything is lock-free.
namespace newspeech {

struct Telemetry
{
    static constexpr int bars = 48;   // ~half a second of blocks at 512/48k

    Telemetry() noexcept { for (auto& p : peaks) p.store (0.0f, std::memory_order_relaxed); }

    std::atomic<double> bpm          { 0.0 };
    std::atomic<bool>   hasTransport { false };
    std::atomic<bool>   playing      { false };

    // Per-block output peak, ring-buffered; newest is at head-1.
    void pushPeak (float p) noexcept
    {
        const int h = head.load (std::memory_order_relaxed);
        peaks[(size_t) h].store (p, std::memory_order_relaxed);
        head.store ((h + 1) % bars, std::memory_order_release);
    }

    // i = 0 oldest … bars-1 newest.
    float peakAt (int i) const noexcept
    {
        const int h = head.load (std::memory_order_acquire);
        return peaks[(size_t) ((h + i) % bars)].load (std::memory_order_relaxed);
    }

private:
    std::array<std::atomic<float>, bars> peaks;
    std::atomic<int> head { 0 };
};

// The processor exposes its telemetry through this; the editor finds it with
// a dynamic_cast so the shared kit never needs the generated processor class.
struct TelemetrySource
{
    virtual ~TelemetrySource() = default;
    virtual Telemetry& telemetry() noexcept = 0;
};

} // namespace newspeech
