// Drummer transition cue — four circles, top-right. They sit dim and idle most
// of the time (a fixed spot to watch without intruding on the visual), then
// fill one-per-beat through the bar before an autonomous bank swap, all four
// lit on the downbeat the swap lands. `count` is the 4·3·2·1 count-in (or null
// when nothing's queued), sourced from useTransitionCountIn in StreamWindow so
// it and the video-glitch layer share one subscription. Click-through.
export function TransitionCue({ count }: { count: number | null }) {
  // Lit circles: 0 when idle, 1→4 across the count-in (count 4→1).
  const lit = count === null ? 0 : 5 - count;

  return (
    <div
      className="absolute top-8 right-8 flex gap-3 pointer-events-none select-none"
      style={{ zIndex: 5 }}
    >
      {[0, 1, 2, 3].map((i) => {
        const on = i < lit;
        return (
          <div
            key={i}
            className="rounded-full"
            style={{
              width: 18,
              height: 18,
              // Idle dots are a faint outline; lit dots fill solid white. The
              // transition eases each fill in so it reads as a pulse, not a flash.
              border: '1px solid rgba(255,255,255,0.25)',
              background: on ? 'rgba(255,255,255,0.9)' : 'transparent',
              transition: 'background 120ms ease-out',
            }}
          />
        );
      })}
    </div>
  );
}
