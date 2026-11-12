/**
 * The user guide: a full-window page with a searchable table of contents on the left and one
 * section at a time on the right. Opened from Help ▸ User Guide, F1, or the start screen;
 * `#help/<section>` links open it at a section. Loaded on demand.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Monitor, Search, X } from 'lucide-react';
import { cx } from '../components';
import { GuideNav } from './bits';
import { SECTIONS } from './content';
import './help.css';

/** "Studio: the waveform editor" → "The waveform editor" (the group heading already says Studio). */
const tocTitle = (t: string) => {
  const rest = t.replace(/^(Studio|Pro Photo): /, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
};

export function HelpGuide({ section, desktop, onClose }: { section?: string | null; desktop: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState(() => (SECTIONS.some((s) => s.id === section) ? section! : SECTIONS[0].id));
  const [query, setQuery] = useState('');
  const [texts, setTexts] = useState<Record<string, string>>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // follow requests to open another section while the guide is open
  useEffect(() => {
    if (section && SECTIONS.some((s) => s.id === section)) setCurrent(section);
  }, [section]);

  // full text of every section, for search (rendered once, off-screen)
  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const out: Record<string, string> = {};
    root.querySelectorAll<HTMLElement>('[data-section]').forEach((el) => (out[el.dataset.section!] = (el.textContent ?? '').toLowerCase()));
    setTexts(out);
  }, []);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = useMemo(
    () =>
      SECTIONS.filter((s) => {
        if (!words.length) return true;
        const hay = `${s.title} ${s.group} ${s.keywords ?? ''} ${texts[s.id] ?? ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, texts],
  );
  const groups = useMemo(() => {
    const g: { name: string; items: typeof SECTIONS }[] = [];
    for (const s of visible) {
      const last = g[g.length - 1];
      if (last && last.name === s.group) last.items.push(s);
      else g.push({ name: s.group, items: [s] });
    }
    return g;
  }, [visible]);

  const index = SECTIONS.findIndex((s) => s.id === current);
  const sec = SECTIONS[index];
  const prev = SECTIONS[index - 1];
  const next = SECTIONS[index + 1];

  const go = (id: string) => {
    if (!SECTIONS.some((s) => s.id === id)) return;
    setCurrent(id);
  };

  // scroll to the top of a newly shown section and keep a shareable #help/<id> in the address
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    try {
      history.replaceState(history.state, '', `#help/${current}`);
    } catch {
      /* sandboxed */
    }
  }, [current]);
  useEffect(
    () => () => {
      try {
        if (location.hash.startsWith('#help')) history.replaceState(history.state, '', location.pathname + location.search);
      } catch {
        /* sandboxed */
      }
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (query) setQuery('');
        else onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
      } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const t = e.key === 'ArrowRight' ? next : prev;
        if (t) setCurrent(t.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [query, next, prev, onClose]);

  return (
    <GuideNav.Provider value={go}>
      <div className="hg" role="dialog" aria-modal="true" aria-label="User guide">
        <header className="hg-head">
          <BookOpen size={18} />
          <h1>User Guide</h1>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose} aria-label="Close the guide">
            <X size={16} /> <span>Close</span>
          </button>
        </header>
        <div className="hg-main">
          <nav className="hg-toc" aria-label="Guide contents">
            <label className="hg-search">
              <Search size={14} />
              <input
                ref={searchRef}
                type="search"
                placeholder="Search the guide"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && visible[0]) setCurrent(visible[0].id);
                }}
                aria-label="Search the guide"
              />
            </label>
            {groups.length === 0 && <p className="hg-none">Nothing matches “{query}”.</p>}
            {groups.map((g) => (
              <div key={g.name} className="hg-group">
                <h2>{g.name}</h2>
                <ul>
                  {g.items.map((s) => (
                    <li key={s.id}>
                      <button type="button" className={cx(s.id === current && 'is-active')} aria-current={s.id === current ? 'page' : undefined} onClick={() => setCurrent(s.id)}>
                        <span>{tocTitle(s.title)}</span>
                        {s.desktop && !desktop && <Monitor size={12} aria-label="Desktop app" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="hg-body" ref={bodyRef}>
            <article className="hg-article" aria-labelledby="hg-title">
              <p className="hg-crumb">{sec.group}</p>
              <h2 id="hg-title">
                {sec.title}
                {sec.desktop && <span className="hg-badge">Desktop app</span>}
              </h2>
              {sec.desktop && !desktop && (
                <p className="hg-desktop-note">
                  <Monitor size={14} /> This feature is in the File Editor desktop app for Windows and macOS. The web version doesn't include it.
                </p>
              )}
              {sec.body}
              <nav className="hg-pager" aria-label="Previous and next">
                {prev ? (
                  <button type="button" className="hg-pager-prev" onClick={() => setCurrent(prev.id)}>
                    <ChevronLeft size={16} />
                    <span>
                      <small>Previous</small>
                      {prev.title}
                    </span>
                  </button>
                ) : (
                  <span />
                )}
                {next && (
                  <button type="button" className="hg-pager-next" onClick={() => setCurrent(next.id)}>
                    <span>
                      <small>Next</small>
                      {next.title}
                    </span>
                    <ChevronRight size={16} />
                  </button>
                )}
              </nav>
            </article>
          </div>
        </div>
        {/* every section's text, for search (rendered once, then dropped) */}
        {Object.keys(texts).length === 0 && <div ref={measureRef} className="hg-measure" aria-hidden="true">
          {SECTIONS.map((s) => (
            <div key={s.id} data-section={s.id}>
              {s.body}
            </div>
          ))}
        </div>}
      </div>
    </GuideNav.Provider>
  );
}

export default HelpGuide;
