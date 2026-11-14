/** Full-screen slide show: keys, clicks and touch move through the slides with their transitions. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Deck } from '../../core/slides/model';
import { slideHtml } from '../../core/slides/render';

export function SlideShow({ deck, start, onExit }: { deck: Deck; start: number; onExit: (at: number) => void }) {
  // hidden slides are skipped, unless the show starts on one
  const order = useMemo(() => deck.slides.map((s, i) => ({ s, i })).filter(({ s, i }) => !s.hidden || i === start), [deck, start]);
  const [pos, setPos] = useState(() => Math.max(0, order.findIndex((o) => o.i === start)));
  const [prev, setPrev] = useState<number | null>(null);
  const [dir, setDir] = useState(1);
  const [black, setBlack] = useState(false);
  const [done, setDone] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const root = useRef<HTMLDivElement>(null);
  const posRef = useRef(pos);
  posRef.current = pos;

  const exit = () => onExit(order[Math.min(posRef.current, order.length - 1)]?.i ?? 0);
  const go = (to: number) => {
    if (to >= order.length) {
      if (done) exit();
      else setDone(true);
      return;
    }
    setDone(false);
    const next = Math.max(0, to);
    if (next === posRef.current) return;
    setDir(next > posRef.current ? 1 : -1);
    setPrev(posRef.current);
    setPos(next);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const exitRef = useRef(exit);
  exitRef.current = exit;

  useEffect(() => {
    const el = root.current;
    el?.focus();
    void el?.requestFullscreen?.().catch(() => undefined);
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    // leaving full screen with the browser's own Esc ends the show too
    const onFs = () => {
      if (!document.fullscreenElement && wasFull) exitRef.current();
      wasFull = !!document.fullscreenElement;
    };
    let wasFull = false;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') exitRef.current();
      else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(e.key)) goRef.current(posRef.current + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(e.key)) goRef.current(posRef.current - 1);
      else if (e.key === 'Home') goRef.current(0);
      else if (e.key === 'End') goRef.current(order.length - 1);
      else if (e.key === 'b' || e.key === 'B' || e.key === '.') setBlack((v) => !v);
      else return;
      e.preventDefault();
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey, true);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scale = Math.min(size.w / deck.width, size.h / deck.height);
  const cur = order[pos];
  const tr = cur?.s.transition ?? { type: 'none' as const, duration: 0.6 };
  const frame = (i: number, cls: string, key: string) => (
    <div
      key={key}
      className={`sl-show-slide ${cls}`}
      style={{ width: deck.width, height: deck.height, transform: `translate(-50%, -50%) scale(${scale})`, animationDuration: `${tr.duration}s` }}
      dangerouslySetInnerHTML={{ __html: slideHtml(deck, order[i].s) }}
    />
  );
  useEffect(() => {
    if (prev === null) return;
    const id = setTimeout(() => setPrev(null), tr.duration * 1000 + 50);
    return () => clearTimeout(id);
  }, [prev, tr.duration]);

  return (
    <div
      ref={root}
      className="sl-show"
      tabIndex={-1}
      role="dialog"
      aria-label="Slide show"
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest<HTMLElement>('[data-link]')?.dataset.link;
        if (link && /^(https?:|mailto:)/i.test(link)) {
          window.open(link, '_blank', 'noopener');
          return;
        }
        go(pos + 1);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        go(pos - 1);
      }}
    >
      {done || !cur ? (
        <p className="sl-show-end">End of slide show. Click, or press Esc, to exit.</p>
      ) : (
        <>
          {prev !== null && order[prev] && tr.type !== 'none' && frame(prev, `sl-out sl-out-${tr.type} ${dir < 0 ? 'is-back' : ''}`, `p${order[prev].s.id}`)}
          {frame(pos, prev !== null && tr.type !== 'none' ? `sl-in sl-in-${tr.type} ${dir < 0 ? 'is-back' : ''}` : '', `c${cur.s.id}`)}
        </>
      )}
      {black && <div className="sl-show-black" />}
      <div className="sl-show-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => go(pos - 1)} aria-label="Previous slide">‹</button>
        <span>{Math.min(pos + 1, order.length)} / {order.length}</span>
        <button type="button" onClick={() => go(pos + 1)} aria-label="Next slide">›</button>
        <button type="button" onClick={exit}>Exit</button>
      </div>
    </div>
  );
}
