/**
 * The photo editor's AI edit (licensed desktop copies): change the picture by describing the
 * change, or make a new picture, with one of OpenUncensored's image models. The picture goes
 * through File Editor's license server (electron/agent.ts → /api/agent/image), which checks the
 * license and the daily picture allowance and holds the API key. The result is shown first;
 * Apply puts it on the canvas as one undoable step.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Eye, Lock, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { takesStrength, type AgentUsageToday, type ImageModel } from '../../core/agent/protocol';
import { decodeImage, pixelsToCanvas, resizePixels } from '../../core/media/image-codecs';
import { hasTransparency } from '../../core/media/image-ops';
import type { Pixels } from '../../core/media/image-ops';
import { agentBridge } from '../../platform/host';
import { cx } from '../components';

type Mode = 'edit' | 'generate';

const SIZES: [string, string][] = [
  ['1024x1024', 'Square (1024×1024)'],
  ['1536x1024', 'Landscape (1536×1024)'],
  ['1024x1536', 'Portrait (1024×1536)'],
  ['1792x1024', 'Wide (1792×1024)'],
  ['1024x1792', 'Tall (1024×1792)'],
];
const DEFAULTS: Record<Mode, string[]> = { edit: ['qwen-image-3-edit', 'seedream-v5-5-edit', 'flux-2-klein-edit'], generate: ['z-image-turbo', 'qwen-image', 'chroma'] };
/** Longest side of the picture sent for editing, and the most characters it may take. */
const SEND_SIDE = 1536;
const SEND_CHARS = 3_800_000;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** The picture as a data URL small enough to send: PNG when it has transparency, else JPEG. */
export function pictureForSending(px: Pixels): string {
  for (const [side, quality] of [[SEND_SIDE, 0.92], [1280, 0.88], [1024, 0.85], [768, 0.8]] as const) {
    const k = Math.min(1, side / Math.max(px.width, px.height));
    const small = k < 1 ? resizePixels(px, Math.max(1, Math.round(px.width * k)), Math.max(1, Math.round(px.height * k))) : px;
    const canvas = pixelsToCanvas(small);
    const url = hasTransparency(small) ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
    if (url.length <= SEND_CHARS) return url;
  }
  throw new Error('This picture is too large to send, even made smaller.');
}

const price = (m: ImageModel) => (m.priceUsd !== null ? ` · $${m.priceUsd.toFixed(m.priceUsd < 0.1 ? 3 : 2).replace(/0$/, '')}` : '');

/** What happened, for the host to place the result (Pro Photo makes a layer of it). */
export interface AiApplyInfo {
  mode: Mode;
  prompt: string;
  /** the result was scaled to the picture's size */
  fitted: boolean;
}

