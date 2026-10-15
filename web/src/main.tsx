import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { applyTheme, getStoredTheme, watchSystemTheme } from './lib/theme';
import './index.css';

applyTheme(getStoredTheme()); // also updates <meta name=theme-color>
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline app shell (web/public/sw.js). Production only: the dev server must never be cached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => console.warn('Service worker registration failed', err));
  });
}
