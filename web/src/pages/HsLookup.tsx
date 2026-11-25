import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

type J = 'US' | 'CA' | 'EU';
interface Hit {
  j: J;
  code: string;
  display: string;
  description: string;
  path?: string;
  is_leaf: number;
}
interface HsLine extends Hit {
  rate: string | null;
  special: string | null;
  other: string | null;
  ust: string | null;
}

const DIR: Record<J, string> = { US: 'CA-US', CA: 'US-CA', EU: 'IN-EU' };
const NAME: Record<J, string> = { US: 'INBOUND USA', CA: 'INBOUND CANADA', EU: 'INBOUND EU' };
const hs6Of = (code: string) => code.slice(0, 6);
const fmt6 = (c: string) => `${c.slice(0, 4)}.${c.slice(4, 6)}`;

/** Opens the simulator on this line (direction + code). */
function simulate(h: Hit) {
  try {
    const saved = JSON.parse(localStorage.getItem('slsc-tarifs-form') ?? '{}');
    localStorage.setItem(
      'slsc-tarifs-form',
      JSON.stringify({ ...saved, direction: DIR[h.j], hit: { code: h.code, display: h.display, description: h.description, path: h.path ?? '', is_leaf: h.is_leaf }, currency: h.j === 'US' ? 'USD' : h.j === 'EU' ? 'EUR' : 'CAD' }),
    );
  } catch {
    /* ignore */
  }
  location.hash = '#/simulateur';
  location.reload();
}

export default function HsLookup() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [js, setJs] = useState<J[]>(['US', 'CA', 'EU']);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState('');
  const [hs6, setHs6] = useState('');
  const [detail, setDetail] = useState<{ hs6: string; heading: string | null; lines: HsLine[] } | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      return;
    }
    const tm = setTimeout(() => {
      api
        .lookup(q, js.join(','))
        .then((r) => {
          setHits(r);
          setErr('');
        })
        .catch((e) => setErr(e.status === 401 ? t('Your session has expired: sign in again in Admin.') : e.message));
    }, 300);
    return () => clearTimeout(tm);
  }, [q, js.join(',')]);

  useEffect(() => {
    if (!hs6) return;
    setDetail(null);
    api.lookupHs(hs6).then(setDetail).catch((e) => setErr(e.message));
  }, [hs6]);

  const toggle = (j: J) => setJs((x) => (x.includes(j) ? (x.length > 1 ? x.filter((y) => y !== j) : x) : [...x, j]));
  const groups = (['US', 'CA', 'EU'] as J[]).filter((j) => js.includes(j)).map((j) => [j, (hits ?? []).filter((h) => h.j === j)] as const);

  return (
    <div className="lookup">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t('HS code lookup')}</h2>
        <p className="small muted">{t('Search a product by keywords (in English) or by code in the three tariffs at once. Click a result to compare the 6-digit HS subheading in the United States, Canada and the EU.')}</p>
        <div className="row" style={{ marginTop: 0 }}>
          <input className="input" style={{ flex: 1, minWidth: 260 }} autoFocus placeholder={t('e.g. forging press, gear box, 8462.11')} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            {(['US', 'CA', 'EU'] as J[]).map((j) => (
              <button key={j} className={`chip ${js.includes(j) ? 'on' : ''}`} onClick={() => toggle(j)}>
                {NAME[j]}
              </button>
            ))}
          </div>
        </div>
        {err && <div className="alert danger">{err}</div>}
      </div>

      {hits && (
        <div className="lookup-grid" style={{ gridTemplateColumns: `repeat(${groups.length}, 1fr)` }}>
          {groups.map(([j, list]) => (
            <div key={j} className="card">
              <h3>
                {NAME[j]} <span className="muted small">({list.length})</span>
              </h3>
              {list.length === 0 && <div className="muted small">{t(j === 'EU' ? 'No result (is the TARIC imported?)' : 'No result.')}</div>}
              <ul className="lookup-list">
                {list.map((h) => (
                  <li key={h.code} className={hs6 === hs6Of(h.code) ? 'on' : ''} onClick={() => setHs6(hs6Of(h.code))}>
                    <span className="mono">{h.display}</span>
                    <span>
                      {h.description}
                      {h.path && <small className="muted">{h.path}</small>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {hs6 && (
        <div className="card">
          <h3>
            {t('HS subheading')} <span className="mono">{fmt6(hs6)}</span>
            {detail?.heading && <span className="muted small"> — {detail.heading}</span>}
          </h3>
          {!detail ? (
            <div className="muted small">{t('Loading…')}</div>
          ) : (
            <div className="lookup-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {(['US', 'CA', 'EU'] as J[]).map((j) => {
                const lines = detail.lines.filter((l) => l.j === j);
                return (
                  <div key={j}>
                    <div className="opts-title">{NAME[j]}</div>
                    {lines.length === 0 && <div className="muted small">{t('No line under this subheading.')}</div>}
                    <table className="simple">
                      <tbody>
                        {lines.map((l) => (
                          <tr key={l.code} className={l.is_leaf ? '' : 'dim'}>
                            <td className="mono">{l.display}</td>
                            <td>
                              {l.description}
                              {l.rate && (
                                <div className="small muted">
                                  {j === 'US' ? t('General') : j === 'CA' ? t('MFN') : t('Third country duty')}: <b className="mono">{l.rate}</b>
                                  {j === 'CA' && l.ust ? ` · UST: ${l.ust}` : ''}
                                </div>
                              )}
                            </td>
                            <td className="r">
                              {l.is_leaf ? (
                                <button className="btn ghost small" onClick={() => simulate(l)}>
                                  {t('Simulate')}
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
          <p className="small muted">{t('The first 6 digits (HS) are common to all three countries; the following digits are national and differ.')}</p>
        </div>
      )}
    </div>
  );
}
