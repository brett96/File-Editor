import { useEffect, useMemo, useState } from 'react';
import {
  AUDIO_CODEC_LABELS,
  AUDIO_OUTPUT_ORDER,
  CONTAINERS,
  IMAGE_FORMATS,
  IMAGE_OUTPUT_ORDER,
  VIDEO_CODEC_LABELS,
  VIDEO_OUTPUT_ORDER,
  type AudioCodecId,
  type ContainerFormat,
  type ImageOutputFormat,
  type VideoCodecId,
} from '../core/media/media-formats';
import { QUALITY_LABELS, encodableCodecs, type MediaExportOptions, type MediaInfo, type QualityLevel } from '../core/media/video-engine';
import { Field, Modal } from './components';

export type ImageTarget = ImageOutputFormat | 'pdf';

export interface ImageExportChoice {
  format: ImageTarget;
  fileName: string;
  quality: number;
  lossless: boolean;
  background: string;
  /** output scale, 1 = original size */
  scale: number;
}

export function ImageExportModal({
  title = 'Save image as',
  initialFormat,
  initialName,
  width,
  height,
  onSubmit,
  onClose,
}: {
  title?: string;
  initialFormat: ImageTarget;
  initialName: string;
  width: number;
  height: number;
  onSubmit: (c: ImageExportChoice) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ImageTarget>(initialFormat);
  const [name, setName] = useState(initialName);
  const [quality, setQuality] = useState(90);
  const [lossless, setLossless] = useState(false);
  const [background, setBackground] = useState('#ffffff');
  const [scale, setScale] = useState(1);
  const info = format === 'pdf' ? null : IMAGE_FORMATS[format];
  const ext = format === 'pdf' ? 'pdf' : info!.ext;
  const lossy = format === 'pdf' || (info?.lossy ?? false);
  const canLossless = format === 'webp' || format === 'avif' || format === 'jxl';
  const noAlpha = format === 'jpeg' || format === 'pdf';

  return (
    <Modal
      title={title}
      width={520}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="img-export" className="btn btn-primary">Save</button>
        </>
      }
    >
      <form
        id="img-export"
        onSubmit={(e) => {
          e.preventDefault();
          const base = name.trim().replace(/\.[A-Za-z0-9]+$/, '') || 'image';
          onSubmit({ format, fileName: `${base}.${ext}`, quality, lossless: canLossless && lossless, background, scale });
        }}
      >
        <div className="grid-2">
          <Field label="File name">
            <div className="input-suffix">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
              <span>.{ext}</span>
            </div>
          </Field>
          <Field label="Format">
            <select className="input" value={format} onChange={(e) => setFormat(e.target.value as ImageTarget)}>
              {IMAGE_OUTPUT_ORDER.map((f) => <option key={f} value={f}>{IMAGE_FORMATS[f].label} (.{IMAGE_FORMATS[f].ext})</option>)}
              <option value="pdf">PDF document (.pdf)</option>
            </select>
          </Field>
        </div>
        {lossy && !(canLossless && lossless) && (
          <label className="slider-row">
            <span>Quality</span>
            <input type="range" min={10} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
            <output>{quality}</output>
          </label>
        )}
        {canLossless && <label className="check"><input type="checkbox" checked={lossless} onChange={(e) => setLossless(e.target.checked)} /> Lossless (larger file, no quality loss)</label>}
        {noAlpha && (
          <label className="check">Transparent areas become
            <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} aria-label="Background colour" />
          </label>
        )}
        <Field label="Size">
          <select className="input" value={String(scale)} onChange={(e) => setScale(Number(e.target.value))}>
            {[1, 0.75, 0.5, 0.25].map((k) => (
              <option key={k} value={k}>{k === 1 ? 'Original' : `${k * 100}%`} — {Math.max(1, Math.round(width * k))} × {Math.max(1, Math.round(height * k))}</option>
            ))}
          </select>
        </Field>
        {info?.note && <p className="dialog-hint">{info.note}</p>}
        {format === 'pdf' && <p className="dialog-hint">The image is placed on a page of its own size. Open the PDF afterwards to add pages or text.</p>}
        <p className="dialog-hint">Camera details and GPS location are not copied into the saved file.</p>
      </form>
    </Modal>
  );
}

