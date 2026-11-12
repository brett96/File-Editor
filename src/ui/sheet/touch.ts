/**
 * Touch gestures for the spreadsheet grid. Univer's grid is a canvas that treats a finger like a
 * mouse: dragging selects cells instead of scrolling, and every tap focuses its hidden text
 * input, which pops up the on-screen keyboard. This layer sits in front of it (capture phase on
 * the editor container), swallows touch pointer events aimed at the canvas, and replays them in
 * forms the grid already understands:
 *
 *   swipe              → wheel scrolling, with momentum
 *   tap                → click (selects the cell, without the keyboard)
 *   double-tap         → double-click (edits the cell; the keyboard opens)
 *   long-press         → right-click menu (copy, paste, insert/delete rows…)
 *   long-press + drag  → select a range
 *   pinch              → zoom
 *
 * Mouse and pen input, and touches on the toolbar, formula bar and sheet tabs, pass straight
 * through.
 */

interface Options {
  getZoom(): number;
  setZoom(zoom: number): void;
}

const TAP_SLOP = 8;
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 320;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

type Mode = 'idle' | 'pending' | 'pan' | 'long' | 'select' | 'pinch';

export function installSheetTouch(host: HTMLElement, opts: Options): () => void {
  let mode: Mode = 'idle';
  let target: HTMLCanvasElement | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let vx = 0;
  let vy = 0;
  let longTimer: ReturnType<typeof setTimeout> | null = null;
  let inertia = 0;
  let lastTap = { t: 0, x: 0, y: 0 };
  let pinchDist = 0;
  let pinchZoom = 1;
  let zoomFrame = 0;
  let pendingZoom = 1;

  const isGrid = (el: EventTarget | null): el is HTMLCanvasElement => el instanceof HTMLCanvasElement && host.contains(el);

  const mouse = (type: string, x: number, y: number, buttons: number, button = 0) => {
    if (!target) return;
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button,
      buttons,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      view: window,
    };
    target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init));
  };

  const wheel = (dx: number, dy: number) => {
    if (!target || (!dx && !dy)) return;
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: dx, deltaY: dy, deltaMode: 0, clientX: lastX, clientY: lastY }));
  };

  /** Keep the on-screen keyboard closed after a plain tap (Univer focuses its hidden input). */
  const dropKeyboard = () => {
    setTimeout(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a && host.contains(a) && a !== document.body) a.blur();
    }, 0);
  };

  const stopInertia = () => {
    if (inertia) cancelAnimationFrame(inertia);
    inertia = 0;
  };

  const startInertia = () => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      vx *= 0.94;
      vy *= 0.94;
      if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) {
        inertia = 0;
        return;
      }
      wheel(-vx * dt, -vy * dt);
      inertia = requestAnimationFrame(step);
    };
    inertia = requestAnimationFrame(step);
  };

  const clearLong = () => {
    if (longTimer) clearTimeout(longTimer);
    longTimer = null;
  };

  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const onTouchStart = (e: TouchEvent) => {
    if (!isGrid(e.target)) return;
    e.preventDefault();
    stopInertia();
    target = e.target;
    if (e.touches.length >= 2) {
      clearLong();
      if (mode === 'select') mouse('pointerup', lastX, lastY, 0);
      mode = 'pinch';
      pinchDist = dist(e.touches) || 1;
      pinchZoom = opts.getZoom();
      return;
    }
    const t = e.touches[0];
    startX = lastX = t.clientX;
    startY = lastY = t.clientY;
    lastT = performance.now();
    vx = vy = 0;
    mode = 'pending';
    longTimer = setTimeout(() => {
      if (mode !== 'pending') return;
      mode = 'long';
      navigator.vibrate?.(15);
      // select the pressed cell; moving from here extends the selection
      mouse('pointerdown', startX, startY, 1);
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (mode === 'idle') return;
    e.preventDefault();
    if (mode === 'pinch') {
      if (e.touches.length < 2) return;
      pendingZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchZoom * (dist(e.touches) / pinchDist)));
      if (!zoomFrame) {
        zoomFrame = requestAnimationFrame(() => {
          zoomFrame = 0;
          opts.setZoom(Math.round(pendingZoom * 100) / 100);
        });
      }
      return;
    }
    const t = e.touches[0];
    const now = performance.now();
    const dx = t.clientX - lastX;
    const dy = t.clientY - lastY;
    if (mode === 'pending' && Math.hypot(t.clientX - startX, t.clientY - startY) > TAP_SLOP) {
      clearLong();
      mode = 'pan';
    }
    if (mode === 'long' || mode === 'select') {
      mode = 'select';
      mouse('pointermove', t.clientX, t.clientY, 1);
    } else if (mode === 'pan') {
      const dt = Math.max(1, now - lastT);
      // smoothed velocity in px/ms, for momentum after the finger lifts
      vx = vx * 0.6 + (dx / dt) * 0.4;
      vy = vy * 0.6 + (dy / dt) * 0.4;
      // dominant-axis lock, like native scrolling: small drift on the other axis is ignored
      const ax = Math.abs(t.clientX - startX);
      const ay = Math.abs(t.clientY - startY);
      wheel(ax > ay * 0.5 ? -dx : 0, ay > ax * 0.5 ? -dy : 0);
    }
    lastX = t.clientX;
    lastY = t.clientY;
    lastT = now;
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (mode === 'idle') return;
    e.preventDefault();
    clearLong();
    if (mode === 'pinch') {
      if (e.touches.length === 0) mode = 'idle';
      return;
    }
    if (mode === 'pending') {
      // a tap
      const now = performance.now();
      const double = now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(startX - lastTap.x, startY - lastTap.y) < 30;
      mouse('pointerdown', startX, startY, 1);
      mouse('pointerup', startX, startY, 0);
      mouse('click', startX, startY, 0);
      if (double) {
        mouse('dblclick', startX, startY, 0);
        lastTap = { t: 0, x: 0, y: 0 };
      } else {
        lastTap = { t: now, x: startX, y: startY };
        dropKeyboard();
      }
    } else if (mode === 'pan') {
      if (performance.now() - lastT < 80) startInertia();
    } else if (mode === 'long') {
      // pressed and held without moving: context menu
      mouse('pointerup', startX, startY, 0);
      mouse('pointerdown', startX, startY, 2, 2);
      mouse('pointerup', startX, startY, 0, 2);
      mouse('contextmenu', startX, startY, 0, 2);
      dropKeyboard();
    } else if (mode === 'select') {
      mouse('pointerup', lastX, lastY, 0);
      dropKeyboard();
    }
    mode = 'idle';
  };

  /** Touch pointer events must not reach the grid: it would treat the finger as a mouse. */
  const swallowTouchPointer = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && isGrid(e.target)) e.stopPropagation();
  };
  /** Compatibility mouse events a browser may still synthesise after a touch. */
  const swallowSynthetic = (e: MouseEvent) => {
    if (isGrid(e.target) && (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) e.stopPropagation();
  };

  const pointerTypes = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerout', 'pointerleave'] as const;
  const syntheticTypes = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const;
  const active = { capture: true, passive: false } as const;
  host.addEventListener('touchstart', onTouchStart, active);
  host.addEventListener('touchmove', onTouchMove, active);
  host.addEventListener('touchend', onTouchEnd, active);
  host.addEventListener('touchcancel', onTouchEnd, active);
  for (const t of pointerTypes) host.addEventListener(t, swallowTouchPointer, true);
  for (const t of syntheticTypes) host.addEventListener(t, swallowSynthetic, true);

  return () => {
    clearLong();
    stopInertia();
    if (zoomFrame) cancelAnimationFrame(zoomFrame);
    host.removeEventListener('touchstart', onTouchStart, active);
    host.removeEventListener('touchmove', onTouchMove, active);
    host.removeEventListener('touchend', onTouchEnd, active);
    host.removeEventListener('touchcancel', onTouchEnd, active);
    for (const t of pointerTypes) host.removeEventListener(t, swallowTouchPointer, true);
    for (const t of syntheticTypes) host.removeEventListener(t, swallowSynthetic, true);
  };
}
