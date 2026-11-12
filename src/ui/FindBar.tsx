import { useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Replace, ReplaceAll, WholeWord, X } from 'lucide-react';
import type { SearchOptions } from '../core/search';
import { cx } from './components';

export interface FindBarProps {
  /** Show the replace row. */
  replaceOpen: boolean;
  onToggleReplace: () => void;
  query: string;
  onQuery: (q: string) => void;
  options: SearchOptions;
  onOptions: (o: SearchOptions) => void;
  total: number;
  /** Index of the current match, or -1. */
  current: number;
  /** e.g. "Searching… 120 / 1404 pages" while results are still coming in. */
  progress?: string | null;
  onNext: () => void;
  onPrev: () => void;
  onReplace: (replacement: string) => void;
  onReplaceAll: (replacement: string) => void;
  onClose: () => void;
  /** Extra note under the bar (e.g. limits of replacing in PDFs). */
  note?: string;
  /** Re-focus the find field when this number changes (Ctrl+F while already open). */
  focusToken?: number;
}

/** The find & replace bar: "3 of 12", ↑/↓ to step, Enter / Shift+Enter, Esc to close. */
export function FindBar(p: FindBarProps) {
  const [replacement, setReplacement] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, [p.focusToken]);

  useEffect(() => {
    if (p.replaceOpen) replaceRef.current?.focus();
  }, [p.replaceOpen]);

  const count = !p.query ? '' : p.total === 0 ? (p.progress ? '…' : 'No results') : `${p.current >= 0 ? p.current + 1 : 0} of ${p.total}${p.progress ? '+' : ''}`;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      p.onClose();
    }
  };

  return (
    <div className="findbar" role="search" onKeyDown={onKey}>
      <div className="findbar-row">
        <button
          type="button"
          className="btn btn-icon findbar-toggle"
          aria-label={p.replaceOpen ? 'Hide replace' : 'Show replace'}
          title={p.replaceOpen ? 'Hide replace' : 'Replace (Ctrl+H)'}
          aria-expanded={p.replaceOpen}
          onClick={p.onToggleReplace}
        >
          {p.replaceOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="findbar-field">
          <input
            ref={findRef}
            className="input findbar-input"
            type="search"
            placeholder="Find"
            aria-label="Find"
            value={p.query}
            enterKeyHint="search"
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) p.onPrev();
                else p.onNext();
              }
            }}
          />
          <button
            type="button"
            className={cx('findbar-opt', p.options.caseSensitive && 'is-active')}
            title="Match case"
            aria-label="Match case"
            aria-pressed={p.options.caseSensitive}
            onClick={() => p.onOptions({ ...p.options, caseSensitive: !p.options.caseSensitive })}
          >
            <CaseSensitive size={16} />
          </button>
          <button
            type="button"
            className={cx('findbar-opt', p.options.wholeWord && 'is-active')}
            title="Whole word"
            aria-label="Whole word"
            aria-pressed={p.options.wholeWord}
            onClick={() => p.onOptions({ ...p.options, wholeWord: !p.options.wholeWord })}
          >
            <WholeWord size={16} />
          </button>
        </div>
        <span className="findbar-count" aria-live="polite">{count}</span>
        <button type="button" className="btn btn-icon" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!p.total} onClick={p.onPrev}>
          <ChevronUp size={16} />
        </button>
        <button type="button" className="btn btn-icon" title="Next match (Enter)" aria-label="Next match" disabled={!p.total} onClick={p.onNext}>
          <ChevronDown size={16} />
        </button>
        <button type="button" className="btn btn-icon" title="Close (Esc)" aria-label="Close find" onClick={p.onClose}>
          <X size={16} />
        </button>
      </div>
      {p.replaceOpen && (
        <div className="findbar-row">
          <span className="findbar-toggle-spacer" />
          <div className="findbar-field">
            <input
              ref={replaceRef}
              className="input findbar-input"
              placeholder="Replace with"
              aria-label="Replace with"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.ctrlKey || e.metaKey) p.onReplaceAll(replacement);
                  else p.onReplace(replacement);
                }
              }}
            />
          </div>
          <button type="button" className="btn btn-text findbar-action" title="Replace this match (Enter)" disabled={p.current < 0} onClick={() => p.onReplace(replacement)}>
            <Replace size={15} /> <span>Replace</span>
          </button>
          <button type="button" className="btn btn-text findbar-action" title="Replace all matches (Ctrl+Enter)" disabled={!p.total || !!p.progress} onClick={() => p.onReplaceAll(replacement)}>
            <ReplaceAll size={15} /> <span>All</span>
          </button>
        </div>
      )}
      {(p.progress || p.note) && <div className="findbar-note">{p.progress ?? p.note}</div>}
    </div>
  );
}
