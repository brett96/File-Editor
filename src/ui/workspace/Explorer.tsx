import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Database,
  File as FileIcon,
  FileCode,
  FilePlus,
  FileText,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Music,
  Pencil,
  RefreshCw,
  Sheet as SheetIcon,
  Trash2,
  X,
} from 'lucide-react';
import { isCodeFileName } from '../../core/code/languages';
import { dirOf, isSafeName, joinPath } from '../../core/web/paths';
import type { FolderEntry, OpenedFolder } from '../../platform/folders';
import { cx } from '../components';

const IMAGE = /\.(png|jpe?g|gif|webp|avif|heic|heif|jxl|bmp|tiff?|ico|svg|psd|ai|eps)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp|ogv|fstudio)$/i;
const AUDIO = /\.(mp3|m4a|wav|flac|ogg|oga|opus|aac|wma|aiff?)$/i;
const SHEET = /\.(xlsx|xlsm|xltx|csv|tsv)$/i;
const DATA = /\.(sqlite3?|db3?|sdb)$/i;
const DOC = /\.(docx?|docm|dotx|odt|rtf|pdf|md|markdown|txt|log)$/i;
const WEB = /\.(html?|xhtml|css|m?js)$/i;

function fileIcon(name: string): ReactNode {
  if (IMAGE.test(name)) return <ImageIcon size={14} />;
  if (VIDEO.test(name)) return <Film size={14} />;
  if (AUDIO.test(name)) return <Music size={14} />;
  if (SHEET.test(name)) return <SheetIcon size={14} />;
  if (DATA.test(name)) return <Database size={14} />;
  if (WEB.test(name) || isCodeFileName(name)) return <FileCode size={14} />;
  if (DOC.test(name)) return <FileText size={14} />;
  return <FileIcon size={14} />;
}

type Draft = { kind: 'new-file' | 'new-dir'; dir: string } | { kind: 'rename'; path: string; dir: string; name: string };

/**
 * The opened folder's file tree. Folders are listed when they are first expanded (so a large
 * repository opens at once), a click opens a file in a tab, and files and folders can be
 * created, renamed and deleted where the folder allows it.
 */
