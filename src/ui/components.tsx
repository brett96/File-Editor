import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

interface IconButtonProps {
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  /** Show the label next to the icon. */
  text?: boolean;
  className?: string;
}

export function IconButton({ label, onClick, active, disabled, children, text, className }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx('btn', text ? 'btn-text' : 'btn-icon', active && 'is-active', className)}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      // keep the editor selection when clicking toolbar buttons
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
      {text && <span>{label}</span>}
    </button>
  );
}

export function Divider() {
  return <span className="tb-divider" aria-hidden="true" />;
}

interface SelectProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  width?: number;
  disabled?: boolean;
}

export function Select<T extends string>({ label, value, options, onChange, width, disabled }: SelectProps<T>) {
  return (
    <select
      className="tb-select"
      aria-label={label}
      title={label}
      value={value}
      disabled={disabled}
      style={width ? { width } : undefined}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A button that opens a small popover below it; closes on outside click / Escape. */
export function Popover({
  label,
  button,
  children,
  align = 'left',
  text,
  disabled,
}: {
  label: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  text?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // Fixed positioning, measured from the button: the toolbar scrolls sideways on phones and
  // would otherwise clip an absolutely positioned menu.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const b = ref.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!b || !pop) return;
      const w = pop.offsetWidth;
      const vw = window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      let left = align === 'right' ? b.right - w : b.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      const below = vh - b.bottom - 12;
      const above = b.top - 12;
      const top = below >= Math.min(pop.scrollHeight, 320) || below >= above ? b.bottom + 4 : Math.max(8, b.top - 4 - Math.min(pop.scrollHeight, above));
      setPos({ top, left, maxHeight: Math.max(160, top > b.top ? below : above) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref}>
      <button
        type="button"
        className={cx('btn', text ? 'btn-text' : 'btn-icon', 'btn-popover', open && 'is-active')}
        title={label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div
          ref={popRef}
          className={cx('popover', align === 'right' && 'popover-right')}
          style={pos ? { position: 'fixed', top: pos.top, left: pos.left, right: 'auto', maxHeight: pos.maxHeight, overflowY: 'auto' } : { position: 'fixed', visibility: 'hidden' }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, children, disabled, hint }: { onClick: () => void; children: ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <button type="button" className="menu-item" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <span className="menu-item-label">{children}</span>
      {hint && <span className="menu-item-hint">{hint}</span>}
    </button>
  );
}

const SWATCHES = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#c00000', '#e06666', '#e69138', '#f1c232', '#6aa84f', '#38761d',
  '#45818e', '#1a56db', '#3d85c6', '#674ea7', '#a64d79', '#741b47',
];

const HIGHLIGHTS = ['#fff59d', '#ffe082', '#ffccbc', '#f8bbd0', '#d1c4e9', '#bbdefb', '#b2ebf2', '#c8e6c9', '#dcedc8', '#e0e0e0'];

export function ColorPicker({
  label,
  icon,
  value,
  onPick,
  onClear,
  clearLabel = 'Default',
  palette = 'text',
}: {
  label: string;
  icon: ReactNode;
  value: string | null;
  onPick: (color: string) => void;
  onClear?: () => void;
  clearLabel?: string;
  palette?: 'text' | 'highlight';
}) {
  const colors = palette === 'highlight' ? HIGHLIGHTS : SWATCHES;
  return (
    <Popover
      label={label}
      button={
        <span className="color-btn">
          {icon}
          <span className="color-bar" style={{ background: value ?? 'transparent' }} />
        </span>
      }
    >
      {(close) => (
        <div className="color-pop">
          <div className="swatches">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className={cx('swatch', value?.toLowerCase() === c && 'is-active')}
                style={{ background: c }}
                title={c}
                aria-label={c}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(c);
                  close();
                }}
              />
            ))}
          </div>
          <div className="color-row">
            <label className="color-custom">
              Custom
              <input type="color" value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onPick(e.target.value)} />
            </label>
            {onClear && (
              <button
                type="button"
                className="btn btn-text"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onClear();
                  close();
                }}
              >
                {clearLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button.btn-primary');
    first?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width }} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Single-value prompt (URL, table size…). */
export function PromptModal({
  title,
  label,
  initial = '',
  placeholder,
  confirmLabel = 'OK',
  onSubmit,
  onClose,
  extra,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
  extra?: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          {extra}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="prompt-form" className="btn btn-primary">
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        id="prompt-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value.trim());
        }}
      >
        <Field label={label}>
          <input className="input" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} data-autofocus />
        </Field>
      </form>
    </Modal>
  );
}
