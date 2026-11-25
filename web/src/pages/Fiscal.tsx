import { useEffect, useMemo, useState } from 'react';
import { getLang, useI18n } from '../i18n';

type Cur = 'CAD' | 'USD' | 'EUR';
interface FxData {
  latest: { usdCad: number; eurCad: number; date?: string; source: string };
  history: { date: string; USDCAD?: number; EURCAD?: number }[];
}

const nf = (n: number, d = 4) => new Intl.NumberFormat(getLang() === 'fr' ? 'fr-CA' : 'en-CA', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const money = (n: number, c: Cur) =>
  new Intl.NumberFormat(getLang() === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: c, currencyDisplay: 'code', maximumFractionDigits: 2 }).format(n);

export default function Fiscal() {
  const { t } = useI18n();
  const [days, setDays] = useState(90);
  const [d, setD] = useState<FxData | null>(null);
  const [err, setErr] = useState('');
  const [amount, setAmount] = useState('10000');
  const [from, setFrom] = useState<Cur>('USD');

  useEffect(() => {
    fetch(`/api/fx?days=${days}`)
      .then((r) => r.json())
      .then(setD)
      .catch((e) => setErr(String(e)));
  }, [days]);

  // Value of 1 unit of each currency in CAD
  const inCad = useMemo(() => (d ? ({ CAD: 1, USD: d.latest.usdCad, EUR: d.latest.eurCad } as Record<Cur, number>) : null), [d]);
  const amt = Number(amount.replace(/\s/g, '').replace(',', '.')) || 0;

  if (err) return <div className="card">{err}</div>;
  if (!d || !inCad) return <div className="card">{t('Loading…')}</div>;
  const eurUsd = d.latest.eurCad / d.latest.usdCad;
  const last = [...d.history].reverse();
  const prev = (k: 'USDCAD' | 'EURCAD') => last.find((x, i) => i > 0 && x[k])?.[k];

  return (
    <div className="fiscal">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{t('Exchange rates used by the simulator')}</h2>
        <p className="small muted">
          {t('Source: {source}', { source: d.latest.source })}
          {d.latest.date ? ` · ${t('rate of {date}', { date: d.latest.date })}` : ''} · {t('updated automatically every business day')}
        </p>
        <div className="fx-tiles">
          <Tile pair="USD → CAD" v={d.latest.usdCad} inv={`1 CAD = ${nf(1 / d.latest.usdCad)} USD`} prev={prev('USDCAD')} />
          <Tile pair="EUR → CAD" v={d.latest.eurCad} inv={`1 CAD = ${nf(1 / d.latest.eurCad)} EUR`} prev={prev('EURCAD')} />
          <Tile pair="EUR → USD" v={eurUsd} inv={`1 USD = ${nf(1 / eurUsd)} EUR`} note={t('cross rate')} />
        </div>
      </div>

      <div className="grid2 gap">
        <div className="card">
          <h3>{t('Currency converter')}</h3>
          <div className="join">
            <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <select className="input" value={from} onChange={(e) => setFrom(e.target.value as Cur)} style={{ maxWidth: 100 }}>
              <option>CAD</option>
              <option>USD</option>
              <option>EUR</option>
            </select>
          </div>
          <table className="simple" style={{ marginTop: 10 }}>
            <tbody>
              {(['CAD', 'USD', 'EUR'] as Cur[])
                .filter((c) => c !== from)
                .map((c) => (
                  <tr key={c}>
                    <td>{money(amt, from)}</td>
                    <td>=</td>
                    <td className="r">
                      <b>{money((amt * inCad[from]) / inCad[c], c)}</b>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>{t('Which rate does customs use?')}</h3>
          <ul className="small fx-rules">
            <li>
              <b>INBOUND CANADA</b> — {t('CBSA: Bank of Canada rates (the ones used here).')}
            </li>
            <li>
              <b>INBOUND USA</b> — {t('CBP: rates certified by the Federal Reserve Bank of New York for the date of exportation.')}
            </li>
            <li>
              <b>INBOUND EU</b> — {t('EU: monthly customs exchange rates set from the European Central Bank rate (published by the Commission).')}
            </li>
          </ul>
          <p className="small muted">{t('The simulator converts with the Bank of Canada rate in all three directions: the official customs conversion can differ slightly.')}</p>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginTop: 0, justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>{t('History')}</h3>
          <div className="seg small" style={{ maxWidth: 280 }}>
            {[30, 90, 365].map((n) => (
              <button key={n} className={days === n ? 'on' : ''} onClick={() => setDays(n)}>
                {t('{n} days', { n })}
              </button>
            ))}
          </div>
        </div>
        {d.history.length < 2 ? (
          <div className="muted small">{t('History not available yet: it is filled by the first Bank of Canada import.')}</div>
        ) : (
          <>
            <Chart data={d.history} />
            <table className="simple fx-table">
              <thead>
                <tr>
                  <th>{t('Date')}</th>
                  <th className="r">USD → CAD</th>
                  <th className="r">EUR → CAD</th>
                  <th className="r">EUR → USD</th>
                </tr>
              </thead>
              <tbody>
                {last.slice(0, 15).map((r) => (
                  <tr key={r.date}>
                    <td className="mono">{r.date}</td>
                    <td className="r mono">{r.USDCAD ? nf(r.USDCAD) : '—'}</td>
                    <td className="r mono">{r.EURCAD ? nf(r.EURCAD) : '—'}</td>
                    <td className="r mono">{r.USDCAD && r.EURCAD ? nf(r.EURCAD / r.USDCAD) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ pair, v, inv, prev, note }: { pair: string; v: number; inv: string; prev?: number; note?: string }) {
  const diff = prev ? v - prev : undefined;
  return (
    <div className="fx-tile">
      <span className="fx-pair">
        {pair}
        {note && <em> · {note}</em>}
      </span>
      <b>{nf(v)}</b>
      <span className="fx-inv">
        {inv}
        {diff !== undefined && Math.abs(diff) > 0 && (
          <span className={diff > 0 ? 'up' : 'down'}>
            {' '}
            {diff > 0 ? '▲' : '▼'} {nf(Math.abs(diff))}
          </span>
        )}
      </span>
    </div>
  );
}

/** Two-series line chart (USD→CAD, EUR→CAD), each on its own scale so both stay readable. */
function Chart({ data }: { data: FxData['history'] }) {
  const W = 900;
  const H = 220;
  const P = { l: 54, r: 54, t: 14, b: 26 };
  const series = [
    { k: 'USDCAD' as const, label: 'USD → CAD', cls: 'fx-usd', side: 'l' as const },
    { k: 'EURCAD' as const, label: 'EUR → CAD', cls: 'fx-eur', side: 'r' as const },
  ];
  const x = (i: number) => P.l + (i / Math.max(1, data.length - 1)) * (W - P.l - P.r);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fx-chart" role="img" aria-label="USD/CAD and EUR/CAD">
      {series.map((s) => {
        const vals = data.map((r) => r[s.k]).filter((v): v is number => !!v);
        if (!vals.length) return null;
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const pad = (max - min) * 0.1 || 0.01;
        const y = (v: number) => P.t + (1 - (v - (min - pad)) / (max - min + 2 * pad)) * (H - P.t - P.b);
        const pts = data.map((r, i) => (r[s.k] ? `${x(i).toFixed(1)},${y(r[s.k]!).toFixed(1)}` : null)).filter(Boolean);
        const ax = s.side === 'l' ? P.l - 6 : W - P.r + 6;
        return (
          <g key={s.k}>
            <polyline className={s.cls} points={pts.join(' ')} fill="none" strokeWidth="2" />
            {[max, min].map((v) => (
              <text key={v} x={ax} y={y(v) + 4} textAnchor={s.side === 'l' ? 'end' : 'start'} className={`fx-axis ${s.cls}-t`}>
                {v.toFixed(4)}
              </text>
            ))}
          </g>
        );
      })}
      <text x={P.l} y={H - 6} className="fx-axis">
        {data[0].date}
      </text>
      <text x={W - P.r} y={H - 6} textAnchor="end" className="fx-axis">
        {data[data.length - 1].date}
      </text>
      <g transform={`translate(${P.l + 8}, ${P.t + 6})`}>
        {series.map((s, i) => (
          <g key={s.k} transform={`translate(${i * 120}, 0)`}>
            <line x1="0" x2="16" y1="0" y2="0" className={s.cls} strokeWidth="3" />
            <text x="22" y="4" className="fx-axis">
              {s.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
