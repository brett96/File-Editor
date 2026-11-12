/** Small building blocks for the user guide's pages. */
import { createContext, useContext, type ReactNode } from 'react';
import { Diamond, Info, Lightbulb, TriangleAlert } from 'lucide-react';

/** Lets in-guide links jump to another section. */
export const GuideNav = createContext<(id: string) => void>(() => undefined);

/** A link to another section of the guide. */
export function Go({ to, children }: { to: string; children: ReactNode }) {
  const go = useContext(GuideNav);
  return (
    <a
      href={`#help/${to}`}
      className="hg-link"
      onClick={(e) => {
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

/** The name of something on screen (a button, menu, panel). */
export const Ui = ({ children }: { children: ReactNode }) => <strong className="hg-ui">{children}</strong>;

/** A key or key combination: <K>Ctrl</K>+<K>S</K>. */
export const K = ({ children }: { children: ReactNode }) => <kbd className="hg-kbd">{children}</kbd>;

export function Keys({ k }: { k: string }) {
  const parts = k.split('+');
  return (
    <span className="hg-keys">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && '+'}
          <K>{p}</K>
        </span>
      ))}
    </span>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="hg-steps">{children}</ol>;
}

export function Tip({ children, title = 'Tip' }: { children: ReactNode; title?: string }) {
  return (
    <aside className="hg-callout hg-tip">
      <Lightbulb size={16} />
      <div>
        <strong>{title}</strong> {children}
      </div>
    </aside>
  );
}

export function Note({ children, title = 'Note' }: { children: ReactNode; title?: string }) {
  return (
    <aside className="hg-callout hg-note">
      <Info size={16} />
      <div>
        <strong>{title}</strong> {children}
      </div>
    </aside>
  );
}

export function Warn({ children, title = 'Careful' }: { children: ReactNode; title?: string }) {
  return (
    <aside className="hg-callout hg-warn">
      <TriangleAlert size={16} />
      <div>
        <strong>{title}</strong> {children}
      </div>
    </aside>
  );
}

/** Two-column definition table (term → explanation). */
export function Defs({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <table className="hg-defs">
      <tbody>
        {rows.map(([a, b], i) => (
          <tr key={i}>
            <th>{a}</th>
            <td>{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Keyboard shortcut table. */
export function Shortcuts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="hg-defs hg-shortcuts">
      <tbody>
        {rows.map(([k, what], i) => (
          <tr key={i}>
            <th>
              {k.split(' / ').map((alt, j) => (
                <span key={j}>
                  {j > 0 && <span className="hg-or"> or </span>}
                  <Keys k={alt} />
                </span>
              ))}
            </th>
            <td>{what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The keyframe diamond in its three looks, as drawn in the Studio inspector. */
export function DiamondLegend() {
  return (
    <div className="hg-diamonds">
      <span>
        <Diamond size={14} className="hg-d-off" /> grey outline: the property isn't animated; changing it changes the whole clip
      </span>
      <span>
        <Diamond size={14} className="hg-d-anim" /> gold outline: the property is animated, but there's no keyframe exactly at the playhead
      </span>
      <span>
        <Diamond size={14} className="hg-d-key" /> filled gold: there's a keyframe at the playhead (click to remove it)
      </span>
    </div>
  );
}

/** Labelled schematic of the Studio window. */
export function StudioMap() {
  return (
    <figure className="hg-map" aria-label="Studio window layout">
      <div className="hg-map-grid">
        <div className="hg-m-toolbar">
          <b>1</b> Toolbar: Add media · Text · Colour · tracks · Split · Delete · Unlink · Undo/Redo · <i>Timeline | Mixer</i>
        </div>
        <div className="hg-m-preview">
          <b>2</b> Preview
          <small>drag a layer to move it</small>
        </div>
        <div className="hg-m-inspector">
          <b>3</b> Inspector
          <small>settings of the selected clip</small>
        </div>
        <div className="hg-m-transport">
          <b>4</b> Transport: ⏮ ◀ ▶ ▶| · time · snapping · zoom
        </div>
        <div className="hg-m-timeline">
          <b>5</b> Timeline (or Mixer)
          <div className="hg-m-tracks">
            <span className="v">V2 · title</span>
            <span className="v">V1 · video</span>
            <span className="a">A1 · its sound</span>
            <span className="a">A2 · music</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

/** Signal flow of one mixer channel. */
export function SignalFlow() {
  const box = (t: string, sub?: string) => (
    <span className="hg-flow-box">
      {t}
      {sub && <small>{sub}</small>}
    </span>
  );
  return (
    <figure className="hg-flow" aria-label="Signal flow">
      {box('Clips', 'gain · fades · envelope')}
      <span className="hg-flow-arrow">→</span>
      {box('EQ')}
      <span className="hg-flow-arrow">→</span>
      {box('Compressor')}
      <span className="hg-flow-arrow">→</span>
      {box('Pan', '+ Delay / Reverb blended in')}
      <span className="hg-flow-arrow">→</span>
      {box('Fader')}
      <span className="hg-flow-arrow">→</span>
      {box('Master', 'fader · limiter')}
      <span className="hg-flow-arrow">→</span>
      {box('Export', 'loudness target')}
    </figure>
  );
}
