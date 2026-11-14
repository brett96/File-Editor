/** Studio command palette (Ctrl+K): type a few letters of any action and press Enter. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../components';

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/** Letters of `q` in order within `text`; earlier and tighter matches score higher. −1 = no match. */
export function fuzzyScore(q: string, text: string): number {
  const query = q.toLowerCase().replace(/\s+/g, '');
  if (!query) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q.trim().toLowerCase());
  if (direct >= 0) return 1000 - direct;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (const ch of query) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === last + 1 ? 6 : t[found - 1] === ' ' || found === 0 ? 4 : 1;
    last = found;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const usable = commands.filter((c) => !c.disabled);
    if (!q.trim()) return usable;
    return usable
      .map((c) => ({ c, s: Math.max(fuzzyScore(q, c.label), fuzzyScore(q, `${c.group} ${c.label}`) - 1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commands, q]);
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="modal-backdrop st-palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-palette" role="dialog" aria-label="Command palette">
        <input
          autoFocus
          className="st-palette-input"
          placeholder="Type a command: add text, wiggle, glow, split, lower third…"
          value={q}
          aria-label="Command"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(shown[index]);
            }
          }}
        />
        <div className="st-palette-list" ref={list} role="listbox">
          {shown.length === 0 && <p className="st-hint">No command matches “{q}”.</p>}
          {shown.map((c, i) => (
            <button key={c.id} type="button" role="option" aria-selected={i === index} className={cx('st-palette-item', i === index && 'is-active')} onPointerEnter={() => setIndex(i)} onClick={() => run(c)}>
              <small>{c.group}</small>
              <span>{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
