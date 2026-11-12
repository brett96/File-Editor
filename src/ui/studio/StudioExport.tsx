/** Export dialog for a Studio project: format, quality, resolution, frame rate, loudness note. */
import { useState } from 'react';
import { AUDIO_OUTPUT_ORDER, CONTAINERS, VIDEO_OUTPUT_ORDER, type ContainerFormat } from '../../core/media/media-formats';
import { QUALITY_LABELS, type QualityLevel } from '../../core/media/video-engine';
import { Field, Modal } from '../components';

export interface StudioExportChoice {
  fileName: string;
  container: ContainerFormat;
  quality: QualityLevel;
  width?: number;
  height?: number;
  fps?: number;
}

/** Studio renders through WebCodecs/Mediabunny only. */
const VIDEO = VIDEO_OUTPUT_ORDER.filter((f) => CONTAINERS[f].engine === 'mediabunny');
const AUDIO = AUDIO_OUTPUT_ORDER.filter((f) => CONTAINERS[f].engine === 'mediabunny');
const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

export function StudioExportModal({
  hasVideo,
  width,
  height,
  fps,
  loudnessTarget,
  initialName,
  initialContainer,
  onSubmit,
  onClose,
}: {
  hasVideo: boolean;
  width: number;
  height: number;
  fps: number;
  loudnessTarget: number | null;
  initialName: string;
  initialContainer: ContainerFormat;
  onSubmit: (c: StudioExportChoice) => void;
  onClose: () => void;
}) {
  const allowed = [...(hasVideo ? VIDEO : []), ...AUDIO];
  const [container, setContainer] = useState<ContainerFormat>(allowed.includes(initialContainer) ? initialContainer : allowed[0]);
  const [name, setName] = useState(initialName);
  const [quality, setQuality] = useState<QualityLevel>(4);
  const [outH, setOutH] = useState<number>(height);
  const [outFps, setOutFps] = useState<number>(fps);
  const c = CONTAINERS[container];
  const isVideo = c.kind === 'video';
  const outW = Math.round(((width / height) * outH) / 2) * 2;

  const submit = () => {
    const base = name.trim().replace(/\.[A-Za-z0-9]+$/, '') || 'project';
    onSubmit({
      fileName: `${base}.${c.ext}`,
      container,
      quality,
      ...(isVideo && outH !== height ? { width: outW, height: outH } : {}),
      ...(isVideo && outFps !== fps ? { fps: outFps } : {}),
    });
  };

  return (
    <Modal
      title="Export Studio project"
      width={520}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" form="studio-export" className="btn btn-primary">Export</button>
        </>
      }
    >
      <form id="studio-export" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid-2">
          <Field label="File name">
            <div className="input-suffix">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
              <span>.{c.ext}</span>
            </div>
          </Field>
          <Field label="Format">
            <select className="input" value={container} onChange={(e) => setContainer(e.target.value as ContainerFormat)} aria-label="Format">
              {hasVideo && <optgroup label="Video">{VIDEO.map((f) => <option key={f} value={f}>{CONTAINERS[f].label}</option>)}</optgroup>}
              <optgroup label={hasVideo ? 'Sound only (mixdown)' : 'Audio'}>{AUDIO.map((f) => <option key={f} value={f}>{CONTAINERS[f].label}</option>)}</optgroup>
            </select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Quality">
            <select className="input" value={quality} onChange={(e) => setQuality(Number(e.target.value) as QualityLevel)} disabled={container === 'wav' || container === 'flac'}>
              {([5, 4, 3, 2, 1] as QualityLevel[]).map((q) => <option key={q} value={q}>{QUALITY_LABELS[q]}</option>)}
            </select>
          </Field>
          {isVideo && (
            <Field label="Resolution">
              <select className="input" value={outH} onChange={(e) => setOutH(Number(e.target.value))}>
                <option value={height}>Project — {width} × {height}</option>
                {HEIGHTS.filter((h) => h < height).map((h) => (
                  <option key={h} value={h}>{Math.round(((width / height) * h) / 2) * 2} × {h}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {isVideo && (
          <Field label="Frame rate">
            <select className="input" value={outFps} onChange={(e) => setOutFps(Number(e.target.value))}>
              {[...new Set([fps, 24, 25, 30, 50, 60])].sort((a, b) => a - b).map((f) => <option key={f} value={f}>{f} fps{f === fps ? ' (project)' : ''}</option>)}
            </select>
          </Field>
        )}
        <p className="dialog-hint">
          {loudnessTarget !== null
            ? `The mix is normalized to ${loudnessTarget} LUFS integrated loudness, then peak-limited.`
            : 'Loudness normalization is off (set a target in the Mixer → Master).'}
        </p>
      </form>
    </Modal>
  );
}
