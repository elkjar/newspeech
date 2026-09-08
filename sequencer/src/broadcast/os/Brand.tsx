// NEWSPEECH brand block on the desktop ground, in the gap above the windows:
// an [ns] monogram — dim square brackets, the letters in zxx-sans with the
// homepage's character scramble (a glyph flips to a corruption char or
// another zxx face for a beat, then heals; Poisson-timed so it never reads
// as a loop). Placed in the layout's design coordinates and scaled with the
// windows.
import { useEffect, useRef, useState } from 'react';

const WORD = 'ns';
const FACES = ['zxx-sans', 'zxx-noise', 'zxx-camo', 'zxx-xed', 'zxx-bold-regular'];
const SCRAMBLE = '#*/\\_+=~<>.,:;|?!@$%^&-';
const FONT_CSS = `
@font-face { font-family: 'zxx-noise'; src: url('/fonts/zxx-noise.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'zxx-camo';  src: url('/fonts/zxx-camo.woff2')  format('woff2'); font-display: swap; }
@font-face { font-family: 'zxx-xed';   src: url('/fonts/zxx-xed.woff2')   format('woff2'); font-display: swap; }
`;

interface Glyph {
  ch: string;
  face: string;
}

export function Brand() {
  const [glyphs, setGlyphs] = useState<Glyph[]>(() => [...WORD].map((ch) => ({ ch, face: 'zxx-sans' })));
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!document.getElementById('ns-brand-fonts')) {
      const st = document.createElement('style');
      st.id = 'ns-brand-fonts';
      st.textContent = FONT_CSS;
      document.head.appendChild(st);
    }
    // Poisson scheduling: mean gap ~2.5 s; each event corrupts one letter for
    // 70–160 ms (a char swap or a face swap, 50/50).
    const schedule = () => {
      const gap = -Math.log(1 - Math.random()) * 2500;
      timer.current = window.setTimeout(() => {
        const i = Math.floor(Math.random() * WORD.length);
        const asChar = Math.random() < 0.5;
        setGlyphs((g) =>
          g.map((x, k) =>
            k === i
              ? asChar
                ? { ch: SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)], face: x.face }
                : { ch: x.ch, face: FACES[1 + Math.floor(Math.random() * (FACES.length - 1))] }
              : x,
          ),
        );
        window.setTimeout(() => {
          setGlyphs((g) => g.map((x, k) => (k === i ? { ch: WORD[i], face: 'zxx-sans' } : x)));
        }, 70 + Math.random() * 90);
        schedule();
      }, gap);
    };
    schedule();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div
      className="select-none pointer-events-none flex items-baseline"
      style={{ color: '#fff', fontFamily: 'zxx-sans, ui-monospace, monospace', fontSize: 72, lineHeight: 1, letterSpacing: '0.02em' }}
    >
      <span style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 200 }}>[</span>
      {glyphs.map((g, i) => (
        <span key={i} style={{ display: 'inline-block', width: '0.66em', textAlign: 'center', fontFamily: `'${g.face}', ui-monospace, monospace` }}>
          {g.ch}
        </span>
      ))}
      <span style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 200 }}>]</span>
    </div>
  );
}
