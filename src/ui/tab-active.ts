/**
 * Several files can be open at once, each in its own tab; inactive tabs stay mounted (hidden) so
 * nothing is lost. Editors that listen for keys or paste on the whole window check this so a
 * hidden tab doesn't react to typing meant for the visible one.
 */
import { createContext, useContext } from 'react';

/** `current` is true while the editor's tab is the one on screen (always true outside tabs). */
export const TabActiveContext = createContext<{ readonly current: boolean }>({ current: true });

export function useTabActive(): { readonly current: boolean } {
  return useContext(TabActiveContext);
}
