/**
 * The app's light / dark theme as the page sees it: View ▸ Appearance sets data-theme on
 * <html> ("light" or "dark"); without it the system setting decides. Components that pick
 * colours in script (the spreadsheet grid) use these instead of reading the system setting,
 * so they switch with the rest of the app.
 */
const media = () => (typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined);

export function isDarkTheme(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return !!media()?.matches;
}

/** Calls `cb(dark)` whenever the effective theme changes; returns the function that stops it. */
export function onThemeChange(cb: (dark: boolean) => void): () => void {
  let last = isDarkTheme();
  const check = () => {
    const now = isDarkTheme();
    if (now !== last) {
      last = now;
      cb(now);
    }
  };
  const mq = media();
  mq?.addEventListener?.('change', check);
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    mq?.removeEventListener?.('change', check);
    observer.disconnect();
  };
}
