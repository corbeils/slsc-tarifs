import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LangProvider } from './i18n';
import { CurrencyProvider } from './currency';
import { AuthProvider } from './auth';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LangProvider>
      <CurrencyProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </CurrencyProvider>
    </LangProvider>
  </React.StrictMode>,
);

// Installable app (PWA): the service worker only runs on the built site
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
