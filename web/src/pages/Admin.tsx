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

function AdminPanel({ me, onLogout, onPasswordChanged }: { me: Me; onLogout: () => void; onPasswordChanged: () => void }) {
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
          <b>You are using the default password.</b> Change it below in <i>My account</i> before using the site in production.
        </div>
      )}

      <div className="card">
        <h3>Data status</h3>
        <table className="simple">
          <tbody>
            <tr><td>HTSUS (U.S.)</td><td>{meta?.us?.lines} lines · {meta?.us?.ch99 ?? 0} 9903 headings</td><td>{meta?.us?.source}</td><td>{fmtDate(meta?.us?.at)}</td></tr>
            <tr><td>Customs Tariff (Canada)</td><td>{meta?.ca?.lines} lines</td><td>{meta?.ca?.source}</td><td>{fmtDate(meta?.ca?.at)}</td></tr>
            <tr><td>USD/CAD rate</td><td>{meta?.fx?.usdCad}</td><td>{meta?.fx?.source}</td><td>{meta?.fx?.date}</td></tr>
            <tr><td>PGA flags</td><td>{meta?.pga?.count ?? 0}</td><td></td><td>{fmtDate(meta?.pga?.at)}</td></tr>
          </tbody>
        </table>
      </div>

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
        <div className="card">
          <h3>Currency converter</h3>
          <button className="btn" onClick={() => wrap('Bank of Canada rate', api.admin.fxOnline)}>Bank of Canada (Valet)</button>
          <FxManual onSet={(r) => wrap('Manual rate', () => api.admin.fxManual(r))} />
        </div>
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
      <RulesEditor wrap={wrap} />

      <div className="grid2 gap">
        <MyAccount me={me} wrap={wrap} onChanged={onPasswordChanged} />
        <Users me={me} wrap={wrap} />
      </div>

      <div className="card">
        <h3>Log</h3>
        <pre className="log">{log.join('\n') || '—'}</pre>
      </div>
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

function FxManual({ onSet }: { onSet: (r: number) => void }) {
  const [r, setR] = useState('');
  return (
    <div className="join" style={{ marginTop: 10 }}>
      <input className="input" placeholder="1 USD = ? CAD" value={r} onChange={(e) => setR(e.target.value)} />
      <button className="btn ghost" disabled={!Number(r)} onClick={() => onSet(Number(r))}>Save</button>
    </div>
  );
}

function MyAccount({ me, wrap, onChanged }: { me: Me; wrap: Wrap; onChanged: () => void }) {
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
        {['us', 'ca', 'adcvd', 'licences'].map((k) => (
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