export function Explorer({
  folder,
  activePath,
  onOpenFile,
  onClose,
  onRenamed,
  onRemoved,
  toast,
}: {
  folder: OpenedFolder;
  /** the file of the tab on screen, when it belongs to this folder */
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  onRenamed?: (from: string, to: string) => void;
  onRemoved?: (path: string) => void;
  toast: (text: string, kind?: 'error' | 'info') => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [children, setChildren] = useState<Map<string, FolderEntry[]>>(() => new Map());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  /** the folder new files go into: the last folder clicked (or the folder of the last file clicked) */
  const [focusDir, setFocusDir] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(
    async (dir: string) => {
      setLoading((s) => new Set(s).add(dir));
      try {
        const list = await folder.list(dir);
        if (live.current) setChildren((m) => new Map(m).set(dir, list));
      } catch (err) {
        if (live.current) {
          // the folder went away (deleted or renamed outside the app)
          setChildren((m) => {
            const next = new Map(m);
            next.delete(dir);
            return next;
          });
          setExpanded((s) => {
            const next = new Set(s);
            if (dir) next.delete(dir);
            return next;
          });
          if (!dir) toast(`Could not read ${folder.name}: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      } finally {
        if (live.current) {
          setLoading((s) => {
            const next = new Set(s);
            next.delete(dir);
            return next;
          });
        }
      }
    },
    [folder, toast],
  );

  useEffect(() => {
    setExpanded(new Set(['']));
    setChildren(new Map());
    setFocusDir('');
    setDraft(null);
    void load('');
  }, [folder, load]);

  // show the active tab's file in the tree: open the folders above it
  useEffect(() => {
    if (!activePath) return;
    const above: string[] = [];
    for (let d = dirOf(activePath); d; d = dirOf(d)) above.push(d);
    if (!above.length) return;
    setExpanded((s) => (above.every((d) => s.has(d)) ? s : new Set([...s, ...above])));
    for (const d of above) if (!children.has(d)) void load(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  const toggle = (dir: string) => {
    setFocusDir(dir);
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!children.has(dir)) void load(dir);
  };

  const refresh = () => {
    for (const dir of expanded) void load(dir);
  };

  const startNew = (kind: 'new-file' | 'new-dir') => {
    if (!folder.canWrite) {
      toast('This browser opened the folder read-only. Use Chrome or Edge, or the desktop app, to add files to it.', 'info');
      return;
    }
    const dir = focusDir && expanded.has(focusDir) ? focusDir : '';
    setDraft({ kind, dir });
  };

  const commit = async (value: string) => {
    const d = draft;
    setDraft(null);
    const name = value.trim();
    if (!d || !name || (d.kind === 'rename' && name === d.name)) return;
    if (!isSafeName(name)) {
      toast(`"${name}" can't be used as a name: it must not contain \\ / : * ? " < > | or end in a dot or a space.`);
      return;
    }
    try {
      if (d.kind === 'rename') {
        const from = d.path;
        const to = await folder.rename(from, name);
        // what was listed below the old name is now below the new one
        setChildren((m) => new Map([...m].filter(([k]) => k !== from && !k.startsWith(`${from}/`))));
        setExpanded((s) => new Set([...s].filter((k) => k !== from && !k.startsWith(`${from}/`))));
        await load(d.dir);
        onRenamed?.(from, to);
      } else if (d.kind === 'new-file') {
        const path = joinPath(d.dir, name);
        await folder.createFile(path);
        await load(d.dir);
        onOpenFile(path);
      } else {
        await folder.createDir(joinPath(d.dir, name));
        await load(d.dir);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.');
    }
  };

  const remove = async (e: FolderEntry) => {
    const what = e.kind === 'dir' ? `the folder "${e.name}" and everything in it` : `"${e.name}"`;
    if (!window.confirm(`Delete ${what}? ${folder.removesToTrash ? 'It is moved to the recycle bin / Trash.' : 'This cannot be undone.'}`)) return;
    try {
      await folder.remove(e.path);
      await load(dirOf(e.path));
      onRemoved?.(e.path);
    } catch (err) {
      toast(`Could not delete ${e.name}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  const draftRow = (depth: number, initial: string, icon: ReactNode) => (
    <div className="explorer-row explorer-draft" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="explorer-chevron" />
      <span className="explorer-icon">{icon}</span>
      <input
        className="explorer-input"
        defaultValue={initial}
        autoFocus
        spellCheck={false}
        aria-label={draft?.kind === 'rename' ? 'New name' : draft?.kind === 'new-dir' ? 'Folder name' : 'File name'}
        onFocus={(e) => {
          // select the name without its extension, as file managers do
          const dot = initial.lastIndexOf('.');
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
        onBlur={(e) => void commit(e.currentTarget.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(null);
          }
          e.stopPropagation();
        }}
      />
    </div>
  );

  const renderDir = (dir: string, depth: number): ReactNode => {
    const list = children.get(dir);
    return (
      <>
        {draft && draft.kind !== 'rename' && draft.dir === dir && draftRow(depth, '', draft.kind === 'new-dir' ? <Folder size={14} /> : <FileIcon size={14} />)}
        {!list && loading.has(dir) && <div className="explorer-note" style={{ paddingLeft: 30 + depth * 14 }}>Loading…</div>}
        {list?.length === 0 && !(draft && draft.kind !== 'rename' && draft.dir === dir) && <div className="explorer-note" style={{ paddingLeft: 30 + depth * 14 }}>Empty</div>}
        {list?.map((e) => {
          if (draft?.kind === 'rename' && draft.path === e.path) {
            return <div key={e.path}>{draftRow(depth, e.name, e.kind === 'dir' ? <Folder size={14} /> : fileIcon(e.name))}</div>;
          }
          const open = e.kind === 'dir' && expanded.has(e.path);
          return (
            <div key={e.path} role="none">
              <div
                role="treeitem"
                tabIndex={0}
                aria-expanded={e.kind === 'dir' ? open : undefined}
                aria-selected={e.path === activePath}
                className={cx('explorer-row', e.path === activePath && 'is-active', e.ignored && 'is-dim')}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={e.path}
                onClick={() => {
                  if (e.kind === 'dir') toggle(e.path);
                  else {
                    setFocusDir(dirOf(e.path));
                    onOpenFile(e.path);
                  }
                }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    if (e.kind === 'dir') toggle(e.path);
                    else onOpenFile(e.path);
                  } else if (ev.key === 'F2' && folder.canWrite) {
                    ev.preventDefault();
                    setDraft({ kind: 'rename', path: e.path, dir: dirOf(e.path), name: e.name });
                  } else if (ev.key === 'Delete' && folder.canWrite) {
                    ev.preventDefault();
                    void remove(e);
                  }
                }}
              >
                <span className="explorer-chevron">{e.kind === 'dir' ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
                <span className="explorer-icon">{e.kind === 'dir' ? (open ? <FolderOpen size={14} /> : <Folder size={14} />) : fileIcon(e.name)}</span>
                <span className="explorer-name">{e.name}</span>
                {folder.canWrite && (
                  <span className="explorer-actions">
                    <button
                      type="button"
                      title="Rename (F2)"
                      aria-label={`Rename ${e.name}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setDraft({ kind: 'rename', path: e.path, dir: dirOf(e.path), name: e.name });
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      aria-label={`Delete ${e.name}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void remove(e);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                )}
              </div>
              {open && <div role="group">{renderDir(e.path, depth + 1)}</div>}
            </div>
          );
        })}
      </>
    );
  };

  return (
    <aside className="explorer" aria-label={`Files in ${folder.name}`}>
      <div className="explorer-head">
        <span className="explorer-title" title={folder.name}>{folder.name}</span>
        <button type="button" title="New file" aria-label="New file" onClick={() => startNew('new-file')}><FilePlus size={15} /></button>
        <button type="button" title="New folder" aria-label="New folder" onClick={() => startNew('new-dir')}><FolderPlus size={15} /></button>
        <button type="button" title="Refresh" aria-label="Refresh" onClick={refresh}><RefreshCw size={14} /></button>
        <button type="button" title="Collapse all folders" aria-label="Collapse all folders" onClick={() => setExpanded(new Set(['']))}><ChevronsDownUp size={15} /></button>
        <button type="button" title="Close folder (open files stay open)" aria-label="Close folder" onClick={onClose}><X size={15} /></button>
      </div>
      {!folder.canWrite && <div className="explorer-readonly">Read-only: this browser can open a folder but not change it. Saving a file downloads it.</div>}
      <div className="explorer-tree" role="tree" aria-label={folder.name}>
        {renderDir('', 0)}
      </div>
    </aside>
  );
}
