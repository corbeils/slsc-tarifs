import { useEffect, useState } from 'react';
import Simulator from './pages/Simulator';
import Batch from './pages/Batch';
import Measures from './pages/Measures';
import HsLookup from './pages/HsLookup';
import Admin from './pages/Admin';
import ThemeToggle from './components/ThemeToggle';
import { api, fmtDate, session } from './api';
import { LangToggle, useI18n } from './i18n';
import { CurrencyToggle } from './currency';
import { useAuth } from './auth';

const PAGES = [
  { id: 'simulateur', label: 'Simulator', access: 'public' },
  { id: 'lot', label: 'Batch simulator', access: 'public' },
  // Measures in force: reached from the footer (MEASURES LAST UPDATE), no longer in the top menu
  { id: 'mesures', label: 'Measures in force', access: 'user', hidden: true },
  { id: 'hscode', label: 'HS code lookup', access: 'user' },
  { id: 'admin', label: 'Admin', access: 'admin' },
] as const;
type Access = (typeof PAGES)[number]['access'];
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
  const { user, ready } = useAuth();
  const [showLog, setShowLog] = useState(false);
  const can = (a: Access) => a === 'public' || (a === 'user' && !!user) || (a === 'admin' && user?.role === 'admin');
  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
  }, [page, lang]);
  useEffect(() => {
    const on = () => api.meta().then(setMeta).catch(() => {});
    window.addEventListener('slsc-meta', on);
    return () => window.removeEventListener('slsc-meta', on);
  }, []);
  // Last refresh of the official lists (automatic sync, otherwise the latest list import)
  const measuresAt: string | undefined =
    meta?.officialLists?.at ?? (meta?.codeLists as { at?: string }[] | undefined)?.reduce<string | undefined>((m, x) => (x.at && (!m || x.at > m) ? x.at : m), undefined);
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
            {PAGES.filter((p) => can(p.access) && !('hidden' in p)).map((p) => (
              <a key={p.id} className={page === p.id ? 'active' : ''} href={`#/${p.id}`}>
                {t(p.label)}
              </a>
            ))}
            {ready && user?.role === 'user' && (
              <a className={page === 'admin' ? 'active' : ''} href="#/admin">
                {t('My account')}
              </a>
            )}
            {ready && !user && (
              <a className={page === 'admin' ? 'active' : ''} href="#/admin">
                {t('Sign in')}
              </a>
            )}
          </nav>
          <LangToggle />
          <CurrencyToggle />
          <ThemeToggle />
        </div>
      </header>
      <main>
        {page === 'simulateur' && <Simulator />}
        {page === 'lot' && <Batch />}
        {page === 'mesures' && (can('user') ? <Measures /> : <SignInFirst />)}
        {page === 'hscode' && (can('user') ? <HsLookup /> : <SignInFirst />)}
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
            <b>{t('MEASURES LAST UPDATE')}</b> :{' '}
            <a className="linklike" href="#/mesures" title={t('View all measures in force')}>
              {measuresAt ? fmtDate(measuresAt) : '—'}
            </a>
          </span>
          <span>
            <b>{t('SITE VERSION')}</b> :{' '}
            {meta?.site ? (
              <button className="linklike" title={t('View the changelog')} onClick={() => setShowLog(true)}>
                {t(meta.site.beta ? 'BETA VERSION {v}' : 'VERSION {v}', { v: meta.site.version })}
              </button>
            ) : (
              '—'
            )}
          </span>
        </div>
      </footer>
      {showLog && <ChangelogPopup onClose={() => setShowLog(false)} />}
    </div>
  );
}

function SignInFirst() {
  const { t } = useI18n();
  return (
    <div className="card">
      {t('This tab is reserved for signed-in users.')} <a href="#/admin">{t('Sign in')}</a>
    </div>
  );
}

function ChangelogPopup({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [log, setLog] = useState<{ version: string; beta: boolean; at: string; notes: string }[] | null>(null);
  useEffect(() => {
    api.changelog().then(setLog).catch(() => setLog([]));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('Changelog')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t('Changelog')}</h3>
          <button className="btn ghost" aria-label={t('Close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {log === null ? (
            <div className="muted small">{t('Loading…')}</div>
          ) : log.length === 0 ? (
            <div className="muted small">{t('No version notes yet.')}</div>
          ) : (
            log.map((x, i) => (
              <div key={i} className="log-entry">
                <div className="log-head">
                  <b className="mono">{t(x.beta ? 'BETA VERSION {v}' : 'VERSION {v}', { v: x.version })}</b>
                  {i === 0 && <span className="badge ok">{t('Current')}</span>}
                  <span className="muted small">{fmtDate(x.at)}</span>
                </div>
                <div className="log-notes">{x.notes || <span className="muted">—</span>}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
