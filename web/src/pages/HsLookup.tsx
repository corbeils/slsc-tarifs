import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import Classifier from '../components/Classifier';

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
    const saved = JSON.parse(sessionStorage.getItem('slsc-tarifs-form') ?? '{}');
    sessionStorage.setItem(
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
  const [err, setErr] = useState('');
  const [hs6, setHs6] = useState('');
  const [detail, setDetail] = useState<{ hs6: string; heading: string | null; lines: HsLine[] } | null>(null);

  useEffect(() => {
    if (!hs6) return;
    setDetail(null);
    api.lookupHs(hs6).then(setDetail).catch((e) => setErr(e.message));
  }, [hs6]);

  return (
    <div className="lookup">
      {err && <div className="alert danger">{err}</div>}
      <Classifier onCompare={(h) => { setHs6(h); setTimeout(() => document.getElementById('hs-detail')?.scrollIntoView({ behavior: 'smooth' }), 300); }} />
      {hs6 && (
        <div className="card" id="hs-detail">
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
