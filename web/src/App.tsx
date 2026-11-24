import { useEffect, useState } from 'react';
import Simulator from './pages/Simulator';
import Batch from './pages/Batch';
import Measures from './pages/Measures';
import Admin from './pages/Admin';
import ThemeToggle from './components/ThemeToggle';
import { api, fmtDate } from './api';
import { LangToggle, useI18n } from './i18n';

const PAGES = [
  { id: 'simulateur', label: 'Simulator' },
  { id: 'lot', label: 'Batch simulator' },
  { id: 'mesures', label: 'Measures in force' },
  { id: 'admin', label: 'Admin' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

function usePage(): [PageId, (p: PageId) => void] {
  const read = () => (location.hash.replace('#/', '') || 'simulateur') as PageId;
  const [p, setP] = useState<PageId>(read());
  useEffect(() => {
    const on = () => setP(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [p, (x) => (location.hash = `#/${x}`)];
}

export default function App() {
  const [page, go] = usePage();
  const { t, lang } = useI18n();
  const [meta, setMeta] = useState<any>(null);
  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
  }, [page, lang]);
  useEffect(() => {
    const on = () => api.meta().then(setMeta).catch(() => {});
    window.addEventListener('slsc-meta', on);
    return () => window.removeEventListener('slsc-meta', on);
  }, []);
  const upd = (m: any) => (m?.at ? `${fmtDate(m.at)}${m.source?.startsWith('seed') ? t(' (demo)') : ''}` : '—');
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => go('simulateur')}>
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 100 64">
              <g transform="skewX(-12) translate(10 0)" fill="none" strokeLinejoin="round">
                <path d="M44 16H21C11 16 11 32 21 32H31C41 32 41 48 31 48H6" stroke="#dfe1e6" strokeWidth="11" />
                <path d="M92 16H66C54 16 54 48 66 48H92" stroke="#dfe1e6" strokeWidth="11" />
                <path d="M38 24L26 60" stroke="#8cdb00" strokeWidth="3.2" strokeDasharray="5 3.5" />
              </g>
            </svg>
          </span>
          <div>
            <div className="brand-title">SLSC TARIFF SIMULATOR</div>
            <div className="brand-sub">{t('Canada · United States · European Union duty simulator')}</div>
          </div>
        </div>
        <div className="topbar-right">
          <nav>
            {PAGES.map((p) => (
              <a key={p.id} className={page === p.id ? 'active' : ''} href={`#/${p.id}`}>
                {t(p.label)}
              </a>
            ))}
          </nav>
          <LangToggle />
          <ThemeToggle />
        </div>
      </header>
      <main>
        {page === 'simulateur' && <Simulator />}
        {page === 'lot' && <Batch />}
        {page === 'mesures' && <Measures />}
        {page === 'admin' && <Admin />}
      </main>
      <footer className="notice">
        <div className="notice-text">
          <b>⚠️ {t('Important Notice:')}</b> {t('This site is provided for informational purposes only, offered without any warranty')}
          <br />
          {t('Due to frequent changes in U.S. tariff rates, some information may become outdated or inaccurate.')}
        </div>
        <div className="notice-dates">
          <span>
            <b>{t('USITC LAST UPDATE')}</b> : {upd(meta?.us)}
          </span>
          <span>
            <b>{t('ASFC LAST UPDATE')}</b> : {upd(meta?.ca)}
          </span>
          <span>
            <b>{t('TARIC LAST UPDATE')}</b> : {upd(meta?.eu)}
          </span>
          <span>
            <b>{t('SITE VERSION')}</b> : {meta?.site ? t(meta.site.beta ? 'BETA VERSION {v}' : 'VERSION {v}', { v: meta.site.version }) : '—'}
          </span>
        </div>
      </footer>
    </div>
  );
}
