import { useEffect, useState } from 'react';
import { api } from '../api';

function St({ s }: { s?: string }) {
  return s === 'vérifié' ? <span className="badge ok">vérifié</span> : <span className="badge warn">à valider</span>;
}

export default function Measures() {
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<'us' | 'ca' | 'adcvd' | 'lic'>('us');
  useEffect(() => {
    api.measures().then(setD);
  }, []);
  if (!d) return <div className="card">Chargement…</div>;
  return (
    <div className="wide">
      <div className="seg small">
        <button className={tab === 'us' ? 'on' : ''} onClick={() => setTab('us')}>INBOUND USA</button>
        <button className={tab === 'ca' ? 'on' : ''} onClick={() => setTab('ca')}>INBOUND CANADA</button>
        <button className={tab === 'adcvd' ? 'on' : ''} onClick={() => setTab('adcvd')}>AD/CVD · LMSI</button>
        <button className={tab === 'lic' ? 'on' : ''} onClick={() => setTab('lic')}>Licences et permis</button>
      </div>

      {tab === 'us' && (
        <>
          <div className="card">
            <h3>Programmes rattachés au chapitre 99 (détection automatique par renvois HTSUS)</h3>
            <p className="muted small">{d.us.ch99Count} rubriques 9903 chargées depuis l’export USITC ; leurs taux sont lus directement dans la colonne « General ».</p>
            <table className="simple">
              <thead><tr><th>Programme</th><th>Rubriques</th><th>Statut</th><th>Notes</th></tr></thead>
              <tbody>
                {d.us.programs.map((p: any) => (
                  <tr key={p.id}>
                    <td><b>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name}</b><div className="muted small mono">{p.id}</div></td>
                    <td className="mono small">{(p.prefixes ?? []).join(', ') || 'détection par description'}</td>
                    <td><St s={p.status} /></td>
                    <td className="small">{p.note}{p.options && <ul>{Object.entries(p.options).map(([k, o]: any) => <li key={k}>{o.label} <St s={o.status} /></li>)}</ul>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MeasureTable title="Mesures par pays d’origine" list={d.us.measures} />
          <RegimeTable list={d.us.regimes} />
          <div className="card">
            <h3>Frais</h3>
            <p className="small">MPF : {d.us.fees.mpf.pct} % (min. {d.us.fees.mpf.min} $, max. {d.us.fees.mpf.max} $) — exemptée pour les marchandises originaires ACEUM du Canada/Mexique. HMF : {d.us.fees.hmf.pct} % (maritime).</p>
          </div>
        </>
      )}
      {tab === 'ca' && (
        <>
          <MeasureTable title="Surtaxes et mesures canadiennes" list={d.ca.measures} />
          <RegimeTable list={d.ca.regimes} />
          <div className="card">
            <h3>Taxes</h3>
            <p className="small">TPS {d.ca.taxes.gst.pct} % ; TVH : {Object.entries(d.ca.taxes.hst).map(([p, r]) => `${p} ${r} %`).join(', ')}. {d.ca.taxes.note}</p>
          </div>
        </>
      )}
      {tab === 'adcvd' && (
        <>
          <div className="card">
            <h3>États-Unis — ordonnances AD/CVD suivies</h3>
            <table className="simple">
              <thead><tr><th>Dossier</th><th>Produit</th><th>Origine</th><th>Taux tous les autres</th><th>HS (indicatif)</th></tr></thead>
              <tbody>
                {d.adcvd.us.cases.map((c: any) => (
                  <tr key={c.case}><td className="mono">{c.case}</td><td>{c.product}<div className="muted small">{c.note}</div></td><td>{c.country}</td><td>{c.allOthers ? `AD ${c.allOthers.ad ?? '—'} % · CVD ${c.allOthers.cvd ?? '—'} %` : 'selon l’exportateur'}</td><td className="mono small">{c.prefixes.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">Recherche complète : <a href={d.adcvd.us.searchUrl} target="_blank" rel="noreferrer">CBP ADCVD Search</a>. Alerte générique pour les origines : {d.adcvd.us.riskOrigins.join(', ')}.</p>
          </div>
          <div className="card">
            <h3>Canada — mesures LMSI en vigueur</h3>
            <table className="simple">
              <thead><tr><th>Code MEV</th><th>Produit</th><th>Pays</th><th>HS (indicatif)</th></tr></thead>
              <tbody>
                {d.adcvd.ca.cases.map((c: any) => (
                  <tr key={c.case}><td className="mono">{c.case}</td><td>{c.product}</td><td>{(c.countries ?? [c.country]).join(', ')}</td><td className="mono small">{c.prefixes.join(', ')}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">Source : <a href={d.adcvd.ca.searchUrl} target="_blank" rel="noreferrer">ASFC — Mesures en vigueur</a>.</p>
          </div>
        </>
      )}
      {tab === 'lic' && (
        <>
          {(['us', 'ca'] as const).map((k) => (
            <div className="card" key={k}>
              <h3>{k === 'us' ? 'États-Unis — PGA et licences' : 'Canada — autres ministères et LMIC'}</h3>
              <table className="simple">
                <thead><tr><th>Organisme</th><th>Exigence</th><th>Niveau</th><th>HS</th></tr></thead>
                <tbody>
                  {d.licences[k].map((l: any, i: number) => (
                    <tr key={i}><td>{l.agency}</td><td>{l.label}</td><td>{l.level}</td><td className="mono small">{l.prefixes.join(', ') || 'toutes'}</td></tr>
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
        <thead><tr><th>Mesure</th><th>Taux</th><th>Origines</th><th>Portée</th><th>Statut</th></tr></thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.id}>
              <td>
                <b>{m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.name}</a> : m.name}</b>
                <div className="muted small">{m.legal}</div>
                {m.note && <div className="small">{m.note}</div>}
              </td>
              <td>{m.kind === 'ban' ? 'Interdiction' : m.rate !== undefined ? `${m.rate} %` : m.originRates ? 'selon le pays' : '—'}</td>
              <td className="small">{m.origins?.join(', ') ?? (m.excludeOrigins ? `sauf ${m.excludeOrigins.join(', ')}` : 'toutes')}</td>
              <td className="small">
                {m.scope.all ? 'Toutes marchandises' : m.listCount > 0 ? <span className="badge ok">liste : {m.listCount} codes</span> : m.scope.codeList ? <span className="badge warn">liste à importer</span> : ''}
                {m.scope.prefixes && m.listCount === 0 && <div className="muted">préfixes indicatifs : {m.scope.prefixes.length}</div>}
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
      <h3>Régimes spéciaux proposés</h3>
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
