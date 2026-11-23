import { useEffect, useState } from 'react';
import { api } from '../api';

function St({ s }: { s?: string }) {
  return s === 'verified' || s === 'vérifié' ? <span className="badge ok">verified</span> : <span className="badge warn">to verify</span>;
}

export default function Measures() {
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<'us' | 'ca' | 'adcvd' | 'lic'>('us');
  useEffect(() => {
    api.measures().then(setD);
  }, []);
  if (!d) return <div className="card">Loading…</div>;
  return (
    <div className="wide">
      <div className="seg small">
        <button className={tab === 'us' ? 'on' : ''} onClick={() => setTab('us')}>INBOUND USA</button>
        <button className={tab === 'ca' ? 'on' : ''} onClick={() => setTab('ca')}>INBOUND CANADA</button>
        <button className={tab === 'adcvd' ? 'on' : ''} onClick={() => setTab('adcvd')}>AD/CVD · SIMA</button>
        <button className={tab === 'lic' ? 'on' : ''} onClick={() => setTab('lic')}>Licences and permits</button>
      </div>

      {tab === 'us' && (
        <>
          <div className="card">
            <h3>Chapter 99 programs (detected automatically from HTSUS references)</h3>
            <p className="muted small">{d.us.ch99Count} 9903 headings loaded from the USITC export; their rates are read directly from the "General" column.</p>
            <table className="simple">
              <thead><tr><th>Program</th><th>Headings</th><th>Status</th><th>Notes</th></tr></thead>
              <tbody>
                {d.us.programs.map((p: any) => (
                  <tr key={p.id}>
                    <td><b>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}</b><div className="muted small mono">{p.id}</div></td>
                    <td className="mono small">{(p.prefixes ?? []).join(', ') || 'detected by description'}</td>
                    <td><St s={p.status} /></td>
                    <td className="small">{p.note}{p.lists?.length > 0 && <ul>{p.lists.map((l: any) => <li key={l.id}>{l.label} — {l.rate}%{l.capCombinedPct ? ` (combined cap ${l.capCombinedPct}%)` : ''} {l.listCount > 0 ? <span className="badge ok">list: {l.listCount} codes</span> : <span className="badge warn">{l.prefixes?.length ? 'indicative prefixes' : 'list to import'}</span>}</li>)}</ul>}{p.options && <ul>{Object.entries(p.options).map(([k, o]: any) => <li key={k}>{o.label} <St s={o.status} /></li>)}</ul>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MeasureTable title="Measures by country of origin" list={d.us.measures} />
          <RegimeTable list={d.us.regimes} />
          <div className="card">
            <h3>Fees</h3>
            <p className="small">MPF: {d.us.fees.mpf.pct}% (min. ${d.us.fees.mpf.min}, max. ${d.us.fees.mpf.max}) — exempt for USMCA-originating goods from Canada/Mexico. HMF: {d.us.fees.hmf.pct}% (ocean).</p>
          </div>
        </>
      )}
      {tab === 'ca' && (
        <>
          <MeasureTable title="Canadian surtaxes and measures" list={d.ca.measures} />
          <RegimeTable list={d.ca.regimes} />
          <div className="card">
            <h3>Taxes</h3>
            <p className="small">GST {d.ca.taxes.gst.pct}%; HST: {Object.entries(d.ca.taxes.hst).map(([p, r]) => `${p} ${r}%`).join(', ')}. {d.ca.taxes.note}</p>
          </div>
        </>
      )}
      {tab === 'adcvd' && (
        <>
          <div className="card">
            <h3>United States — tracked AD/CVD orders</h3>
            <table className="simple">
              <thead><tr><th>Case</th><th>Product</th><th>Origin</th><th>All-others rate</th><th>HS (indicative)</th></tr></thead>
              <tbody>
                {d.adcvd.us.cases.map((c: any) => (
                  <tr key={c.case}><td className="mono">{c.case}</td><td>{c.product}<div className="muted small">{c.note}</div></td><td>{c.country}</td><td>{c.allOthers ? `AD ${c.allOthers.ad ?? '—'}% · CVD ${c.allOthers.cvd ?? '—'}%` : 'exporter-specific'}</td><td className="mono small">{c.prefixes.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">Full search: <a href={d.adcvd.us.searchUrl} target="_blank" rel="noreferrer">CBP ADCVD Search</a>. Generic warning for origins: {d.adcvd.us.riskOrigins.join(', ')}.</p>
          </div>
          <div className="card">
            <h3>Canada — SIMA measures in force</h3>
            <table className="simple">
              <thead><tr><th>MIF code</th><th>Product</th><th>Countries</th><th>HS (indicative)</th></tr></thead>
              <tbody>
                {d.adcvd.ca.cases.map((c: any) => (
                  <tr key={c.case}><td className="mono">{c.case}</td><td>{c.product}</td><td>{(c.countries ?? [c.country]).join(', ')}</td><td className="mono small">{c.prefixes.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">Source: <a href={d.adcvd.ca.searchUrl} target="_blank" rel="noreferrer">CBSA — Measures in force</a>.</p>
          </div>
        </>
      )}
      {tab === 'lic' && (
        <>
          {(['us', 'ca'] as const).map((k) => (
            <div className="card" key={k}>
              <h3>{k === 'us' ? 'United States — PGAs and licenses' : 'Canada — other government departments and ICL'}</h3>
              <table className="simple">
                <thead><tr><th>Agency</th><th>Requirement</th><th>Level</th><th>HS</th></tr></thead>
                <tbody>
                  {d.licences[k].map((l: any, i: number) => (
                    <tr key={i}><td>{l.agency}</td><td>{l.label}</td><td>{l.level}</td><td className="mono small">{l.prefixes.join(', ') || 'all'}</td></tr>
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
  return (
    <div className="card">
      <h3>{title}</h3>
      <table className="simple">
        <thead><tr><th>Measure</th><th>Rate</th><th>Origins</th><th>Scope</th><th>Status</th></tr></thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.id}>
              <td>
                <b>{m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.name}</a> : m.name}</b>
                <div className="muted small">{m.legal}</div>
                {m.note && <div className="small">{m.note}</div>}
              </td>
              <td>{m.kind === 'ban' ? 'Prohibition' : m.rate !== undefined ? `${m.rate}%` : m.originRates ? 'by country' : '—'}</td>
              <td className="small">{m.origins?.join(', ') ?? (m.excludeOrigins ? `except ${m.excludeOrigins.join(', ')}` : 'all')}</td>
              <td className="small">
                {m.scope.all ? 'All goods' : m.listCount > 0 ? <span className="badge ok">list: {m.listCount} codes</span> : m.scope.codeList ? <span className="badge warn">list to import</span> : ''}
                {m.scope.prefixes && m.listCount === 0 && <div className="muted">indicative prefixes: {m.scope.prefixes.length}</div>}
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
  return (
    <div className="card">
      <h3>Special regimes offered</h3>
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
