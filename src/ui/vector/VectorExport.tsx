/** Save as / Export for Vector Studio: SVG, Illustrator, PDF or a picture of an artboard. */
import { useState } from 'react';
import { VECTOR_FORMATS, type VectorExportOptions, type VectorFormat } from '../../core/vector/browser';
import type { Artboard } from '../../core/vector/model';
import { Field, Modal } from '../components';

export interface VectorExportChoice extends VectorExportOptions {
  fileName: string;
}

const ORDER: VectorFormat[] = ['svg', 'ai', 'pdf', 'png', 'jpeg', 'webp'];

export function VectorExportModal({
  initialFormat,
  initialName,
  artboards,
  activeArtboard,
  onSubmit,
  onClose,
}: {
  initialFormat: VectorFormat;
  initialName: string;
  artboards: Artboard[];
  activeArtboard: string;
  onSubmit: (c: VectorExportChoice) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<VectorFormat>(initialFormat);
  const [name, setName] = useState(initialName);
  const [artboard, setArtboard] = useState<string>(artboards.length > 1 ? 'all' : artboards[0]?.id ?? 'all');
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(true);
  const [background, setBackground] = useState('#ffffff');
  const [quality, setQuality] = useState(90);
  const info = VECTOR_FORMATS[format];
  const raster = format === 'png' || format === 'jpeg' || format === 'webp';
  // a picture is always one artboard
  const board = raster && artboard === 'all' ? activeArtboard : artboard;
  const target = artboards.find((a) => a.id === board);
  const fileName = `${name.trim() || 'Drawing'}.${info.ext}`;
  return (
    <Modal
      title="Save as / Export"
      width={480}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSubmit({ format, fileName, artboard: board, scale, background: raster && (format === 'jpeg' || !transparent) ? background : null, quality, title: name.trim() || 'Drawing' })}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="File name">
        <div className="input-suffix">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          <span>.{info.ext}</span>
        </div>
      </Field>
      <Field label="Format" hint={info.note}>
        <select className="input" value={format} onChange={(e) => setFormat(e.target.value as VectorFormat)}>
          {ORDER.map((f) => <option key={f} value={f}>{VECTOR_FORMATS[f].label} (.{VECTOR_FORMATS[f].ext})</option>)}
        </select>
      </Field>
      {artboards.length > 1 && (
        <Field label="Artboards" hint={raster ? 'A picture holds one artboard.' : format === 'svg' ? 'All artboards keeps the file fully editable here; one artboard writes a plain SVG of just that canvas.' : 'All artboards makes one page per artboard.'}>
          <select className="input" value={board} onChange={(e) => setArtboard(e.target.value)}>
            {!raster && <option value="all">All artboards ({artboards.length})</option>}
            {artboards.map((a) => <option key={a.id} value={a.id}>{a.name} ({Math.round(a.width)} × {Math.round(a.height)})</option>)}
          </select>
        </Field>
      )}
      {raster && (
        <>
          <Field label="Size" hint={target ? `${Math.round(target.width * scale)} × ${Math.round(target.height * scale)} px` : undefined}>
            <select className="input" value={String(scale)} onChange={(e) => setScale(parseFloat(e.target.value))}>
              {[0.5, 1, 2, 3, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </Field>
          {format !== 'jpeg' && <label className="check"><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent background</label>}
          {(format === 'jpeg' || !transparent) && (
            <Field label="Background">
              <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} />
            </Field>
          )}
          {format !== 'png' && (
            <Field label={`Quality: ${quality}`}>
              <input type="range" min={10} max={100} value={quality} onChange={(e) => setQuality(+e.target.value)} />
            </Field>
          )}
        </>
      )}
    </Modal>
  );
}
