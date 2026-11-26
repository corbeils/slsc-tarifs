import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'slsc-tariff-theme';

export function storedTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

const Sun = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export default function ThemeToggle() {
  const { t: tr } = useI18n();
  const [t, setT] = useState<Theme>(storedTheme);
  useEffect(() => {
    applyTheme(t);
    localStorage.setItem(KEY, t);
    window.dispatchEvent(new CustomEvent('slsc-prefs', { detail: { theme: t } }));
  }, [t]);
  // Theme restored from the signed-in account
  useEffect(() => {
    const on = (e: Event) => {
      const v = (e as CustomEvent<Theme>).detail;
      if (v === 'light' || v === 'dark' || v === 'system') setT(v);
    };
    window.addEventListener('slsc-set-theme', on);
    return () => window.removeEventListener('slsc-set-theme', on);
  }, []);
  // Default is the browser / OS setting (not shown); the user picks Light or Dark if needed.
  // Clicking the selected one again goes back to the browser / OS setting.
  const opts: [Theme, string, () => JSX.Element][] = [
    ['light', 'Light', Sun],
    ['dark', 'Dark', Moon],
  ];
  return (
    <div className="theme" role="radiogroup" aria-label={tr('Theme')}>
      {opts.map(([k, label, Icon]) => (
        <button key={k} role="radio" aria-checked={t === k} className={t === k ? 'on' : ''} title={tr(`${label} mode`)} onClick={() => setT(t === k ? 'system' : k)}>
          <Icon />
          <span className="theme-label">{tr(label)}</span>
        </button>
      ))}
    </div>
  );
}
