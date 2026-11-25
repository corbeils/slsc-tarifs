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
const Monitor = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export default function ThemeToggle() {
  const { t: tr } = useI18n();
  const [t, setT] = useState<Theme>(storedTheme);
  useEffect(() => {
    applyTheme(t);
    localStorage.setItem(KEY, t);
  }, [t]);
  const opts: [Theme, string, () => JSX.Element][] = [
    ['light', 'Light', Sun],
    ['dark', 'Dark', Moon],
    ['system', 'System', Monitor],
  ];
  return (
    <div className="theme" role="radiogroup" aria-label={tr('Theme')}>
      {opts.map(([k, label, Icon]) => (
        <button key={k} role="radio" aria-checked={t === k} className={t === k ? 'on' : ''} title={k === 'system' ? tr('Follow the browser / OS setting') : tr(`${label} mode`)} onClick={() => setT(k)}>
          <Icon />
          <span className="theme-label">{tr(label)}</span>
        </button>
      ))}
    </div>
  );
}
