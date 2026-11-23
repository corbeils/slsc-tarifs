import { useEffect, useState } from 'react';
import { adminToken, api, fmtDate } from '../api';

export default function Admin() {
  const [token, setToken] = useState(adminToken.get());
  const [ok, setOk] = useState<boolean | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [measures, setMeasures] = useState<any>(null);
  const [log, setLog] = useState<string[]>([]);
  const push = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString('fr-CA')} — ${m}`, ...l].slice(0, 50));
  const refresh = () => {
    api.meta().then(setMeta);
    api.measures().then(setMeasures);
  };
  useEffect(() => {
    refresh();
    if (token) api.admin.check().then(() => setOk(true)).catch(() => setOk(false));
  }, []);

  const login = () => {
    adminToken.set(token);
    api.admin.check().then(() => setOk(true)).catch((e) => {
      setOk(false);
      push(e.message);
    });
  };
  const wrap = async (label: string, fn: () => Promise<any>) => {
    push(`${label}…`);
    try {
      const r = await fn();
      push(`${label} : ${JSON.stringify(r).slice(0, 300)}`);
      refresh();
      return r;
    } catch (e) {
      push(`${label} — erreur : ${(e as Error).message}`);
    }
  };
  const poll = async (label: string, id: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const j = await api.admin.job(id);
      if (j.log?.length) push(`${label} : ${j.log.at(-1)}`);
      if (j.status !== 'running') {
        push(`${label} : ${j.status === 'done' ? 'terminé ' + JSON.stringify(j.result) : 'erreur ' + j.error}`);
        refresh();
        return;
      }
    }
  };

  if (!ok)
    return (
      <div className="narrow">
        <div className="card">
          <h2>Administration</h2>
          {meta && !meta.adminEnabled && <div className="alert warning">Admin désactivé : définir la variable d’environnement ADMIN_TOKEN puis redémarrer.</div>}
          <label className="lbl">Jeton administrateur</label>
          <div className="join">
            <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
            <button className="btn" onClick={login}>Entrer</button>
          </div>
          {ok === false && <div className="alert danger">Jeton refusé.</div>}
        </div>
      </div>
    );

  const listMeasures = [
    ...(measures?.us.measures ?? []).filter((m: any) => m.scope.codeList).map((m: any) => ({ ...m, j: 'US' })),
    ...(measures?.ca.measures ?? []).filter((m: any) => m.scope.codeList).map((m: any) => ({ ...m, j: 'CA' })),
  ];

  return (
    <div className="admin">
      <div className="card">
        <h3>État des données</h3>
        <table className="simple">
          <tbody>
            <tr><td>HTSUS (US)</td><td>{meta?.us?.lines} lignes · {meta?.us?.ch99 ?? 0} rubriques 9903</td><td>{meta?.us?.source}</td><td>{fmtDate(meta?.us?.at)}</td></tr>
            <tr><td>Tarif des douanes (CA)</td><td>{meta?.ca?.lines} lignes</td><td>{meta?.ca?.source}</td><td>{fmtDate(meta?.ca?.at)}</td></tr>
            <tr><td>Taux USD/CAD</td><td>{meta?.fx?.usdCad}</td><td>{meta?.fx?.source}</td><td>{meta?.fx?.date}</td></tr>
            <tr><td>Indicateurs PGA</td><td>{meta?.pga?.count ?? 0}</td><td></td><td>{fmtDate(meta?.pga?.at)}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="grid2 gap">
        <div className="card">
          <h3>Tarif américain (USITC)</h3>
          <p className="small muted">Télécharge les 98 chapitres + ch. 99 via hts.usitc.gov/reststop (≈ 2–5 min). Planifié automatiquement (CRON_US).</p>
          <button className="btn" onClick={async () => { const r = await wrap('Import USITC', api.admin.importUs); if (r?.job) poll('Import USITC', r.job); }}>Importer en ligne</button>
          <div className="sep">ou fichier JSON exporté depuis hts.usitc.gov (Export → JSON, 0101 à 9999)</div>
          <input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && wrap('Import fichier USITC', () => api.admin.upload('/api/admin/import/us-file', e.target.files![0]))} />
        </div>
        <div className="card">
          <h3>Tarif canadien (ASFC)</h3>
          <p className="small muted">Fichier Excel/CSV du Tarif des douanes (format CARM dès le 1er déc. 2026). Les colonnes sont détectées par leurs en-têtes.</p>
          <input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => e.target.files?.[0] && wrap('Import tarif CA', () => api.admin.upload('/api/admin/import/ca-file', e.target.files![0]))} />
          <CaUrl onRun={async (u) => { const r = await wrap('Import CA (URL)', () => api.admin.caUrl(u)); if (r?.job) poll('Import CA', r.job); }} />
        </div>
        <div className="card">
          <h3>Taux de change</h3>
          <button className="btn" onClick={() => wrap('Taux BdC', api.admin.fxOnline)}>Banque du Canada (Valet)</button>
          <FxManual onSet={(r) => wrap('Taux manuel', () => api.admin.fxManual(r))} />
        </div>
        <div className="card">
          <h3>Indicateurs PGA (CBP) · AD/CVD supplémentaires</h3>
          <div className="small muted">CSV « HTS, Flag » (FD1, EP3, AM8…)</div>
          <input type="file" accept=".csv" onChange={(e) => e.target.files?.[0] && wrap('Import PGA', () => api.admin.upload('/api/admin/import/pga', e.target.files![0]))} />
          <div className="small muted" style={{ marginTop: 12 }}>CSV AD/CVD/LMSI : j, case, product, country, prefixes, ad, cvd, note, url</div>
          <input type="file" accept=".csv" onChange={(e) => e.target.files?.[0] && wrap('Import AD/CVD', () => api.admin.upload('/api/admin/import/adcvd', e.target.files![0]))} />
        </div>
      </div>

      <CodeLists measures={listMeasures} lists={meta?.codeLists ?? []} wrap={wrap} />
      <RulesEditor wrap={wrap} />

      <div className="card">
        <h3>Journal</h3>
        <pre className="log">{log.join('\n') || '—'}</pre>
      </div>
    </div>
  );
}

function CaUrl({ onRun }: { onRun: (u: string) => void }) {
  const [u, setU] = useState('');
  return (
    <div className="join" style={{ marginTop: 10 }}>
      <input className="input" placeholder="https://… (fichier XLSX/CSV)" value={u} onChange={(e) => setU(e.target.value)} />
      <button className="btn ghost" disabled={!u} onClick={() => onRun(u)}>Importer</button>
    </div>
  );
}
function FxManual({ onSet }: { onSet: (r: number) => void }) {
  const [r, setR] = useState('');
  return (
    <div className="join" style={{ marginTop: 10 }}>
      <input className="input" placeholder="1 USD = ? CAD" value={r} onChange={(e) => setR(e.target.value)} />
      <button className="btn ghost" disabled={!Number(r)} onClick={() => onSet(Number(r))}>Enregistrer</button>
    </div>
  );
}

function CodeLists({ measures, lists, wrap }: { measures: any[]; lists: any[]; wrap: (l: string, f: () => Promise<any>) => Promise<any> }) {
  const [id, setId] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [replace, setReplace] = useState(true);
  const [withRates, setWithRates] = useState(false);
  const [preview, setPreview] = useState<any[]>([]);
  const count = (mid: string) => lists.find((l) => l.measure_id === mid)?.n ?? 0;
  return (
    <div className="card">
      <h3>Listes de codes des mesures (annexes de décrets / proclamations)</h3>
      <p className="small muted">
        Collez le texte d’une annexe (Gazette du Canada, avis des douanes, page des Finances, Federal Register) ou donnez son URL : tous les numéros
        tarifaires sont extraits. Une liste importée remplace les préfixes indicatifs de la mesure.
      </p>
      <div className="grid2 gap">
        <div>
          <label className="lbl">Mesure</label>
          <select className="input" value={id} onChange={(e) => { setId(e.target.value); setPreview([]); }}>
            <option value="">— choisir —</option>
            {measures.map((m) => (
              <option key={m.id} value={m.id}>[{m.j}] {m.name} — {count(m.id)} codes</option>
            ))}
          </select>
          <label className="lbl">URL (facultatif)</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.canada.ca/…" />
          <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /><span>Remplacer la liste existante</span></label>
          <label className="check"><input type="checkbox" checked={withRates} onChange={(e) => setWithRates(e.target.checked)} /><span>Lire le taux (%) sur chaque ligne</span></label>
          <div className="row">
            <button className="btn" disabled={!id || (!text && !url)} onClick={async () => { const r = await wrap('Liste ' + id, () => api.admin.codes({ measureId: id, text, url: url || undefined, replace, withRates })); if (r) setPreview(r.sample ?? []); }}>Importer</button>
            <button className="btn ghost" disabled={!id} onClick={async () => setPreview(await api.admin.listCodes(id))}>Voir</button>
            <button className="btn danger" disabled={!id} onClick={() => confirm('Vider la liste ?') && wrap('Vider ' + id, () => api.admin.deleteCodes(id))}>Vider</button>
          </div>
        </div>
        <div>
          <label className="lbl">Texte collé</label>
          <textarea className="input mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'7208.10.00 …\n7208.25.00 …'} />
        </div>
      </div>
      {preview.length > 0 && (
        <div className="small mono preview">{preview.slice(0, 60).map((p) => `${p.code}${p.rate ? ' (' + p.rate + ' %)' : ''}`).join(' · ')}{preview.length > 60 ? ' …' : ''}</div>
      )}
    </div>
  );
}

function RulesEditor({ wrap }: { wrap: (l: string, f: () => Promise<any>) => Promise<any> }) {
  const [key, setKey] = useState('us');
  const [text, setText] = useState('');
  useEffect(() => {
    api.admin.rules(key).then((r) => setText(r.text));
  }, [key]);
  return (
    <div className="card">
      <h3>Règles (YAML)</h3>
      <div className="row">
        {['us', 'ca', 'adcvd', 'licences'].map((k) => (
          <button key={k} className={`btn ${key === k ? '' : 'ghost'}`} onClick={() => setKey(k)}>{k}.yaml</button>
        ))}
        <span className="spacer" />
        <button className="btn" onClick={() => wrap(`Enregistrer ${key}.yaml`, () => api.admin.saveRules(key, text))}>Valider et enregistrer</button>
      </div>
      <textarea className="input mono code-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="small muted">Le fichier est validé avant écriture ; une copie .bak est conservée.</div>
    </div>
  );
}
