#include "SlicePattern.h"
#include <cstdlib>
#include <cctype>
#include <cmath>

namespace slice {

const char* morseFor (char c) noexcept
{
    switch (c)
    {
        case 'A': return ".-";    case 'B': return "-...";  case 'C': return "-.-.";  case 'D': return "-..";
        case 'E': return ".";     case 'F': return "..-.";  case 'G': return "--.";   case 'H': return "....";
        case 'I': return "..";    case 'J': return ".---";  case 'K': return "-.-";   case 'L': return ".-..";
        case 'M': return "--";    case 'N': return "-.";    case 'O': return "---";   case 'P': return ".--.";
        case 'Q': return "--.-";  case 'R': return ".-.";   case 'S': return "...";   case 'T': return "-";
        case 'U': return "..-";   case 'V': return "...-";  case 'W': return ".--";   case 'X': return "-..-";
        case 'Y': return "-.--";  case 'Z': return "--..";
        case '0': return "-----"; case '1': return ".----"; case '2': return "..---"; case '3': return "...--";
        case '4': return "....-"; case '5': return "....."; case '6': return "-...."; case '7': return "--...";
        case '8': return "---.."; case '9': return "----.";
        case '.': return ".-.-.-"; case ',': return "--..--"; case '?': return "..--.."; case '\'': return ".----.";
        case '!': return "-.-.--"; case '/': return "-..-.";  case '(': return "-.--.";  case ')': return "-.--.-";
        case '&': return ".-...";  case ':': return "---..."; case ';': return "-.-.-."; case '=': return "-...-";
        case '+': return ".-.-.";  case '-': return "-....-"; case '_': return "..--.-"; case '"': return ".-..-.";
        case '$': return "...-..-"; case '@': return ".--.-.";
        default:  return nullptr;
    }
}

void parseMessage (const char* text, Message& out) noexcept
{
    out.len = 0;
    for (const char* p = text; *p != '\0' && out.len < maxChars; ++p)
    {
        const char c = (char) std::toupper ((unsigned char) *p);
        if (c == ' ' || morseFor (c) != nullptr)
            out.ch[(size_t) out.len++] = c;
    }
}

void parseSeries (const char* text, Series& out) noexcept
{
    out.len = 0;
    out.min = 0.0f; out.max = 1.0f;
    const char* p = text;
    bool any = false;
    while (*p != '\0' && out.len < maxData)
    {
        while (*p == ' ' || *p == ',' || *p == ';' || *p == '\t' || *p == '\n' || *p == '\r') ++p;
        if (*p == '\0') break;
        char* end = nullptr;
        const double v = std::strtod (p, &end);
        if (end == p) { ++p; continue; }   // not a number — skip a char (the page's filter(isFinite))
        p = end;
        if (! std::isfinite (v)) continue;
        const float f = (float) v;
        if (! any) { out.min = out.max = f; any = true; }
        else       { out.min = juce::jmin (out.min, f); out.max = juce::jmax (out.max, f); }
        out.v[(size_t) out.len++] = f;
    }
}

namespace {

// slice.html pushEvent: drop dice first, then a long hit may ratchet into a
// burst of shorts. Durations floor at 12ms so nothing vanishes.
void pushEvent (Pass& pass, const Params& P, double tU, double durU, int kind, int ci,
                double unit, float level, juce::Random& rng) noexcept
{
    const double minDur = 0.012 * P.bpm / 60.0;   // 12ms in beats
    const bool dropped = rng.nextDouble() < P.drop;
    if (kind != 0 && ! dropped && rng.nextDouble() < P.ratchet)
    {
        const int n = 2 + rng.nextInt (3);
        const double step = durU / n;
        for (int r = 0; r < n; ++r)
        {
            Event e;
            e.t = (tU + r * step) * unit;
            e.dur = juce::jmax (minDur, step * 0.6 * unit);
            e.kind = 0; e.ci = ci; e.level = level; e.ratchet = true;
            pass.push (e);
        }
        return;
    }
    Event e;
    e.t = tU * unit;
    e.dur = juce::jmax (minDur, durU * unit);
    e.kind = kind; e.ci = ci; e.level = level; e.dropped = dropped;
    pass.push (e);
}

double minTotal (const Params& P) noexcept { return 0.25 * P.bpm / 60.0; }   // 0.25s in beats

// Regulation morse when the knobs sit at 3/1/3/7; every ratio can break.
void buildMorse (const Params& P, const Message& msg, juce::Random& rng, Pass& out) noexcept
{
    const double unit = P.unitBeats;
    double t = 0.0;   // in dits
    for (int ci = 0; ci < msg.len; ++ci)
    {
        const char ch = msg.ch[(size_t) ci];
        if (ch == ' ') { t += P.word; continue; }
        const char* code = morseFor (ch);
        if (code == nullptr) { t += P.letter; continue; }
        const int n = (int) std::strlen (code);
        for (int si = 0; si < n; ++si)
        {
            int kind = code[si] == '.' ? 0 : 1;
            if (rng.nextDouble() < P.flip) kind = 1 - kind;
            const double durU = kind != 0 ? P.dah : 1.0;
            pushEvent (out, P, t, durU, kind, ci, unit, 1.0f, rng);
            t += durU;
            if (si < n - 1) t += P.gap;
        }
        if (ci < msg.len - 1 && msg.ch[(size_t) ci + 1] != ' ') t += P.letter;
    }
    t += P.word;   // loop breath
    out.total = juce::jmax (minTotal (P), t * unit);
}

// Each character as its 8 ASCII bits, one dit per bit; runs of 1s merge into
// sustained hits, so the alphabet arrives with its own dit/dah mix.
void buildBits (const Params& P, const Message& msg, juce::Random& rng, Pass& out) noexcept
{
    const double unit = P.unitBeats;
    double t = 0.0;
    for (int ci = 0; ci < msg.len; ++ci)
    {
        const char ch = msg.ch[(size_t) ci];
        if (ch == ' ') { t += P.word; continue; }
        bool bits[8];
        const unsigned code = (unsigned char) ch;
        for (int b = 0; b < 8; ++b)
        {
            bool bit = ((code >> (7 - b)) & 1u) != 0;
            if (rng.nextDouble() < P.flip) bit = ! bit;
            bits[b] = bit;
        }
        int bi = 0;
        while (bi < 8)
        {
            if (! bits[bi]) { t += 1.0; ++bi; continue; }
            int n = 0;
            while (bi < 8 && bits[bi]) { ++n; ++bi; }
            pushEvent (out, P, t, juce::jmax (0.3, n - 0.3), n > 1 ? 1 : 0, ci, unit, 1.0f, rng);
            t += n;
        }
        if (ci < msg.len - 1 && msg.ch[(size_t) ci + 1] != ' ') t += P.letter;
    }
    t += P.word;
    out.total = juce::jmax (minTotal (P), t * unit);
}

// A numeric series, one dit per point. Points below the threshold rest; above
// it, magnitude drives duration, level, and (near the top) the dah± pitch.
void buildData (const Params& P, const Series& data, juce::Random& rng, Pass& out) noexcept
{
    const double unit = P.unitBeats;
    double t = 0.0;
    for (int i = 0; i < data.len; ++i)
    {
        double norm = data.norm (data.v[(size_t) i]);
        if (rng.nextDouble() < P.flip) norm = 1.0 - norm;
        if (norm >= P.thresh)
        {
            const double durU = 0.15 + 0.75 * norm;
            pushEvent (out, P, t, durU, norm > 0.85 ? 1 : 0, i, unit, (float) (0.3 + 0.7 * norm), rng);
        }
        t += 1.0;
    }
    t += 2.0;   // loop breath
    out.total = juce::jmax (minTotal (P), t * unit);
}

} // namespace

void buildPass (const Params& P, const Message& msg, const Series& data, juce::Random& rng, Pass& out) noexcept
{
    out.clear();
    switch (P.pattern)
    {
        case Pattern::bits: buildBits (P, msg, rng, out); break;
        case Pattern::data: buildData (P, data, rng, out); break;
        case Pattern::morse:
        default:            buildMorse (P, msg, rng, out); break;
    }
}

void scrambleMessage (Message& m, double p, juce::Random& rng) noexcept
{
    if (p <= 0.0) return;
    for (int i = 0; i < m.len; ++i)
        if (m.ch[(size_t) i] != ' ' && rng.nextDouble() < p)
            m.ch[(size_t) i] = (char) ('A' + rng.nextInt (26));
}

void scrambleSeries (Series& s, double p, juce::Random& rng) noexcept
{
    if (p <= 0.0) return;
    for (int i = 0; i < s.len; ++i)
        if (rng.nextDouble() < p)
            s.v[(size_t) i] = s.min + (float) rng.nextDouble() * (s.max - s.min);
}

} // namespace slice
