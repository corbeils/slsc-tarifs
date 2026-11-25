import { useEffect, useState } from 'react';
import { api, fmtDate, session } from '../api';

type Me = { username: string; mustChange: boolean };

export default function Admin() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (!session.get()) return setChecking(false);
    api.admin
      .me()
      .then(setMe)
      .catch(() => session.clear())
      .finally(() => setChecking(false));
  }, []);
  if (checking) return <div className="narrow"><div className="card">Loading…</div></div>;
  if (!me) return <Login onLogin={setMe} />;
  return (
    <AdminPanel
      me={me}
      onLogout={async () => {
        await api.logout().catch(() => {});
        session.clear();
        setMe(null);
      }}
      onPasswordChanged={() => setMe({ ...me, mustChange: false })}
      onRenamed={(u) => setMe({ ...me, username: u })}
    />
  );
}

function Login({ onLogin }: { onLogin: (m: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.login(username, password);
      session.set(r.token);
      onLogin({ username: r.username, mustChange: r.mustChange });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="narrow login">
      <form className="card" onSubmit={submit}>
        <h2>Administration</h2>
        <p className="muted small">Sign in to import data, manage code lists, edit rules and manage accounts.</p>
        <label className="lbl">Username</label>
        <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label className="lbl">Password</label>
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="row">
          <button className="btn" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        {err && <div className="alert danger" style={{ marginTop: 12 }}>{err}</div>}
      </form>
    </div>
  );
}

const ADMIN_TABS = [
  { id: 'home', label: 'HOME' },
  { id: 'ai', label: 'AI LOOKUP' },
  { id: 'version', label: 'CHANGELOG & VERSIONING' },
  { id: 'database', label: 'DATABASE' },
  { id: 'rules', label: 'RULES' },
  { id: 'users', label: 'USERS' },
  { id: 'account', label: 'MY ACCOUNT' },
] as const;
type AdminTab = (typeof ADMIN_TABS)[number]['id'];

function AdminPanel({ me, onLogout, onPasswordChanged, onRenamed }: { me: Me; onLogout: () => void; onPasswordChanged: () => void; onRenamed: (u: string) => void }) {
  const [tab, setTabState] = useState<AdminTab>(() => (ADMIN_TABS.some((x) => x.id === localStorage.getItem('slsc-admin-tab')) ? (localStorage.getItem('slsc-admin-tab') as AdminTab) : 'home'));
  const setTab = (x: AdminTab) => {
    localStorage.setItem('slsc-admin-tab', x);
    setTabState(x);
  };
  const [meta, setMeta] = useState<any>(null);
  const [measures, setMeasures] = useState<any>(null);
  const [log, setLog] = useState<string[]>([]);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const push = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString('en-CA')} — ${m}`, ...l].slice(0, 50));
  const notify = (ok: boolean, text: string) => {
    setToast({ ok, text });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 9000);
  };
  const refresh = () => {
    api.meta().then(setMeta);
    api.measures().then(setMeasures);
  };
  useEffect(refresh, []);

  const wrap = async (label: string, fn: () => Promise<any>) => {
    push(`${label}…`);
    try {
      const r = await fn();
      push(`${label}: ${JSON.stringify(r).slice(0, 300)}`);
      notify(true, `${label}: ${summarize(r)}`);
      refresh();
      return r;
    } catch (e) {
      push(`${label} — error: ${(e as Error).message}`);
      notify(false, `${label} — ${(e as Error).message}`);
      if ((e as { status?: number }).status === 401) onLogout();
    }
  };
  const poll = async (label: string, id: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const j = await api.admin.job(id);
      if (j.log?.length) push(`${label}: ${j.log.at(-1)}`);
      if (j.status !== 'running') {
        push(`${label}: ${j.status === 'done' ? 'done ' + JSON.stringify(j.result) : 'error ' + j.error}`);
        notify(j.status === 'done', `${label}: ${j.status === 'done' ? summarize(j.result) : j.error}`);
        refresh();
        return;
      }
    }
  };

  const listMeasures = [
    ...(measures?.us.programs ?? []).flatMap((p: any) => (p.lists ?? []).map((l: any) => ({ id: l.id, name: `${p.name} — ${l.label}`, j: 'US' }))),
    ...(measures?.us.measures ?? []).filter((m: any) => m.scope.codeList).map((m: any) => ({ ...m, j: 'US' })),
    ...(measures?.ca.measures ?? []).filter((m: any) => m.scope.codeList).map((m: any) => ({ ...m, j: 'CA' })),
  ];

  return (
    <div className="admin">
      {toast && (
        <div className={`toast ${toast.ok ? 'ok' : 'err'}`} onClick={() => setToast(null)}>
          {toast.ok ? '✓ ' : '✗ '}
          {toast.text}
        </div>
      )}
      <div className="card userbar">
        <div>
          Signed in as <b>{me.username}</b>
        </div>
        <button className="btn ghost" onClick={onLogout}>Sign out</button>
      </div>
      {me.mustChange && (
        <div className="alert warning">
          <b>You are using the default password.</b> Change it in <a href="#/admin" onClick={() => setTab('account')}>MY ACCOUNT</a> before using the site in production.
        </div>
      )}

      <div className="subnav">
        {ADMIN_TABS.map((x) => (
          <button key={x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'home' && (
        <>
      <div className="card">
        <h3>Data status</h3>
        <table className="simple">
          <tbody>
            <tr><td>HTSUS (U.S.)</td><td>{meta?.us?.lines} lines · {meta?.us?.ch99 ?? 0} 9903 headings</td><td>{meta?.us?.source}</td><td>{fmtDate(meta?.us?.at)}</td></tr>
            <tr><td>Customs Tariff (Canada)</td><td>{meta?.ca?.lines} lines</td><td>{meta?.ca?.source}</td><td>{fmtDate(meta?.ca?.at)}</td></tr>
            <tr><td>TARIC (EU)</td><td>{meta?.eu?.lines ?? 0} lines · {meta?.eu?.measures ?? 0} measures · {meta?.eu?.groups ?? 0} country groups</td><td>{meta?.eu?.source}</td><td>{fmtDate(meta?.eu?.at)}</td></tr>
            <tr><td>EUR/CAD rate</td><td>{meta?.fx?.eurCad}</td><td></td><td></td></tr>
            <tr><td>USD/CAD rate</td><td>{meta?.fx?.usdCad}</td><td>{meta?.fx?.source}</td><td>{meta?.fx?.date}</td></tr>
            <tr><td>PGA flags</td><td>{meta?.pga?.count ?? 0}</td><td></td><td>{fmtDate(meta?.pga?.at)}</td></tr>
          </tbody>
        </table>
      </div>

        </>
      )}
      {tab === 'ai' && <AiCard notify={notify} />}
      {tab === 'version' && (
        <>
      <SiteVersion current={meta?.site} onSave={async (v, b, n) => { await wrap('Site version', () => api.admin.siteVersion(v, b, n)); window.dispatchEvent(new Event('slsc-meta')); }} />

          <Changelog />
        </>
      )}
      {tab === 'database' && (
        <>
      <div className="grid2 gap">
        <div className="card">
          <h3>U.S. tariff (USITC)</h3>
          <p className="small muted">Downloads the 98 chapters + Chapter 99 from hts.usitc.gov/reststop (≈ 2–5 min). Also scheduled automatically (CRON_US).</p>
          <button className="btn" onClick={async () => { const r = await wrap('USITC import', api.admin.importUs); if (r?.job) poll('USITC import', r.job); }}>Import online</button>
          <div className="sep">or a JSON file exported from hts.usitc.gov (Export → JSON, 0101 to 9999)</div>
          <FileUpload accept=".json" label="Upload JSON" onUpload={(f) => wrap('USITC file import', () => api.admin.upload('/api/admin/import/us-file', f))} />
        </div>
        <div className="card">
          <h3>Canadian tariff (CBSA)</h3>
          <p className="small muted">
            CBSA has no API: the app scans the CBSA Customs Tariff pages every day, downloads the Excel/CSV file only when it changed, and imports it
            (CARM-generated files expected from the Dec. 2026 amendment).
          </p>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn" onClick={async () => { const r = await wrap('CBSA sync', () => api.admin.syncCbsa()); if (r?.job) poll('CBSA sync', r.job); }}>Sync with CBSA now</button>
            <button className="btn ghost" onClick={async () => { const r = await wrap('CBSA sync (forced)', () => api.admin.syncCbsa(true)); if (r?.job) poll('CBSA sync', r.job); }}>Force re-import</button>
          </div>
          {meta?.cbsa && (
            <div className={`alert ${meta.cbsa.ok ? 'info' : 'danger'} small`} style={{ marginTop: 10 }}>
              <b>Last check {fmtDate(meta.cbsa.at)}:</b> {meta.cbsa.message}
              {meta.cbsa.fileUrl && <div className="mono" style={{ wordBreak: 'break-all' }}>{meta.cbsa.fileUrl}</div>}
            </div>
          )}
          <div className="sep">or upload the file manually</div>
          <FileUpload accept=".xlsx,.csv,.txt" label="Upload tariff file" onUpload={(f) => wrap('Canadian tariff import', () => api.admin.upload('/api/admin/import/ca-file', f))} />
          <UrlImport onRun={async (u) => { const r = await wrap('Canadian tariff import (URL)', () => api.admin.caUrl(u)); if (r?.job) poll('Canadian tariff import', r.job); }} />
        </div>
        <TaricCard
          urls={meta?.taricUrls ?? []}
          onUpload={async (files) => { const r = await wrap('TARIC import', () => api.admin.taricUpload(files)); if (r?.job) poll('TARIC import', r.job); }}
          onSaveUrls={(urls) => wrap('TARIC URLs', () => api.admin.taricUrls(urls))}
          onSync={async () => { const r = await wrap('TARIC download', api.admin.taricSync); if (r?.job) poll('TARIC download', r.job); }}
        />
        <div className="card">
          <h3>CBP PGA flags · extra AD/CVD cases</h3>
          <div className="small muted">CSV or Excel with two columns: <b>HTS</b> and <b>Flag</b> (FD1, EP3, AM8…). Comma, semicolon or tab separated.</div>
          <FileUpload accept=".csv,.txt,.tsv,.xlsx" label="Upload PGA flags" onUpload={(f) => wrap('PGA import', () => api.admin.upload('/api/admin/import/pga', f))} />
          <div className="small muted" style={{ marginTop: 14 }}>AD/CVD/SIMA CSV or Excel: j, case, product, country, prefixes, ad, cvd, note, url</div>
          <FileUpload accept=".csv,.txt,.tsv,.xlsx" label="Upload AD/CVD cases" onUpload={(f) => wrap('AD/CVD import', () => api.admin.upload('/api/admin/import/adcvd', f))} />
        </div>
      </div>

      <div className="card">
        <h3>Official lists — U.S. Section 232 annexes and Canadian surtaxes on U.S. goods</h3>
        <p className="small muted">
          Downloads the proclamation annex PDFs (Proclamation 11021 of Apr. 2, 2026: Annexes I-A, I-B, II; Proclamation 11032 of June 1, 2026:
          Annexes I-B, I-C, III) and the Department of Finance consolidated list of U.S. products subject to Canadian counter-tariffs (rate per
          tariff item), extracts the tariff numbers and replaces the lists. Runs automatically every Monday (CRON_LISTS).
          Sources are defined in <span className="mono">rules/us.yaml</span> (<span className="mono">sources:</span>) — add the next proclamation there.
        </p>
        <button className="btn" onClick={async () => { const r = await wrap('Official annex lists', api.admin.syncLists); if (r?.job) poll('Official annex lists', r.job); }}>Import official lists now</button>
        {meta?.officialLists && (
          <table className="simple" style={{ marginTop: 12 }}>
            <tbody>
              <tr><td colSpan={2} className="muted small">Last run {fmtDate(meta.officialLists.at)}</td></tr>
              {meta.officialLists.results.map((r: any) => (
                <tr key={r.id}><td>{r.label}</td><td>{r.error ? <span className="badge warn">{r.error}</span> : <><span className="badge ok">{r.codes} codes</span> <span className="muted small">{r.detail}</span></>}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <CodeLists measures={listMeasures} lists={meta?.codeLists ?? []} wrap={wrap} />
      <div className="card">
        <h3>Log</h3>
        <pre className="log">{log.join('\n') || '—'}</pre>
      </div>
        </>
      )}
      {tab === 'rules' && <RulesEditor wrap={wrap} />}
      {tab === 'users' && <Users me={me} wrap={wrap} />}
      {tab === 'account' && <MyAccount me={me} wrap={wrap} onChanged={onPasswordChanged} onRenamed={onRenamed} />}
    </div>
  );
}

type Wrap = (l: string, f: () => Promise<any>) => Promise<any>;

function summarize(r: any): string {
  if (!r || typeof r !== 'object') return 'done';
  if (r.message) return r.message;
  if (r.total !== undefined) return `${r.added} codes read, ${r.total} codes now in the list`;
  if (r.count !== undefined) return `${r.count} records imported`;
  if (r.lines !== undefined) return `${r.lines} lines imported`;
  if (r.rate !== undefined) return `1 USD = ${r.rate} CAD`;
  if (r.job) return 'started…';
  return 'done';
}

function AiCard({ notify }: { notify: (ok: boolean, text: string) => void }) {
  const [cfg, setCfg] = useState<any>(null);
  const [sel, setSel] = useState('anthropic');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [vision, setVision] = useState(true);
  const load = (c: any, p?: string) => {
    setCfg(c);
    const id = p ?? c.active;
    setSel(id);
    const x = c.providers.find((y: any) => y.id === id);
    setModel(x?.model ?? '');
    setBaseUrl(x?.baseUrl ?? '');
    setVision(!!x?.vision);
    setKey('');
  };
  useEffect(() => {
    api.admin.aiGet().then((c) => load(c)).catch(() => {});
  }, []);
  const cur = cfg?.providers.find((y: any) => y.id === sel);
  const save = async (active: boolean, extra: Record<string, unknown> = {}) => {
    try {
      const c = await api.admin.aiSet({ provider: sel, model, baseUrl, vision, active, ...(key ? { key } : {}), ...extra } as never);
      load(c, sel);
      notify(true, active ? `AI provider: ${cur?.label}` : 'AI settings saved');
    } catch (e) {
      notify(false, (e as Error).message);
    }
  };
  if (!cfg) return null;
  return (
    <div className="card">
      <h3>AI classification assistant (HS code lookup)</h3>
      <p className="small muted">
        Provider used now: <b>{cfg.providers.find((y: any) => y.id === cfg.active)?.label}</b>. Keys stay on this server and are never sent to the browser. Anthropic uses its own API; the others use their
        OpenAI-compatible endpoint (function calling). Model names change often: pick a suggestion or type the exact name from the provider's console.
      </p>
      <div className="chips" style={{ marginBottom: 8 }}>
        {cfg.providers.map((x: any) => (
          <button key={x.id} className={`chip ${sel === x.id ? 'on' : ''}`} onClick={() => load(cfg, x.id)}>
            {x.label}
            {x.id === cfg.active ? ' ★' : ''}
            {x.configured ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <div className="grid2">
        <div>
          <label className="lbl">API key {cur?.configured ? `(saved: ${cur.keyHint}${cur.fromEnv ? `, from ${cur.env}` : ''})` : `(or env ${cur?.env})`}</label>
          <input className="input mono" type="password" autoComplete="off" placeholder={cur?.configured ? 'leave empty to keep' : 'paste the key'} value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div>
          <label className="lbl">Model</label>
          <input className="input mono" list={`models-${sel}`} value={model} onChange={(e) => setModel(e.target.value)} />
          <datalist id={`models-${sel}`}>
            {cur?.models.map((m: string) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="grid2">
        <div>
          <label className="lbl">API base URL</label>
          <input className="input mono" value={baseUrl} placeholder={cur?.defaultBaseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <label className="check" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
          <span>Model accepts photos (vision)</span>
        </label>
      </div>
      <div className="row">
        <button className="btn" onClick={() => save(true)}>Save and use this provider</button>
        <button className="btn ghost" onClick={() => save(false)}>Save only</button>
        {cur?.configured && !cur.fromEnv && (
          <button className="btn ghost" onClick={() => save(false, { key: '' })}>Remove key</button>
        )}
      </div>
    </div>
  );
}

function TaricCard({ urls, onUpload, onSaveUrls, onSync }: { urls: string[]; onUpload: (f: File[]) => Promise<void>; onSaveUrls: (u: string[]) => void; onSync: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => setText(urls.join('\n')), [urls.join('|')]);
  return (
    <div className="card">
      <h3>EU tariff — TARIC (INBOUND EU)</h3>
      <p className="small muted">
        Monthly Excel extractions of DG TAXUD ("TARIC and Quota data &amp; information" group on CIRCABC). Select several files at once — the kind of each file is detected
        automatically: <b>Nomenclature EN</b> (codes and descriptions), <b>Duties Import 01-99</b> (all measures by origin: third-country duty, preferences, quotas,
        anti-dumping, additional duties, controls), <b>Geographical area composition</b> (country groups, e.g. GSP), <b>Measure exclusions</b> and{' '}
        <b>Additional codes descriptions</b> (company names of AD/CVD rates). VAT rates and agreement names are in <span className="mono">rules/eu.yaml</span>.
      </p>
      <div className="join" style={{ marginTop: 6, alignItems: 'center' }}>
        <input type="file" multiple accept=".xlsx,.csv" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        <button className="btn" disabled={!files.length || busy} onClick={async () => { setBusy(true); await onUpload(files); setBusy(false); }}>
          {busy ? 'Uploading…' : `Upload ${files.length || ''} file(s)`}
        </button>
      </div>
      <div className="sep">or direct links to the files (one per line) — downloaded now and on the 2nd of every month (CRON_EU)</div>
      <textarea className="input mono" rows={4} style={{ width: '100%' }} placeholder="https://circabc.europa.eu/…/Nomenclature%20EN.xlsx" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button className="btn ghost" onClick={() => onSaveUrls(text.split(/\s+/).filter(Boolean))}>Save links</button>
        <button className="btn" disabled={!urls.length} onClick={onSync}>Download and import now</button>
      </div>
    </div>
  );
}

function FileUpload({ accept, label, onUpload }: { accept: string; label: string; onUpload: (f: File) => Promise<any> }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="join" style={{ marginTop: 6, alignItems: 'center' }}>
      <input type="file" accept={accept} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button
        className="btn"
        disabled={!file || busy}
        onClick={async () => {
          setBusy(true);
          await onUpload(file!);
          setBusy(false);
        }}
      >
        {busy ? 'Uploading…' : label}
      </button>
    </div>
  );
}

function UrlImport({ onRun }: { onRun: (u: string) => void }) {
  const [u, setU] = useState('');
  return (
    <div className="join" style={{ marginTop: 10 }}>
      <input className="input" placeholder="https://… (XLSX/CSV file)" value={u} onChange={(e) => setU(e.target.value)} />
      <button className="btn ghost" disabled={!u} onClick={() => onRun(u)}>Import</button>
    </div>
  );
}

const VERSION_RE = /^\d+\.\d+\.\d+(R\d+)?$/i;
function SiteVersion({ current, onSave }: { current?: { version: string; beta: boolean; at?: string }; onSave: (v: string, beta: boolean, notes: string) => Promise<void> | void }) {
  const [v, setV] = useState('');
  const [beta, setBeta] = useState(true);
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (current) {
      setV(current.version);
      setBeta(current.beta);
    }
  }, [current?.version, current?.beta]);
  const ok = VERSION_RE.test(v.trim());
  return (
    <div className="card">
      <h3>Site version</h3>
      <p className="small muted">
        Shown in the footer as <b>SITE VERSION : {beta ? 'BETA VERSION' : 'VERSION'} {v.trim().toUpperCase() || '…'}</b>. Format: 3 numbers (1.3.0), with an optional revision of
        the day (1.1.4R2).
      </p>
      <label className="lbl">Changes in this version (changelog, optional)</label>
      <textarea className="input" rows={3} style={{ width: '100%' }} placeholder="- Added INBOUND EU&#10;- Fixed …" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="row">
        <input className="input mono" style={{ maxWidth: 160 }} placeholder="1.3.0" value={v} onChange={(e) => setV(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={beta} onChange={(e) => setBeta(e.target.checked)} />
          <span>Beta</span>
        </label>
        <button className="btn" disabled={!ok} onClick={async () => { await onSave(v.trim().toUpperCase(), beta, notes); setNotes(''); window.dispatchEvent(new Event('slsc-changelog')); }}>Save</button>
        {!ok && v.trim() && <span className="small" style={{ color: 'var(--danger, #c0392b)' }}>Invalid format</span>}
        {current?.at && <span className="small muted">Last change {fmtDate(current.at)}</span>}
      </div>
    </div>
  );
}

function Changelog() {
  const [log, setLog] = useState<{ version: string; beta: boolean; at: string; notes: string; by: string }[]>([]);
  useEffect(() => {
    const load = () => api.admin.changelog().then(setLog).catch(() => {});
    load();
    window.addEventListener('slsc-changelog', load);
    return () => window.removeEventListener('slsc-changelog', load);
  }, []);
  return (
    <div className="card">
      <h3>Changelog</h3>
      {log.length === 0 ? (
        <div className="small muted">No version saved yet. Each time you save a version above, it is added here with its notes.</div>
      ) : (
        <table className="simple">
          <tbody>
            {log.map((x, i) => (
              <tr key={i}>
                <td className="mono" style={{ whiteSpace: 'nowrap', width: 110 }}>
                  {x.beta ? 'BETA ' : ''}
                  {x.version}
                </td>
                <td className="small muted" style={{ whiteSpace: 'nowrap', width: 220 }}>
                  {fmtDate(x.at)} · {x.by}
                </td>
                <td style={{ whiteSpace: 'pre-wrap', width: '100%' }}>{x.notes || <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MyAccount({ me, wrap, onChanged, onRenamed }: { me: Me; wrap: Wrap; onChanged: () => void; onRenamed: (u: string) => void }) {
  const [name, setName] = useState(me.username);
  const [namePw, setNamePw] = useState('');
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const rename = async () => {
    try {
      const r = await api.admin.rename(name, namePw);
      setNamePw('');
      setNameMsg({ ok: true, text: `User name changed to ${r.username}.` });
      onRenamed(r.username);
    } catch (e) {
      setNameMsg({ ok: false, text: (e as Error).message });
    }
  };
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    if (next !== confirm) return setMsg({ ok: false, text: 'The new passwords do not match.' });
    try {
      await api.admin.changePassword(current, next);
      setMsg({ ok: true, text: 'Password changed.' });
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged();
      wrap('Password changed', async () => ({ ok: true }));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="card">
      <h3>My account — {me.username}</h3>
      <div className="grid2">
        <div>
          <label className="lbl">User name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" />
        </div>
        <div>
          <label className="lbl">Password (to confirm)</label>
          <input className="input" type="password" value={namePw} onChange={(e) => setNamePw(e.target.value)} autoComplete="current-password" />
        </div>
      </div>
      <div className="row">
        <button className="btn" disabled={!name.trim() || name.trim() === me.username || !namePw} onClick={rename}>Change user name</button>
      </div>
      {nameMsg && <div className={`alert ${nameMsg.ok ? 'info' : 'danger'}`} style={{ marginTop: 10 }}>{nameMsg.text}</div>}
      <div className="sep">Password</div>
      <label className="lbl">Current password</label>
      <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <label className="lbl">New password</label>
      <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      <label className="lbl">Confirm new password</label>
      <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <div className="row">
        <button className="btn" disabled={!current || !next} onClick={save}>Change password</button>
      </div>
      {msg && <div className={`alert ${msg.ok ? 'info' : 'danger'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
    </div>
  );
}

