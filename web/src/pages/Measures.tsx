import { useEffect, useState } from 'react';
import { api, type Country } from '../api';
import { useI18n } from '../i18n';

function St({ s }: { s?: string }) {
  const { t } = useI18n();
  return s === 'verified' || s === 'vérifié' ? <span className="badge ok">{t('verified')}</span> : <span className="badge warn">{t('to verify')}</span>;
}

export default function Measures() {
  const { t, lang } = useI18n();
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<'us' | 'ca' | 'eu' | 'adcvd' | 'lic'>('us');
  useEffect(() => {
    api.measures().then(setD);
  }, [lang]);
  if (!d) return <div className="card">{t('Loading…')}</div>;
  return (
    <div className="wide">
      <div className="seg small">
        <button className={tab === 'us' ? 'on' : ''} onClick={() => setTab('us')}>INBOUND USA</button>
        <button className={tab === 'ca' ? 'on' : ''} onClick={() => setTab('ca')}>INBOUND CANADA</button>
        <button className={tab === 'eu' ? 'on' : ''} onClick={() => setTab('eu')}>INBOUND EU</button>
        <button className={tab === 'adcvd' ? 'on' : ''} onClick={() => setTab('adcvd')}>AD/CVD · SIMA</button>
        <button className={tab === 'lic' ? 'on' : ''} onClick={() => setTab('lic')}>{t('Licences and permits')}</button>
      </div>

      {tab === 'us' && (
        <>
          <div className="card">
            <h3>{t('Chapter 99 programs (detected automatically from HTSUS references)')}</h3>
            <p className="muted small">{t('{n} 9903 headings loaded from the USITC export; their rates are read directly from the "General" column.', { n: d.us.ch99Count })}</p>
            <table className="simple">
              <thead><tr><th>{t('Program')}</th><th>{t('Headings')}</th><th>{t('Status')}</th><th>{t('Notes')}</th></tr></thead>
              <tbody>
                {d.us.programs.map((p: any) => (
                  <tr key={p.id}>
                    <td><b>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}</b><div className="muted small mono">{p.id}</div></td>
                    <td className="mono small">{(p.prefixes ?? []).join(', ') || t('detected by description')}</td>
                    <td><St s={p.status} /></td>
                    <td className="small">{p.note}{p.lists?.length > 0 && <ul>{p.lists.map((l: any) => <li key={l.id}>{l.label} — {l.rate}%{l.capCombinedPct ? ` (${t('combined cap')} ${l.capCombinedPct}%)` : ''} {l.listCount > 0 ? <span className="badge ok">{t('list: {n} codes', { n: l.listCount })}</span> : <span className="badge warn">{l.prefixes?.length ? t('indicative prefixes') : t('list to import')}</span>}</li>)}</ul>}{p.options && <ul>{Object.entries(p.options).map(([k, o]: any) => <li key={k}>{o.label} <St s={o.status} /></li>)}</ul>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MeasureTable title={t('Measures by country of origin')} list={d.us.measures} />
          <RegimeTable list={d.us.regimes} />
          <div className="card">
            <h3>{t('Fees')}</h3>
            <p className="small">{t('MPF: {pct}% (min. ${min}, max. ${max}) — exempt for USMCA-originating goods from Canada/Mexico. HMF: {hmf}% (ocean).', { pct: d.us.fees.mpf.pct, min: d.us.fees.mpf.min, max: d.us.fees.mpf.max, hmf: d.us.fees.hmf.pct })}</p>
          </div>
        </>
      )}
      {tab === 'ca' && (
        <>
          <MeasureTable title={t('Canadian surtaxes and measures')} list={d.ca.measures} />
          <RegimeTable list={d.ca.regimes} />
          <div className="card">
            <h3>{t('Taxes')}</h3>
            <p className="small">{t('GST')} {d.ca.taxes.gst.pct}%; {t('HST')}: {Object.entries(d.ca.taxes.hst).map(([p, r]) => `${p} ${r}%`).join(', ')}. {d.ca.taxes.note}</p>
          </div>
        </>
      )}
      {tab === 'eu' && <EuMeasures />}
      {tab === 'adcvd' && (
        <>
          <div className="card">
            <h3>{t('United States — tracked AD/CVD orders')}</h3>
            <table className="simple">
              <thead><tr><th>{t('Case')}</th><th>{t('Product')}</th><th>{t('Origin')}</th><th>{t('All-others rate')}</th><th>{t('HS (indicative)')}</th></tr></thead>
              <tbody>
                {d.adcvd.us.cases.map((c: any) => (
                  <tr key={c.case}><td className="mono">{c.case}</td><td>{c.product}<div className="muted small">{c.note}</div></td><td>{c.country}</td><td>{c.allOthers ? `AD ${c.allOthers.ad ?? '—'}% · CVD ${c.allOthers.cvd ?? '—'}%` : t('exporter-specific')}</td><td className="mono small">{c.prefixes.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">{t('Full search:')} <a href={d.adcvd.us.searchUrl} target="_blank" rel="noreferrer">CBP ADCVD Search</a>. {t('Generic warning for origins:')} {d.adcvd.us.riskOrigins.join(', ')}.</p>
          </div>
          <div className="card">
            <h3>{t('Canada — SIMA measures in force')}</h3>
            <table className="simple">
              <thead><tr><th>{t('MIF code')}</th><th>{t('Product')}</th><th>{t('Countries')}</th><th>{t('HS (indicative)')}</th></tr></thead>
              <tbody>
                {d.adcvd.ca.cases.map((c: any) => (
                  <tr key={c.case}><td className="mono">{c.case}</td><td>{c.product}</td><td>{(c.countries ?? [c.country]).join(', ')}</td><td className="mono small">{c.prefixes.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">{t('Source:')} <a href={d.adcvd.ca.searchUrl} target="_blank" rel="noreferrer">{t('CBSA — Measures in force')}</a>.</p>
          </div>
        </>
      )}
      {tab === 'lic' && (
        <>
          {(['us', 'ca'] as const).map((k) => (
            <div className="card" key={k}>
              <h3>{k === 'us' ? t('United States — PGAs and licenses') : t('Canada — other government departments and ICL')}</h3>
              <table className="simple">
                <thead><tr><th>{t('Agency')}</th><th>{t('Requirement')}</th><th>{t('Level')}</th><th>HS</th></tr></thead>
                <tbody>
                  {d.licences[k].map((l: any, i: number) => (
                    <tr key={i}><td>{l.agency}</td><td>{l.label}</td><td>{t(l.level)}</td><td className="mono small">{l.prefixes.join(', ') || t('all')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function MeasureTable({ title, list }: { title: string; list: any[] }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <h3>{title}</h3>
      <table className="simple">
        <thead><tr><th>{t('Measure')}</th><th>{t('Rate')}</th><th>{t('Origins')}</th><th>{t('Scope')}</th><th>{t('Status')}</th></tr></thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.id}>
              <td>
                <b>{m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.name}</a> : m.name}</b>
                <div className="muted small">{m.legal}</div>
                {m.note && <div className="small">{m.note}</div>}
              </td>
              <td>{m.kind === 'ban' ? t('Prohibition') : m.rate !== undefined ? `${m.rate}%` : m.originRates ? t('by country') : '—'}</td>
              <td className="small">{m.origins?.join(', ') ?? (m.excludeOrigins ? `${t('except')} ${m.excludeOrigins.join(', ')}` : t('all'))}</td>
              <td className="small">
                {m.scope.all ? t('All goods') : m.listCount > 0 ? <span className="badge ok">{t('list: {n} codes', { n: m.listCount })}</span> : m.scope.codeList ? <span className="badge warn">{t('list to import')}</span> : ''}
                {m.scope.prefixes && m.listCount === 0 && <div className="muted">{t('indicative prefixes')}: {m.scope.prefixes.length}</div>}
              </td>
              <td><St s={m.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegimeTable({ list }: { list: any[] }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <h3>{t('Special regimes offered')}</h3>
      <table className="simple">
        <tbody>
          {list.filter((r) => r.id !== 'none').map((r) => (
            <tr key={r.id}><td className="mono">{r.code ?? ''}</td><td><b>{r.label}</b><div className="small muted">{r.note}</div></td><td><St s={r.status} /></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EuMeasures() {
  const { t, lang } = useI18n();
  const [origin, setOrigin] = useState('CA');
  const [d, setD] = useState<any>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  useEffect(() => {
    api.countries().then(setCountries).catch(() => {});
  }, []);
  useEffect(() => {
    setD(null);
    api.measuresEu(origin).then(setD).catch(() => setD({ error: true }));
  }, [origin, lang]);
  const name = (c: string) => countries.find((x) => x.code === c)?.[lang === 'fr' ? 'fr' : 'en'] ?? c;
  const Table = ({ title, rows, quota }: { title: string; rows: any[]; quota?: boolean }) => (
    <div className="card">
      <h3>
        {title} <span className="muted small">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <div className="muted small">{t('None for this origin.')}</div>
      ) : (
        <table className="simple">
          <thead>
            <tr>
              {quota && <th>{t('Order No.')}</th>}
              <th>{t('Measure')}</th>
              <th>{t('Origin')}</th>
              <th>{t('Duty')}</th>
              <th>{t('Legal base')}</th>
              <th className="r">{t('Codes')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any, i: number) => (
              <tr key={i}>
                {quota && <td className="mono">{r.order_no || '—'}</td>}
                <td>
                  {r.type_desc} <span className="muted small mono">{r.type}</span>
                </td>
                <td>{r.origin === '1011' ? t('All third countries (ERGA OMNES)') : r.origin_desc || r.origin}</td>
                <td className="mono small">{r.duty === r.duty_max ? r.duty : `${r.duty} … ${r.duty_max}`}</td>
                <td className="mono small">{r.legal}</td>
                <td className="r">
                  {r.codes} <span className="muted small mono">({r.first_code}{r.codes > 1 ? '…' : ''})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
  return (
    <>
      <div className="card">
        <div className="row" style={{ marginTop: 0 }}>
          <label className="lbl" style={{ margin: 0 }}>{t('Country of origin')}</label>
          <select className="input" style={{ maxWidth: 320 }} value={origin} onChange={(e) => setOrigin(e.target.value)}>
            {[...countries]
              .sort((a, b) => (lang === 'fr' ? a.fr.localeCompare(b.fr, 'fr') : a.en.localeCompare(b.en, 'en')))
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {lang === 'fr' ? c.fr : c.en} ({c.code})
                </option>
              ))}
          </select>
          <span className="small muted">{t('Measures of TARIC that apply to this origin (country, its groups and ERGA OMNES).')}</span>
        </div>
        {d && !d.error && !d.imported && <div className="alert warning">{t('The EU tariff (TARIC) has not been imported yet: import it in Admin.')}</div>}
      </div>
      {!d && <div className="card">{t('Loading…')}</div>}
      {d && !d.error && (
        <>
          <Table title={t('Preferences (free trade agreements)')} rows={d.preferences} />
          <Table title={t('Tariff quotas')} rows={d.quotas} quota />
          <Table title={t('Anti-dumping / countervailing')} rows={d.antiDumping} />
          <Table title={t('Additional duties (safeguard, countermeasures)')} rows={d.additional} />
          <div className="grid2 gap">
            <div className="card">
              <h3>{t('Import VAT by member state')}</h3>
              <table className="simple">
                <tbody>
                  {Object.entries(d.vat as Record<string, number>)
                    .sort((a, b) => name(a[0]).localeCompare(name(b[0]), lang))
                    .map(([c, r]) => (
                      <tr key={c}>
                        <td>{name(c)}</td>
                        <td className="mono">{c}</td>
                        <td className="r">{r} %</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <p className="small muted">{d.vatNote}</p>
            </div>
            <div className="card">
              <h3>{t('EU free trade agreements')}</h3>
              <table className="simple">
                <tbody>
                  {Object.entries(d.agreements as Record<string, any>).map(([c, a]) => (
                    <tr key={c}>
                      <td className="mono">{c}</td>
                      <td>{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.name}</a> : a.name}</td>
                      <td className="muted small">{a.short}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
