/**
 * Studio project files (.fstudio): a ZIP holding `project.json` (the timeline, effects, mix)
 * and a copy of every media file the timeline uses under `media/`. Self-contained, so a
 * project can be moved to another computer; media is stored without recompression.
 */
import JSZip from 'jszip';
import type { Project } from './model';

export const PROJECT_EXT = 'fstudio';
export const PROJECT_MIME = 'application/x-file-editor-studio';
const MAGIC = 'file-editor-studio';
const VERSION = 1;

interface Manifest {
  app: typeof MAGIC;
  version: number;
  project: Project;
  /** source id → path inside the zip */
  media: Record<string, string>;
}

/** Source ids the timeline still uses (edits made with the waveform editor leave old ones behind). */
export function usedSources(p: Project): Set<string> {
  const used = new Set<string>();
  for (const t of p.tracks) for (const c of t.clips) if ('sourceId' in c) used.add(c.sourceId);
  return used;
}

function extFor(name: string, blob: Blob): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  if (blob.type === 'audio/wav') return 'wav';
  return 'bin';
}

export async function writeProjectFile(p: Project, blobs: Map<string, Blob>): Promise<Uint8Array> {
  const used = usedSources(p);
  const zip = new JSZip();
  const media: Record<string, string> = {};
  const sources: Project['sources'] = {};
  for (const id of used) {
    const blob = blobs.get(id);
    const meta = p.sources[id];
    if (!blob || !meta) throw new Error(`The media "${meta?.name ?? id}" is missing, so the project can't be saved.`);
    const path = `media/${id}.${extFor(meta.name, blob)}`;
    zip.file(path, new Uint8Array(await blob.arrayBuffer()), { binary: true, compression: 'STORE' });
    media[id] = path;
    sources[id] = meta;
  }
  const manifest: Manifest = { app: MAGIC, version: VERSION, project: { ...p, sources }, media };
  zip.file('project.json', JSON.stringify(manifest), { compression: 'DEFLATE' });
  return zip.generateAsync({ type: 'uint8array', streamFiles: true });
}

export async function readProjectFile(bytes: Uint8Array): Promise<{ project: Project; blobs: Map<string, Blob> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('This is not a Studio project file (or it is damaged).');
  }
  const entry = zip.file('project.json');
  if (!entry) throw new Error('This is not a Studio project file (project.json is missing).');
  const manifest = JSON.parse(await entry.async('string')) as Manifest;
  if (manifest.app !== MAGIC || !manifest.project?.tracks) throw new Error('This is not a Studio project file.');
  if (manifest.version > VERSION) throw new Error('This project was saved by a newer version of File Editor. Update the app to open it.');
  const blobs = new Map<string, Blob>();
  for (const [id, path] of Object.entries(manifest.media ?? {})) {
    const f = zip.file(path);
    if (!f) throw new Error(`The project is missing its media file ${path}.`);
    blobs.set(id, new Blob([(await f.async('uint8array')) as BlobPart]));
  }
  return { project: manifest.project, blobs };
}

export const isProjectFileName = (name: string) => new RegExp(`\\.${PROJECT_EXT}$`, 'i').test(name);
