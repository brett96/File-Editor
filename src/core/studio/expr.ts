/**
 * Studio expressions: a small formula language that drives an animatable property, e.g.
 * `value + wiggle(2, 30)` or `linear(time, 0, 2, 0, 100)`. Parsed and evaluated here rather
 * than with eval/Function, so a project file from someone else cannot run code.
 *
 *   numbers, + - * / % ^, comparisons, && || !, cond ? a : b, parentheses
 *   variables  time value frame fps duration start playhead width height index PI E
 *   functions  maths (sin, cos, abs, min, max, clamp, lerp, floor, round…), linear / ease
 *              ramps, wiggle, noise, random, loopOut / pingPong / valueAtTime (keyframes),
 *              data("column") for values imported from a CSV file
 */

export type ExprValue = number | string;
export type ExprFn = (...args: ExprValue[]) => number;

export interface ExprContext {
  vars: Record<string, number>;
  fns: Record<string, ExprFn>;
}

type Node = (ctx: ExprContext) => ExprValue;

interface Token {
  kind: 'num' | 'str' | 'id' | 'op' | 'end';
  text: string;
  pos: number;
}

const OPS = ['&&', '||', '<=', '>=', '==', '!=', '**', '+', '-', '*', '/', '%', '^', '<', '>', '!', '?', ':', '(', ')', ','];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num) {
      out.push({ kind: 'num', text: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))![0];
      out.push({ kind: 'id', text: id, pos: i });
      i += id.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new Error('A text value is missing its closing quote.');
      out.push({ kind: 'str', text: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`Unexpected character “${ch}”.`);
    out.push({ kind: 'op', text: op, pos: i });
    i += op.length;
  }
  out.push({ kind: 'end', text: '', pos: src.length });
  return out;
}

const num = (v: ExprValue): number => (typeof v === 'number' ? v : Number(v));

/** Names an expression may use (used to reject typos before anything is drawn). */
export interface ExprNames {
  vars: ReadonlySet<string>;
  fns: ReadonlySet<string>;
}

