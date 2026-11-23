import { useEffect, useState } from 'react';
import Simulator from './pages/Simulator';
import Batch from './pages/Batch';
import Measures from './pages/Measures';
import Admin from './pages/Admin';
import { api, fmtDate } from './api';

const PAGES = [
  { id: 'simulateur', label: 'Simulateur' },
  { id: 'lot', label: 'Lot Excel' },
  { id: 'mesures', label: 'Mesures en vigueur' },
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
  const [meta, setMeta] = useState<any>(null);
  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
  }, [page]);
  const upd = (m: any) => (m?.at ? `${fmtDate(m.at)}${m.source?.startsWith('seed') ? ' (démo)' : ''}` : '—');
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => go('simulateur')}>
          <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
            <rect width="32" height="32" rx="7" fill="var(--navy)" />
            <path d="M7 20h18M7 12h18" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
            <path d="M21 8l4 4-4 4M11 16l-4 4 4 4" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <div className="brand-title">SLSC TARIFF SIMULATOR</div>
            <div className="brand-sub">Simulateur de droits Canada ⇄ États-Unis</div>
          </div>
        </div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} className={page === p.id ? 'active' : ''} href={`#/${p.id}`}>
              {p.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {page === 'simulateur' && <Simulator />}
        {page === 'lot' && <Batch />}
        {page === 'mesures' && <Measures />}
        {page === 'admin' && <Admin />}
      </main>
      <footer className="notice">
        <div className="notice-text">
          <b>⚠️ Important Notice:</b> This document is provided for informational purposes only.
          <br />
          Due to frequent changes in U.S. tariff rates, some information may become outdated or inaccurate.
          <br />
          <b>FOR INFORMATIONAL PURPOSES ONLY, OFFER WITHOUT WARRANTY</b>
        </div>
        <div className="notice-dates">
          <span>
            <b>USITC LAST UPDATE</b> : {upd(meta?.us)}
          </span>
          <span>
            <b>ASFC LAST UPDATE</b> : {upd(meta?.ca)}
          </span>
          <span>
            <b>CURRENCY CONVERTER UPDATE</b> : {meta?.fx?.date ? `${meta.fx.date} (1 USD = ${meta.fx.usdCad.toFixed(4)} CAD)` : '— (taux par défaut)'}
          </span>
        </div>
      </footer>
    </div>
  );
}