export function AiImagePanel({
  getSource,
  sources,
  width,
  height,
  onApply,
  onClose,
  onError,
  applyLabel = 'Apply',
  appliedMessage,
  className,
}: {
  /** the picture as it is now (text and drawings included) */
  getSource: () => Pixels;
  /** a choice of what to send instead of getSource (Pro Photo: the whole picture or one layer) */
  sources?: { id: string; label: string; get: () => Pixels }[];
  width: number;
  height: number;
  onApply: (px: Pixels, info: AiApplyInfo) => void;
  onClose: () => void;
  onError: (message: string, kind?: 'error' | 'info') => void;
  applyLabel?: string;
  appliedMessage?: (mode: Mode) => string;
  className?: string;
}) {
  const [sourceId, setSourceId] = useState(sources?.[0]?.id ?? '');
  const source = () => (sources?.find((s) => s.id === sourceId) ?? sources?.[0])?.get() ?? getSource();
  const bridge = agentBridge();
  const [licensed, setLicensed] = useState<boolean | null>(null);
  const [models, setModels] = useState<ImageModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usage, setUsage] = useState<AgentUsageToday | null>(null);
  const [mode, setMode] = useState<Mode>(() => (load('fe.ai-image.mode') === 'generate' ? 'generate' : 'edit'));
  const [chosen, setChosen] = useState<Record<Mode, string>>(() => ({ edit: load('fe.ai-image.edit') ?? '', generate: load('fe.ai-image.generate') ?? '' }));
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [strength, setStrength] = useState(0.6);
  const [size, setSize] = useState('1024x1024');
  const [keepSize, setKeepSize] = useState(true);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ px: Pixels; url: string; model: string } | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const requestId = useRef<string | null>(null);

  const loadModels = useCallback(async () => {
    if (!bridge) return;
    setLoadError(null);
    const status = await bridge.status().catch(() => null);
    setLicensed(!!status?.licensed);
    if (!status?.licensed) return;
    const res = await bridge.imageModels().catch(() => null);
    if (res?.ok) {
      setModels(res.models);
      if (res.usage) setUsage(res.usage);
    } else setLoadError(res?.error ?? 'The image models couldn’t be loaded.');
  }, [bridge]);
  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const choices = useMemo(() => (models ?? []).filter((m) => m.operations.includes(mode)), [models, mode]);
  const model = choices.find((m) => m.id === chosen[mode]) ?? DEFAULTS[mode].map((id) => choices.find((m) => m.id === id)).find(Boolean) ?? choices[0] ?? null;

  // the result's preview URL goes when the result does
  useEffect(() => () => void (result && URL.revokeObjectURL(result.url)), [result]);

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    setElapsed(0);
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const make = async () => {
    if (!bridge || !model || !prompt.trim() || busy) return;
    setBusy(true);
    setShowBefore(false);
    const id = `img${Date.now().toString(36)}`;
    requestId.current = id;
    try {
      const image = mode === 'edit' ? pictureForSending(source()) : undefined;
      const res = await bridge.image(id, {
        mode,
        model: model.id,
        prompt: prompt.trim(),
        image,
        size: mode === 'generate' ? size : 'auto',
        strength: mode === 'edit' && takesStrength(model) ? strength : undefined,
        negativePrompt: negative.trim() || undefined,
      });
      if (!res.ok) {
        if (res.code !== 'cancelled') onError(res.error);
        if (res.code === 'unlicensed') void loadModels();
        else void bridge.usage().then((u) => u.ok && setUsage(u.usage), () => undefined);
        return;
      }
      if (res.today) setUsage(res.today);
      const decoded = await decodeImage(new Blob([res.bytes as BlobPart], { type: res.mime }), `ai.${res.mime.split('/')[1]}`);
      setResult((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { px: decoded.pixels, url: URL.createObjectURL(new Blob([res.bytes as BlobPart], { type: res.mime })), model: res.model };
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'The picture couldn’t be made.');
    } finally {
      requestId.current = null;
      setBusy(false);
    }
  };

  const apply = () => {
    if (!result) return;
    const fitted = mode === 'edit' && keepSize && (result.px.width !== width || result.px.height !== height);
    onApply(fitted ? resizePixels(result.px, width, height) : result.px, { mode, prompt: prompt.trim(), fitted });
    setResult(null);
    onError(appliedMessage?.(mode) ?? (mode === 'edit' ? 'AI edit applied. Undo (Ctrl+Z) takes it back.' : 'New picture placed. Undo (Ctrl+Z) takes it back.'), 'info');
  };

  let body: ReactNode;
  if (!bridge) {
    body = <p className="panel-note">AI edits are part of licensed copies of the File Editor desktop app.</p>;
  } else if (licensed === null || (licensed && !models && !loadError)) {
    body = <p className="panel-note"><span className="spinner" /> Loading…</p>;
  } else if (!licensed) {
    body = (
      <div className="ai-gate">
        <Lock size={22} />
        <p>A File Editor license unlocks AI edits: describe a change and an image model makes it. Enter your key under <strong>Help ▸ License</strong>.</p>
      </div>
    );
  } else if (loadError) {
    body = (
      <>
        <p className="panel-note is-error">{loadError}</p>
        <button type="button" className="btn btn-sm" onClick={() => void loadModels()}><RefreshCw size={14} /> Try again</button>
      </>
    );
  } else {
    const full = !!usage && (usage.dailyImages <= 0 || usage.images >= usage.dailyImages || usage.paused);
    body = (
      <>
        <div className="segmented ai-mode" role="radiogroup" aria-label="What to do">
          {(['edit', 'generate'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={cx(mode === m && 'is-active')} disabled={busy} onClick={() => (setMode(m), save('fe.ai-image.mode', m), setResult(null))}>
              {m === 'edit' ? 'Change this picture' : 'New picture'}
            </button>
          ))}
        </div>
        <label className="ai-field">
          <span>Model</span>
          <select
            value={model?.id ?? ''}
            disabled={busy}
            onChange={(e) => {
              setChosen((c) => ({ ...c, [mode]: e.target.value }));
              save(`fe.ai-image.${mode}`, e.target.value);
            }}
          >
            {choices.map((m) => (
              <option key={m.id} value={m.id} title={m.description}>
                {m.name}
                {price(m)}
              </option>
            ))}
          </select>
        </label>
        {model?.description && <p className="panel-note">{model.description}</p>}
        {mode === 'edit' && sources && sources.length > 1 && (
          <label className="ai-field">
            <span>Send</span>
            <select value={sourceId} disabled={busy} onChange={(e) => (setSourceId(e.target.value), setResult(null))}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
        )}
        <label className="ai-field">
          <span>{mode === 'edit' ? 'What should change?' : 'Describe the picture'}</span>
          <textarea
            rows={4}
            value={prompt}
            disabled={busy}
            placeholder={mode === 'edit' ? 'e.g. make it a sunset, remove the person on the left, turn it into a watercolour' : 'e.g. a lighthouse on a cliff at dawn, photo, soft light'}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void make();
              }
              e.stopPropagation();
            }}
          />
        </label>
        {mode === 'edit' && model && takesStrength(model) && (
          <label className="slider-row">
            <span title="How far the result may move away from your picture">Change</span>
            <input type="range" min={0.1} max={1} step={0.05} value={strength} disabled={busy} onChange={(e) => setStrength(Number(e.target.value))} />
            <output>{Math.round(strength * 100)}%</output>
          </label>
        )}
        {mode === 'generate' && (
          <label className="ai-field">
            <span>Size</span>
            <select value={size} disabled={busy} onChange={(e) => setSize(e.target.value)}>
              {SIZES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        )}
        <details className="ai-more">
          <summary>More options</summary>
          <label className="ai-field">
            <span>Avoid (negative prompt)</span>
            <input className="input" value={negative} disabled={busy} placeholder="e.g. blurry, text, watermark" onChange={(e) => setNegative(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          {mode === 'edit' && (
            <label className="ai-check">
              <input type="checkbox" checked={keepSize} onChange={(e) => setKeepSize(e.target.checked)} /> Keep the picture’s size ({width}×{height})
            </label>
          )}
        </details>
        <div className="panel-actions">
          {busy ? (
            <>
              <span className="ai-busy"><span className="spinner" /> Making it… {elapsed}s</span>
              <span className="spacer" />
              <button type="button" className="btn btn-sm" onClick={() => requestId.current && bridge.cancel(requestId.current)}>
                <Square size={13} /> Stop
              </button>
            </>
          ) : (
            <>
              <span className="spacer" />
              <button type="button" className="btn btn-primary" disabled={!prompt.trim() || !model || full} onClick={() => void make()}>
                <Sparkles size={15} /> {result ? 'Try again' : mode === 'edit' ? 'Change it' : 'Make it'}
              </button>
            </>
          )}
        </div>
        {result && (
          <div className="ai-result">
            <div className="ai-result-head">
              <span>Result · {result.model}</span>
              <button type="button" className="btn btn-text btn-sm" aria-pressed={showBefore} onMouseDown={() => setShowBefore(true)} onMouseUp={() => setShowBefore(false)} onMouseLeave={() => setShowBefore(false)} title="Hold to see the picture before">
                <Eye size={13} /> Before
              </button>
            </div>
            <img src={showBefore ? pixelsToCanvas(source()).toDataURL('image/jpeg', 0.8) : result.url} alt={showBefore ? 'Before' : 'AI result'} />
            <p className="panel-note">
              {result.px.width}×{result.px.height}
              {mode === 'edit' && keepSize && (result.px.width !== width || result.px.height !== height) ? ` · placed at ${width}×${height}` : ''}
            </p>
            <div className="panel-actions">
              <button type="button" className="btn btn-text" onClick={() => setResult(null)}>Discard</button>
              <span className="spacer" />
              <button type="button" className="btn btn-primary" onClick={apply}>{applyLabel}</button>
            </div>
          </div>
        )}
        {usage && usage.dailyImages > 0 && (
          <p className={cx('panel-note', 'ai-usage', full && 'is-error')}>
            {usage.paused ? 'Paused by the service’s monthly limit until the 1st.' : `AI pictures today: ${usage.images} of ${usage.dailyImages}${full ? ' (resets at midnight UTC)' : ''}`}
          </p>
        )}
        <p className="panel-note ai-privacy">The picture and your description go through File Editor’s license server to OpenUncensored to be made. They aren’t stored.</p>
      </>
    );
  }

  return (
    <aside className={cx('side-panel', 'ai-panel', className)} aria-label="AI edit">
      <div className="ai-head">
        <h3>
          <Sparkles size={15} /> AI edit
        </h3>
        <button type="button" className="btn btn-icon" aria-label="Close AI edit" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {body}
    </aside>
  );
}