export interface MediaExportChoice extends MediaExportOptions {
  fileName: string;
}

const HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];

export function MediaExportModal({
  info,
  outWidth,
  outHeight,
  initialContainer,
  initialName,
  onSubmit,
  onClose,
}: {
  info: MediaInfo;
  /** size after crop/rotate */
  outWidth: number;
  outHeight: number;
  initialContainer: ContainerFormat;
  initialName: string;
  onSubmit: (c: MediaExportChoice) => void;
  onClose: () => void;
}) {
  const [container, setContainer] = useState<ContainerFormat>(initialContainer);
  const [name, setName] = useState(initialName);
  const [quality, setQuality] = useState<QualityLevel>(4);
  const [height, setHeight] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [codecs, setCodecs] = useState<{ video: VideoCodecId[]; audio: AudioCodecId[] } | null>(null);
  const [videoCodec, setVideoCodec] = useState<VideoCodecId | ''>('');
  const [audioCodec, setAudioCodec] = useState<AudioCodecId | ''>('');
  const [error, setError] = useState<string | null>(null);
  const c = CONTAINERS[container];

  const size = useMemo(() => {
    if (!height || height >= outHeight) return { width: outWidth, height: outHeight, changed: false };
    const w = Math.round(((outWidth / outHeight) * height) / 2) * 2;
    return { width: w, height: height - (height % 2), changed: true };
  }, [height, outWidth, outHeight]);

  useEffect(() => {
    let alive = true;
    setCodecs(null);
    if (c.engine !== 'mediabunny') {
      setCodecs({ video: [], audio: [] });
      return;
    }
    encodableCodecs(container, info.hasVideo ? { width: size.width, height: size.height } : undefined)
      .then((r) => {
        if (!alive) return;
        setCodecs(r);
        setVideoCodec(r.video[0] ?? '');
        setAudioCodec(r.audio[0] ?? '');
      })
      .catch(() => alive && setCodecs({ video: [], audio: [] }));
    return () => {
      alive = false;
    };
  }, [container, c.engine, info.hasVideo, size.width, size.height]);

  useEffect(() => {
    if (container === 'gif') {
      setFps((f) => f ?? 12);
      setHeight((h) => h ?? (outHeight > 480 ? 480 : null));
    }
  }, [container, outHeight]);

  const containers = [...(info.hasVideo ? VIDEO_OUTPUT_ORDER : []), ...(info.hasAudio ? AUDIO_OUTPUT_ORDER : [])];
  const unavailable = c.engine === 'mediabunny' && codecs !== null && ((c.kind === 'video' && !codecs.video.length) || (c.kind === 'audio' && !codecs.audio.length));

  const submit = () => {
    if (unavailable) {
      setError(`This browser cannot write ${c.label}. Try MP4 or WebM, or use the desktop app.`);
      return;
    }
    const base = name.trim().replace(/\.[A-Za-z0-9]+$/, '') || 'video';
    onSubmit({
      fileName: `${base}.${c.ext}`,
      container,
      videoCodec: videoCodec || undefined,
      audioCodec: audioCodec || undefined,
      quality,
      width: size.changed ? size.width : container === 'gif' && !size.changed ? null : null,
      height: size.changed ? size.height : null,
      fps,
    });
  };

  return (
    <Modal
      title="Save as / Convert"
      width={560}
      onClose={onClose}
      footer={
        <>
          {error && <span className="dialog-error" role="alert">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="media-export" className="btn btn-primary" disabled={codecs === null}>Save</button>
        </>
      }
    >
      <form id="media-export" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid-2">
          <Field label="File name">
            <div className="input-suffix">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
              <span>.{c.ext}</span>
            </div>
          </Field>
          <Field label="Format">
            <select className="input" value={container} onChange={(e) => { setContainer(e.target.value as ContainerFormat); setError(null); }}>
              {info.hasVideo && <optgroup label="Video">{VIDEO_OUTPUT_ORDER.map((f) => <option key={f} value={f}>{CONTAINERS[f].label}</option>)}</optgroup>}
              {info.hasAudio && <optgroup label={info.hasVideo ? 'Sound only' : 'Audio'}>{AUDIO_OUTPUT_ORDER.map((f) => <option key={f} value={f}>{CONTAINERS[f].label}</option>)}</optgroup>}
            </select>
          </Field>
        </div>
        {containers.length === 0 && <p className="dialog-error">This file has nothing to export.</p>}

        {c.engine === 'mediabunny' && (
          <div className="grid-2">
            {c.kind === 'video' && (
              <Field label="Video codec">
                <select className="input" value={videoCodec} onChange={(e) => setVideoCodec(e.target.value as VideoCodecId)} disabled={!codecs}>
                  {!codecs && <option>Checking…</option>}
                  {codecs?.video.map((v) => <option key={v} value={v}>{VIDEO_CODEC_LABELS[v]}</option>)}
                  {codecs && !codecs.video.length && <option value="">Not available in this browser</option>}
                </select>
              </Field>
            )}
            {info.hasAudio && (
              <Field label="Audio codec">
                <select className="input" value={audioCodec} onChange={(e) => setAudioCodec(e.target.value as AudioCodecId)} disabled={!codecs}>
                  {!codecs && <option>Checking…</option>}
                  {codecs?.audio.map((a) => <option key={a} value={a}>{AUDIO_CODEC_LABELS[a]}</option>)}
                  {codecs && !codecs.audio.length && <option value="">Not available</option>}
                </select>
              </Field>
            )}
          </div>
        )}

        {container !== 'wav' && container !== 'flac' && (
          <label className="slider-row">
            <span>Quality</span>
            <input type="range" min={1} max={5} step={1} value={quality} onChange={(e) => setQuality(Number(e.target.value) as QualityLevel)} />
            <output>{QUALITY_LABELS[quality]}</output>
          </label>
        )}

        {c.kind === 'video' && info.hasVideo && (
          <div className="grid-2">
            <Field label="Resolution">
              <select className="input" value={String(height ?? '')} onChange={(e) => setHeight(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Original ({outWidth} × {outHeight})</option>
                {HEIGHTS.filter((h) => h < outHeight).map((h) => <option key={h} value={h}>{h}p</option>)}
              </select>
            </Field>
            <Field label="Frame rate">
              <select className="input" value={String(fps ?? '')} onChange={(e) => setFps(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Original{info.fps ? ` (${Math.round(info.fps)} fps)` : ''}</option>
                {[60, 50, 30, 25, 24, 15, 12, 10].filter((f) => !info.fps || f <= Math.ceil(info.fps)).map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </Field>
          </div>
        )}
        {c.note && <p className="dialog-hint">{c.note}</p>}
        {c.engine === 'ffmpeg' && <p className="dialog-hint">The first conversion downloads a 31 MB converter, once.</p>}
        {unavailable && <p className="dialog-error">This browser cannot encode {c.label}. Pick another format.</p>}
      </form>
    </Modal>
  );
}

export function ProgressModal({ title, phase, progress, onCancel }: { title: string; phase: string; progress: number; onCancel?: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width: 420 }}>
        <div className="modal-head"><h2>{title}</h2></div>
        <div className="modal-body">
          <p className="dialog-text">{phase}…</p>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="progress-bar" style={{ width: `${Math.max(2, progress * 100)}%` }} />
          </div>
          <p className="dialog-hint">{Math.round(progress * 100)}% — everything happens on this device.</p>
        </div>
        {onCancel && (
          <div className="modal-foot">
            <span className="spacer" />
            <button type="button" className="btn btn-text" onClick={onCancel}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
