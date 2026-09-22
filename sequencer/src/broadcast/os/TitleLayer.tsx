// The title shot: black, one line of type at picture scale — a song name, a
// record, a bank — settling in through the site's character scramble, and a
// small line under it. The one place the OS talks at a size a stream can
// carry. Also the `black` shot (no text).
import { useLayout, FORMATS } from './layout';
import { useScramble } from './windows/CardWindow';

function Line({ text, size }: { text: string; size: number }) {
  const s = useScramble(text, 900);
  return (
    <div className="font-sans text-white leading-[1.02] break-words text-center" style={{ fontSize: size, letterSpacing: '0.01em' }}>
      {s}
    </div>
  );
}

export function TitleLayer({ title }: { title: { text: string; sub: string | null } | null }) {
  const format = useLayout((s) => s.format);
  const f = FORMATS[format];
  // Big, but never wider than the picture: ~0.58em per character in zxx sans.
  const text = title?.text ?? '';
  const cap = format === '16:9' ? 96 : 64;
  const size = Math.max(28, Math.min(cap, (f.w * 0.84) / Math.max(6, text.length * 0.58)));
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-[6%]" style={{ background: '#050505', zIndex: 20000 }}>
      {title && (
        <>
          <Line key={title.text} text={title.text} size={size} />
          {title.sub && (
            <div className="font-mono text-white/55 uppercase tracking-[0.22em] mt-4" style={{ fontSize: Math.round(size * 0.16) + 4 }}>
              {title.sub}
            </div>
          )}
        </>
      )}
    </div>
  );
}
