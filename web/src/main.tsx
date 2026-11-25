import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LangProvider } from './i18n';
import { CurrencyProvider } from './currency';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LangProvider>
      <CurrencyProvider>
        <App />
      </CurrencyProvider>
    </LangProvider>
  </React.StrictMode>,
);
