/** Opens the user guide from anywhere (e.g. a "?" button inside an editor); App listens. */
export function openGuide(section?: string): void {
  window.dispatchEvent(new CustomEvent('fe:help', { detail: section ?? null }));
}
