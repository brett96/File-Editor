import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Zoom that belongs to the document, not the page:
 *  - two-finger pinch on touch screens (two-finger pan while pinching too),
 *  - Ctrl/⌘ + mouse wheel and trackpad pinch on desktop (both arrive as ctrl+wheel),
 *  - and any other zoom change (buttons, menu) keeps the viewport centre in place.
 *
 * While a gesture is in progress only a CSS transform is applied to `contentRef` (cheap and
 * smooth); the real zoom is committed when the gesture ends, and the scroll position is then
 * set so the point that was under the fingers / cursor stays under them. The browser's own
 * page zoom is suppressed inside the scroll area, so toolbars never get zoomed off-screen.
 */
export function usePinchZoom(
  scrollEl: HTMLElement | null,
  contentEl: HTMLElement | null,
  zoom: number,
  setZoom: ((z: number) => void) | undefined,
  opts: { min?: number; max?: number; enabled?: boolean } = {},
) {
  const min = opts.min ?? 0.1;
  const max = opts.max ?? 5;
  const enabled = opts.enabled !== false && !!setZoom;
  const zoomRef = useRef(zoom);
  // elements come from callback refs (state), so effects re-run when they mount
  const scrollRef = useRef(scrollEl);
  scrollRef.current = scrollEl;
  const contentRef = useRef(contentEl);
  contentRef.current = contentEl;
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;
  /** Where to put the content after the next zoom change: content point (unzoomed) → screen point. */
  const anchor = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);
  /** Last known layout, so button-driven zooms can keep the centre without a "before" measurement. */
  const layout = useRef({ scrollLeft: 0, scrollTop: 0, left: 0, top: 0, width: 0, height: 0, zoom });

  const measure = () => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const er = el.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    layout.current = {
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      // content position in the scroll area's coordinate space
      left: cr.left - er.left + el.scrollLeft,
      top: cr.top - er.top + el.scrollTop,
      width: el.clientWidth,
      height: el.clientHeight,
      zoom: zoomRef.current,
    };
  };

  // keep the anchor point fixed when the zoom changes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const prev = layout.current;
    zoomRef.current = zoom;
    if (!el || !content || prev.zoom === zoom) {
      measure();
      return;
    }
    const a = anchor.current ?? {
      // default: the centre of the viewport
      px: prev.width / 2,
      py: prev.height / 2,
      cx: (prev.scrollLeft + prev.width / 2 - prev.left) / prev.zoom,
      cy: (prev.scrollTop + prev.height / 2 - prev.top) / prev.zoom,
    };
    anchor.current = null;
    const er = el.getBoundingClientRect();
    const cr = content.getBoundingClientRect();
    const left = cr.left - er.left + el.scrollLeft;
    const top = cr.top - er.top + el.scrollTop;
    el.scrollLeft = left + a.cx * zoom - a.px;
    el.scrollTop = top + a.cy * zoom - a.py;
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, contentEl]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return;
    const clampScale = (z0: number, s: number) => Math.max(min / z0, Math.min(max / z0, s));

    // ── live preview via transform ────────────────────────────────────────
    let gesture: { z0: number; px0: number; py0: number; cx: number; cy: number; s: number; px: number; py: number } | null = null;

    const begin = (px: number, py: number) => {
      measure();
      const L = layout.current;
      const z0 = zoomRef.current;
      gesture = { z0, px0: px, py0: py, cx: (L.scrollLeft + px - L.left) / z0, cy: (L.scrollTop + py - L.top) / z0, s: 1, px, py };
      const content = contentRef.current;
      if (content) {
        content.style.transformOrigin = `${L.scrollLeft + px - L.left}px ${L.scrollTop + py - L.top}px`;
        content.style.willChange = 'transform';
      }
    };
    const preview = (s: number, px: number, py: number) => {
      if (!gesture) return;
      gesture.s = clampScale(gesture.z0, s);
      gesture.px = px;
      gesture.py = py;
      const content = contentRef.current;
      if (content) content.style.transform = `translate(${px - gesture.px0}px, ${py - gesture.py0}px) scale(${gesture.s})`;
    };
    const commit = () => {
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      const content = contentRef.current;
      if (content) {
        content.style.transform = '';
        content.style.transformOrigin = '';
        content.style.willChange = '';
      }
      const z = Math.round(g.z0 * g.s * 100) / 100;
      if (Math.abs(z - g.z0) < 0.005) return;
      anchor.current = { cx: g.cx, cy: g.cy, px: g.px, py: g.py };
      setZoomRef.current?.(z);
    };

    // ── ctrl/⌘ + wheel and trackpad pinch ────────────────────────────────
    let wheelTimer = 0;
    let wheelScale = 1;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      if (!gesture) {
        wheelScale = 1;
        begin(px, py);
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      // a mouse-wheel notch (±100-ish) is one 15 % step; trackpad pinches send many small deltas
      wheelScale *= Math.abs(dy) >= 50 ? (dy < 0 ? 1.15 : 1 / 1.15) : Math.exp(-dy * 0.01);
      preview(wheelScale, gesture!.px0, gesture!.py0);
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(commit, 160);
    };

    // ── two-finger pinch ──────────────────────────────────────────────────
    let pinch: { d0: number } | null = null;
    const touchInfo = (t: TouchList) => {
      const r = el.getBoundingClientRect();
      const a = t[0];
      const b = t[1];
      return {
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        px: (a.clientX + b.clientX) / 2 - r.left,
        py: (a.clientY + b.clientY) / 2 - r.top,
      };
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const t = touchInfo(e.touches);
        pinch = { d0: Math.max(10, t.d) };
        begin(t.px, t.py);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length < 2) return;
      e.preventDefault();
      const t = touchInfo(e.touches);
      preview(t.d / pinch.d0, t.px, t.py);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        pinch = null;
        commit();
      }
    };
    // Safari's proprietary pinch events: stop it zooming the whole page
    const stopGesture = (e: Event) => e.preventDefault();

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    el.addEventListener('gesturestart', stopGesture);
    el.addEventListener('gesturechange', stopGesture);
    return () => {
      window.clearTimeout(wheelTimer);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('gesturestart', stopGesture);
      el.removeEventListener('gesturechange', stopGesture);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, min, max, scrollEl]);
}
