// The ident window — one station card, headline in zxx sans with the site's
// character scramble settling in over the first second and flickering now
// and then while it's up. Body lines and the url sit small underneath.
// Visible only while a card is active (cards.ts); the window frame itself is
// the layout's — Chris drags it where the ident should live.
import { useEffect, useMemo, useState } from 'react';
import { useCards, renderCardLine, type Card } from '../../cards';
import { useLayout } from '../layout';

const GLYPHS = '▓▒░█▄▀■□▪▫—·/\\|_╱╲=+*#%&$@01xzq';

// Scramble: every character starts as noise and settles left-to-right over
// `settleMs`; afterwards a Poisson trickle of single-character flips.
function useScramble(text: string, settleMs = 1100): string {
  const [out, setOut] = useState(() => text.replace(/\S/g, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]));
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    let flips: Array<{ i: number; until: number }> = [];
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / settleMs);
      const settled = Math.floor(u * u * text.length + 0.999);
      if (u >= 1 && Math.random() < 0.012) {
        const i = Math.floor(Math.random() * text.length);
        if (text[i] !== ' ') flips.push({ i, until: now + 60 + Math.random() * 140 });
      }
      flips = flips.filter((f) => f.until > now);
      let s = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ') {
          s += ch;
          continue;
        }
        const scrambled = i >= settled || flips.some((f) => f.i === i);
        s += scrambled ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : ch;
      }
      setOut(s);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, settleMs]);
  return out;
}

function CardBody({ card }: { card: Card }) {
  // Tokens are filled at render; re-render each second so {uptime}/{time} tick.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const headline = useMemo(() => renderCardLine(card.headline), [card]);
  const scrambled = useScramble(headline);
  return (
    <div className="h-full flex flex-col px-4 py-3 font-mono">
      <div className="text-[8px] tracking-[0.18em] uppercase text-white/45">{card.kind === 'ident' ? 'station ident' : card.kind}</div>
      <div className="font-sans text-white leading-[1.05] mt-1 break-words" style={{ fontSize: 'clamp(15px, 4.2cqw, 28px)', letterSpacing: '0.02em' }}>
        {scrambled}
      </div>
      <div className="mt-auto text-[10px] leading-[16px] text-white/75">
        {card.body.map((l, i) => (
          <div key={i} className="truncate">
            {renderCardLine(l)}
          </div>
        ))}
        {card.url && <div className="text-[8px] tracking-[0.16em] uppercase text-white/45 mt-1 truncate">{card.url}</div>}
      </div>
    </div>
  );
}

export function CardWindow() {
  const active = useCards((s) => s.active);
  const arranging = useLayout((s) => s.arranging);
  if (!active) {
    // Arrange mode: the frame is up with no card so it can be placed.
    if (!arranging) return null;
    return (
      <div className="absolute inset-0 flex items-center justify-center text-[8px] tracking-[0.18em] uppercase text-white/35">
        ident lands here while a card is up
      </div>
    );
  }
  return <CardBody key={active.path} card={active} />;
}