function parse(src: string, names: ExprNames): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (t: string) => toks[p].kind === 'op' && toks[p].text === t;
  const eat = (t: string) => {
    if (!isOp(t)) throw new Error(`Expected “${t}”${toks[p].kind === 'end' ? ' at the end' : ` before “${toks[p].text}”`}.`);
    p++;
  };
  const binary = (next: () => Node, ops: Record<string, (a: number, b: number) => number>): Node => {
    let left = next();
    for (;;) {
      const t = peek();
      const f = t.kind === 'op' ? ops[t.text] : undefined;
      if (!f) return left;
      p++;
      const l = left;
      const r = next();
      left = (c) => f(num(l(c)), num(r(c)));
    }
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (t.kind === 'num') {
      const v = Number(t.text);
      return () => v;
    }
    if (t.kind === 'str') return () => t.text;
    if (t.kind === 'op' && t.text === '(') {
      const e = ternary();
      eat(')');
      return e;
    }
    if (t.kind === 'id') {
      if (isOp('(')) {
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          do args.push(ternary());
          while (isOp(',') && ++p);
        }
        eat(')');
        if (!names.fns.has(t.text)) throw new Error(`There is no function called “${t.text}”.`);
        return (c) => c.fns[t.text](...args.map((a) => a(c)));
      }
      if (!names.vars.has(t.text)) throw new Error(names.fns.has(t.text) ? `“${t.text}” is a function: write ${t.text}(…).` : `“${t.text}” is not a known name.`);
      return (c) => c.vars[t.text];
    }
    throw new Error(t.kind === 'end' ? 'The expression is incomplete.' : `Unexpected “${t.text}”.`);
  };
  const power = (): Node => {
    const base = primary();
    if (isOp('^') || isOp('**')) {
      p++;
      const e = unary();
      return (c) => Math.pow(num(base(c)), num(e(c)));
    }
    return base;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      p++;
      const e = unary();
      return (c) => -num(e(c));
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    if (isOp('!')) {
      p++;
      const e = unary();
      return (c) => (num(e(c)) ? 0 : 1);
    }
    return power();
  };
  const mul = () => binary(unary, { '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a - b * Math.floor(a / b) });
  const add = () => binary(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const cmp = () => binary(add, { '<': (a, b) => +(a < b), '>': (a, b) => +(a > b), '<=': (a, b) => +(a <= b), '>=': (a, b) => +(a >= b), '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b) });
  const and = () => binary(cmp, { '&&': (a, b) => +(!!a && !!b) });
  const or = () => binary(and, { '||': (a, b) => +(!!a || !!b) });
  function ternary(): Node {
    const cond = or();
    if (!isOp('?')) return cond;
    p++;
    const a = ternary();
    eat(':');
    const b = ternary();
    return (c) => (num(cond(c)) ? a(c) : b(c));
  }
  const root = ternary();
  if (peek().kind !== 'end') throw new Error(`Unexpected “${peek().text}”.`);
  return root;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);
const ramp = (t: number, t0: number, t1: number, v0: number, v1: number, shape: (u: number) => number) => {
  if (t1 === t0) return t < t0 ? v0 : v1;
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return v0 + (v1 - v0) * shape(u);
};

function hash1(i: number, seed: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 2654435761) ^ Math.imul(seed | 0, 1597334677);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967295;
}

/** Smooth 1D noise, 0–1, repeatable for a seed. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  return hash1(i, seed) + (hash1(i + 1, seed) - hash1(i, seed)) * smoothstep(x - i);
}

export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h | 0;
}

/** Maths that needs nothing from the clip. */
export const PURE_FNS: Record<string, ExprFn> = {
  sin: (a) => Math.sin(num(a)),
  cos: (a) => Math.cos(num(a)),
  tan: (a) => Math.tan(num(a)),
  asin: (a) => Math.asin(num(a)),
  acos: (a) => Math.acos(num(a)),
  atan: (a) => Math.atan(num(a)),
  atan2: (a, b) => Math.atan2(num(a), num(b)),
  abs: (a) => Math.abs(num(a)),
  sqrt: (a) => Math.sqrt(num(a)),
  pow: (a, b) => Math.pow(num(a), num(b)),
  exp: (a) => Math.exp(num(a)),
  log: (a) => Math.log(num(a)),
  floor: (a) => Math.floor(num(a)),
  ceil: (a) => Math.ceil(num(a)),
  round: (a) => Math.round(num(a)),
  sign: (a) => Math.sign(num(a)),
  min: (...a) => Math.min(...a.map(num)),
  max: (...a) => Math.max(...a.map(num)),
  clamp: (v, lo, hi) => Math.min(num(hi), Math.max(num(lo), num(v))),
  lerp: (a, b, t) => num(a) + (num(b) - num(a)) * num(t),
  mod: (a, b) => num(a) - num(b) * Math.floor(num(a) / num(b)),
  radians: (a) => (num(a) * Math.PI) / 180,
  degrees: (a) => (num(a) * 180) / Math.PI,
  linear: (t, t0, t1, v0, v1) => ramp(num(t), num(t0), num(t1), num(v0), num(v1), (u) => u),
  ease: (t, t0, t1, v0, v1) => ramp(num(t), num(t0), num(t1), num(v0), num(v1), smoothstep),
  step: (edge, x) => +(num(x) >= num(edge)),
};

/** Functions the clip supplies when an expression runs (listed here so typos are caught on parse). */
export const CLIP_FNS = ['wiggle', 'noise', 'random', 'loopOut', 'pingPong', 'valueAtTime', 'data'] as const;
export const VARS = ['time', 't', 'value', 'frame', 'fps', 'duration', 'start', 'playhead', 'width', 'height', 'index', 'PI', 'E'] as const;

const NAMES: ExprNames = { vars: new Set<string>(VARS), fns: new Set<string>([...Object.keys(PURE_FNS), ...CLIP_FNS]) };

const cache = new Map<string, { run: Node | null; error: string | null }>();

function compile(src: string): { run: Node | null; error: string | null } {
  let hit = cache.get(src);
  if (!hit) {
    try {
      hit = { run: parse(src, NAMES), error: null };
    } catch (err) {
      hit = { run: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (cache.size > 500) cache.clear();
    cache.set(src, hit);
  }
  return hit;
}

/** Why the expression can't be used, or null if it is fine. */
export function expressionError(src: string): string | null {
  return src.trim() ? compile(src).error : null;
}

/** The expression's value, or `fallback` when it is empty, invalid or not a finite number. */
export function evalExpression(src: string, ctx: ExprContext, fallback: number): number {
  const c = compile(src);
  if (!c.run) return fallback;
  try {
    const v = num(c.run(ctx));
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

// ── data from a CSV file ──────────────────────────────────────────────────

export interface ExprData {
  name: string;
  columns: string[];
  /** rows[r][c]; cells that are not numbers are NaN */
  rows: number[][];
}

/** Reads a table of numbers: a header row of column names, then one row per frame (or step). */
export function parseDataCsv(text: string, name: string): ExprData {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('The file is empty.');
  const delim = [',', ';', '\t'].map((d) => [d, lines[0].split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const cells = (l: string) => l.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const first = cells(lines[0]);
  const headed = first.some((c) => c !== '' && !Number.isFinite(Number(c)));
  const columns = headed ? first : first.map((_, i) => `col${i + 1}`);
  const rows = lines.slice(headed ? 1 : 0).map((l) => cells(l).map((c) => (c === '' ? NaN : Number(c.replace(',', '.')))));
  if (!rows.length) throw new Error('The file has a header but no rows of numbers.');
  return { name, columns, rows };
}

/** data("column", row): the column by name (or 1-based number) at a row, interpolated between rows. */
export function dataValue(d: ExprData | undefined, column: ExprValue, row: number): number {
  if (!d || !d.rows.length) return 0;
  const ci = typeof column === 'number' ? Math.round(column) - 1 : d.columns.findIndex((c) => c.toLowerCase() === column.toLowerCase());
  if (ci < 0 || ci >= d.columns.length) return 0;
  const r = Math.min(d.rows.length - 1, Math.max(0, row));
  const r0 = Math.floor(r);
  const r1 = Math.min(d.rows.length - 1, r0 + 1);
  const a = d.rows[r0][ci];
  const b = d.rows[r1][ci];
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : 0;
  if (!Number.isFinite(b)) return a;
  return a + (b - a) * (r - r0);
}