function Users({ me, wrap }: { me: Me; wrap: Wrap }) {
  const [users, setUsers] = useState<{ username: string; mustChange: number; createdAt: string }[]>([]);
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const load = () => api.admin.users().then(setUsers).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="card">
      <h3>Administrator accounts</h3>
      <table className="simple">
        <tbody>
          {users.map((x) => (
            <tr key={x.username}>
              <td>
                <b>{x.username}</b> {x.mustChange ? <span className="badge warn">temporary password</span> : null}
                <div className="muted small">created {fmtDate(x.createdAt)}</div>
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {x.username.toLowerCase() !== me.username.toLowerCase() && (
                  <>
                    <button
                      className="btn ghost"
                      onClick={async () => {
                        const np = prompt(`New temporary password for ${x.username}:`);
                        if (np) await wrap(`Reset ${x.username}`, () => api.admin.resetUser(x.username, np));
                        load();
                      }}
                    >
                      Reset
                    </button>{' '}
                    <button
                      className="btn danger"
                      onClick={async () => {
                        if (confirm(`Delete ${x.username}?`)) await wrap(`Delete ${x.username}`, () => api.admin.deleteUser(x.username));
                        load();
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sep">Add an administrator (they will be asked to change the password)</div>
      <div className="grid2">
        <input className="input" placeholder="Username" value={u} onChange={(e) => setU(e.target.value)} />
        <input className="input" type="password" placeholder="Temporary password" value={p} onChange={(e) => setP(e.target.value)} />
      </div>
      <div className="row">
        <button
          className="btn"
          disabled={!u || !p}
          onClick={async () => {
            await wrap(`Add ${u}`, () => api.admin.addUser(u, p));
            setU('');
            setP('');
            load();
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function CodeLists({ measures, lists, wrap }: { measures: any[]; lists: any[]; wrap: Wrap }) {
  const [id, setId] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [replace, setReplace] = useState(true);
  const [withRates, setWithRates] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [preview, setPreview] = useState<any[]>([]);
  const count = (mid: string) => lists.find((l) => l.measure_id === mid)?.n ?? 0;
  return (
    <div className="card">
      <h3>Measure code lists (order / proclamation schedules)</h3>
      <p className="small muted">
        Paste the text of a schedule (Canada Gazette, customs notice, Finance Canada page, Federal Register) or give its URL: every tariff number
        is extracted. An imported list replaces the measure's indicative prefixes.
      </p>
      <div className="grid2 gap">
        <div>
          <label className="lbl">Measure</label>
          <select className="input" value={id} onChange={(e) => { setId(e.target.value); setPreview([]); }}>
            <option value="">— choose —</option>
            {measures.map((m) => (
              <option key={m.id} value={m.id}>[{m.j === 'US' ? 'INBOUND USA' : 'INBOUND CANADA'}] {m.name} — {count(m.id)} codes</option>
            ))}
          </select>
          <label className="lbl">File (CSV, TXT or Excel)</label>
          <input type="file" accept=".csv,.txt,.tsv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <label className="lbl">or URL</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.canada.ca/…" />
          <div className="grid2">
            <div>
              <label className="lbl">From marker (optional)</label>
              <input className="input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="e.g. Annex I-B" />
            </div>
            <div>
              <label className="lbl">Until marker (optional)</label>
              <input className="input" value={until} onChange={(e) => setUntil(e.target.value)} placeholder="e.g. Annex I-C" />
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /><span>Replace the existing list</span></label>
          <label className="check"><input type="checkbox" checked={withRates} onChange={(e) => setWithRates(e.target.checked)} /><span>Read the rate (%) on each line</span></label>
          <div className="row">
            <button className="btn" disabled={!id || (!text && !url && !file)} title={!id ? 'Choose a measure first' : !text && !url && !file ? 'Choose a file, a URL or paste text' : ''} onClick={async () => { const r = await wrap('List ' + id, () => api.admin.codes({ measureId: id, text: file ? undefined : text, url: file ? undefined : url || undefined, replace, withRates, from: from || undefined, until: until || undefined }, file)); if (r) setPreview(r.sample ?? []); }}>Import</button>
            <button className="btn ghost" disabled={!id} onClick={async () => setPreview(await api.admin.listCodes(id))}>View</button>
            <button className="btn danger" disabled={!id} onClick={() => confirm('Empty this list?') && wrap('Empty ' + id, () => api.admin.deleteCodes(id))}>Empty</button>
          </div>
        </div>
        <div>
          <label className="lbl">or pasted text</label>
          <textarea className="input mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'7208.10.00 …\n7208.25.00 …'} />
        </div>
      </div>
      {preview.length > 0 && (
        <div className="small mono preview">{preview.slice(0, 60).map((p) => `${p.code}${p.rate ? ' (' + p.rate + '%)' : ''}`).join(' · ')}{preview.length > 60 ? ' …' : ''}</div>
      )}
    </div>
  );
}

function RulesEditor({ wrap }: { wrap: Wrap }) {
  const [key, setKey] = useState('us');
  const [text, setText] = useState('');
  useEffect(() => {
    api.admin.rules(key).then((r) => setText(r.text)).catch(() => {});
  }, [key]);
  return (
    <div className="card">
      <h3>Rules (YAML)</h3>
      <div className="row">
        {['us', 'ca', 'eu', 'adcvd', 'licences'].map((k) => (
          <button key={k} className={`btn ${key === k ? '' : 'ghost'}`} onClick={() => setKey(k)}>{k}.yaml</button>
        ))}
        <span className="spacer" />
        <button className="btn" onClick={() => wrap(`Save ${key}.yaml`, () => api.admin.saveRules(key, text))}>Validate and save</button>
      </div>
      <textarea className="input mono code-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="small muted">The file is validated before it is written; a .bak copy is kept.</div>
    </div>
  );
}
