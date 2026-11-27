import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate } from '../api';
import { useI18n } from '../i18n';

interface Item {
  id: string;
  source: string;
  jurisdiction: 'US' | 'CA' | 'EU';
  title: string;
  url: string;
  date: string;
  summary: string;
  doc_type: string;
  first_seen: string;
}

const SEEN_KEY = 'slsc-news-seen';
const FLAG: Record<string, string> = { US: '🇺🇸', CA: '🇨🇦', EU: '🇪🇺' };
const NAME: Record<string, string> = { US: 'United States', CA: 'Canada', EU: 'European Union' };

/** Customs news from official sources (Federal Register, CBSA, Finance Canada, EU Official Journal, DG TAXUD). */
export default function News() {
  const { t, lang } = useI18n();
  const [j, setJ] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ at: string | null; items: Item[] } | null>(null);
  const [err, setErr] = useState('');
  // Items first seen after the previous visit are marked "New"
  const [lastVisit] = useState(() => {
    try {
      return localStorage.getItem(SEEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, new Date().toISOString());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const ctl = setTimeout(() => {
      api
        .news(lang, j, q)
        .then((d) => {
          setData(d);
          setErr('');
        })
        .catch((e) => setErr(e.message));
    }, q ? 300 : 0);
    return () => clearTimeout(ctl);
  }, [lang, j, q]);

  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of data?.items ?? []) m.set(it.date, [...(m.get(it.date) ?? []), it]);
    return [...m.entries()];
  }, [data]);

  const day = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="wide news">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t("What's new in customs")}</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          {t('Notices, proclamations, regulations and announcements published by official sources, checked automatically every 6 hours.')}{' '}
          {data?.at && <>{t('Last check: {d}', { d: fmtDate(data.at) })}</>}
        </p>
        <div className="news-filters">
          <div className="seg small">
            {['', 'US', 'CA', 'EU'].map((k) => (
              <button key={k || 'all'} className={j === k ? 'on' : ''} onClick={() => setJ(k)}>
                {k ? `${FLAG[k]} ${t(NAME[k])}` : t('All')}
              </button>
            ))}
          </div>
          <input className="input" placeholder={t('Search (e.g. steel, 232, surtax, anti-dumping)')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {err && <div className="alert">{err}</div>}
      {data && !data.items.length && (
        <div className="card muted">{data.at ? t('No item for this filter.') : t('The first check of the sources has not run yet. Come back in a few minutes.')}</div>
      )}

      {byDay.map(([d, items]) => (
        <div key={d} className="news-day">
          <div className="news-date">{day(d)}</div>
          {items.map((it) => (
            <a key={it.id} className="card news-item" href={it.url} target="_blank" rel="noopener noreferrer">
              <div className="news-meta">
                <span className={`badge j-${it.jurisdiction}`}>
                  {FLAG[it.jurisdiction]} {it.jurisdiction}
                </span>
                <span className="muted small">{it.source}</span>
                {it.doc_type && <span className="badge muted">{it.doc_type}</span>}
                {lastVisit && it.first_seen > lastVisit && <span className="badge ok">{t('New')}</span>}
              </div>
              <div className="news-title">{it.title}</div>
              {it.summary && <div className="news-summary small">{it.summary.length > 280 ? it.summary.slice(0, 280) + '…' : it.summary}</div>}
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}
