import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './media.css';

// View ▸ Appearance (desktop): "light" / "dark" forces that theme; "system" follows the OS
const applyTheme = (t: string) => {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
};
void window.desktop?.theme?.get().then(applyTheme, () => undefined);
window.desktop?.theme?.onChange(applyTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
