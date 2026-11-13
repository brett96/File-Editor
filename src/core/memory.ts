/**
 * How much this device can hold in memory.
 *
 * The spreadsheet grid keeps every filled cell as a JavaScript object, and the JavaScript heap
 * has a ceiling: 4 GB at most in Chromium and Electron, and less on machines with little RAM.
 * Rather than one fixed limit for everybody, the limit is worked out from what the device
 * reports, so a large desktop opens more and an older laptop or a phone stops earlier, before
 * the page runs out of memory. Workbooks past the limit are opened as database tables instead
 * (rows are stored outside the JavaScript heap and read a page at a time).
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Heap one filled cell needs once it is in the grid (its object, its row slot, the grid's own bookkeeping). */
export const BYTES_PER_CELL = 72;
/** The app itself: editor code, the grid's canvases and caches. */
const BASELINE_BYTES = 350 * MB;
/** Share of what is left that cells may take; the rest is headroom for editing and saving. */
const CELL_SHARE = 0.8;

export interface MemoryProfile {
  /** Bytes of JavaScript heap this page may reasonably use. */
  usableBytes: number;
  /** A device with little memory: a phone, or a computer with 4 GB of RAM or less. */
  lowMemory: boolean;
}

interface MemoryHints {
  heapLimit?: number;
  deviceMemoryGb?: number;
  mobile?: boolean;
}

function readHints(): MemoryHints {
  const hints: MemoryHints = {};
  try {
    const perf = (globalThis as { performance?: { memory?: { jsHeapSizeLimit?: number } } }).performance;
    const limit = perf?.memory?.jsHeapSizeLimit;
    if (typeof limit === 'number' && limit > 0) hints.heapLimit = limit;
    const nav = (globalThis as { navigator?: { deviceMemory?: number; userAgent?: string } }).navigator;
    if (typeof nav?.deviceMemory === 'number' && nav.deviceMemory > 0) hints.deviceMemoryGb = nav.deviceMemory;
    hints.mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? '');
  } catch {
    /* no hints: the defaults below apply */
  }
  return hints;
}

/** What the device can hold, from the heap limit and the amount of RAM it reports. */
export function memoryProfile(hints: MemoryHints = readHints()): MemoryProfile {
  // browsers that report nothing: assume a modest computer, or a modest phone
  const heap = hints.heapLimit ?? (hints.mobile ? 1 * GB : 2 * GB);
  // never plan on more than half the machine's RAM (the report is capped at 8 GB)
  const byRam = hints.deviceMemoryGb !== undefined ? (hints.deviceMemoryGb * GB) / 2 : Infinity;
  const usableBytes = Math.max(256 * MB, Math.min(heap, byRam));
  const lowMemory = !!hints.mobile || (hints.deviceMemoryGb !== undefined && hints.deviceMemoryGb <= 4) || usableBytes < 1.5 * GB;
  return { usableBytes, lowMemory };
}

/** The most filled cells the spreadsheet grid should be given on this device. */
export function sheetCellBudget(profile: MemoryProfile = memoryProfile()): number {
  const forCells = Math.max(64 * MB, (profile.usableBytes - BASELINE_BYTES) * CELL_SHARE);
  return Math.max(1_000_000, Math.floor(forCells / BYTES_PER_CELL / 100_000) * 100_000);
}

/** Thrown by the readers when a workbook holds more cells than the grid can be given. */
export class WorkbookTooLargeError extends Error {
  constructor(
    readonly budget: number,
    message = `This workbook has more than ${(budget / 1e6).toFixed(budget < 1e7 ? 1 : 0)} million filled cells, which is more than the spreadsheet grid can hold in memory on this device.`,
  ) {
    super(message);
    this.name = 'WorkbookTooLargeError';
  }
}

/**
 * A string of its own. Text cut out of a decoded chunk is, inside the JavaScript engine, a
 * view onto that chunk: keeping one formula or label of a 64 KB chunk keeps all 64 KB alive,
 * so a large sheet would hold most of its XML in memory on top of its cells. Short strings
 * are copied by the engine anyway.
 */
export function detach(text: string): string {
  return text.length < 13 ? text : (' ' + text).slice(1);
}

/** Repeated labels (a "Status" column with five values) are kept once, up to a bounded table. */
export class StringPool {
  private map = new Map<string, string>();
  get(text: string): string {
    if (text.length > 80) return detach(text);
    const hit = this.map.get(text);
    if (hit !== undefined) return hit;
    const own = detach(text);
    if (this.map.size < 200_000) this.map.set(own, own);
    return own;
  }
}
