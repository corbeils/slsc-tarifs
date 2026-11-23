import { useEffect, useMemo, useState } from 'react';
import CodeSearch from '../components/CodeSearch';
import CountrySelect from '../components/CountrySelect';
import { api, fmtDate, money, pct, type CalcLine, type CalcResult, type Country, type Direction, type Flag, type SearchHit } from '../api';

const UNIT_LABELS: Record<string, string> = {
  kg: 'Net weight (kg)',
  liter: 'Volume (liters)',
  'pf.liter': 'Proof liters',
  'no.': 'Number of units',
  m3: 'Volume (m³)',
  m2: 'Area (m²)',
  'doz.': 'Dozens',
  t: 'Metric tons',
};
const PROVINCES = ['QC', 'ON', 'NB', 'NS', 'PE', 'NL', 'MB', 'SK', 'AB', 'BC', 'YT', 'NT', 'NU'];

interface Form {
  direction: Direction;
  hit: SearchHit | null;
  origin: string;
  value: string;
  currency: 'USD' | 'CAD';
  date: string;
  mode: 'truck' | 'rail' | 'ocean' | 'air';
  preferential: boolean;
  usContentPct: string;
  caMxContentPct: string;
  metalWeightPct: string;
  province: string;
  regime: string;
  repairValue: string;
  includeAdcvd: boolean;
  options: Record<string, boolean>;
  claimExemptions: string[];
  ch99Choice: Record<string, string>;
  quantities: Record<string, string>;
  fx: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const initial = (): Form => {
  const saved = localStorage.getItem('slsc-tarifs-form');
  const base: Form = {
    direction: 'CA-US',
    hit: null,
    origin: 'CA',
    value: '10000',
    currency: 'USD',
    date: today(),
    mode: 'truck',
    preferential: true,
    usContentPct: '',
    caMxContentPct: '',
    metalWeightPct: '',
    province: 'QC',
    regime: 'none',
    repairValue: '',
    includeAdcvd: false,
    options: {},
    claimExemptions: [],
    ch99Choice: {},
    quantities: {},
    fx: '',
  };
  try {
    return saved ? { ...base, ...JSON.parse(saved), date: today() } : base;
  } catch {
    return base;
  }
};

export default function Simulator() {
  const [f, setF] = useState<Form>(initial);
  const [countries, setCountries] = useState<Country[]>([]);
  const [res, setRes] = useState<CalcResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const j = f.direction === 'CA-US' ? 'US' : 'CA';

  useEffect(() => {
    api.countries().then(setCountries).catch(() => {});
  }, []);
  useEffect(() => localStorage.setItem('slsc-tarifs-form', JSON.stringify(f)), [f]);

  const switchDir = (d: Direction) =>
    setF((x) => ({
      ...x,
      direction: d,
      hit: null,
      origin: d === 'CA-US' ? (x.origin === 'US' ? 'CA' : x.origin) : x.origin === 'CA' ? 'US' : x.origin,
      currency: d === 'CA-US' ? 'USD' : 'CAD',
      options: {},
      claimExemptions: [],
      ch99Choice: {},
      regime: 'none',
    }));

  const body = useMemo(() => {
    if (!f.hit) return null;
    const n = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
    const q: Record<string, number> = {};
    for (const [k, v] of Object.entries(f.quantities)) if (n(v) !== undefined) q[k] = n(v)!;
    return {
      direction: f.direction,
      code: f.hit.code,
      origin: f.origin,
      value: n(f.value) ?? 0,
      currency: f.currency,
      date: f.date,
      mode: f.mode,
      preferential: f.preferential,
      usContentPct: n(f.usContentPct),
      caMxContentPct: n(f.caMxContentPct),
      metalWeightPct: n(f.metalWeightPct),
      province: f.province,
      regime: f.regime,
      repairValue: n(f.repairValue),
      includeAdcvd: f.includeAdcvd,
      options: f.options,
      claimExemptions: f.claimExemptions,
      ch99Choice: f.ch99Choice,
      quantities: q,
      fxUsdCad: n(f.fx),
    };
  }, [f]);

  useEffect(() => {
    if (!body) {
      setRes(null);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api
        .calc(body)
        .then((r) => {
          setRes(r);
          setErr('');
        })
        .catch((e) => setErr(e.message))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [JSON.stringify(body)]);

  const optionsByContext = useMemo(() => {
    const m = new Map<string, CalcResult['options']>();
    for (const o of res?.options ?? []) m.set(o.context, [...(m.get(o.context) ?? []), o]);
    return [...m.entries()];
  }, [res]);
  const claims = res?.exemptions.filter((e) => e.kind === 'claim') ?? [];
  const showUsContent = res?.needs.usContent || (f.options.usmca232 && f.preferential);

  return (
    <div className="sim">
      <section className="card form">
        <div className="seg">
          <button className={f.direction === 'CA-US' ? 'on' : ''} onClick={() => switchDir('CA-US')}>
            <span className="dir"><i>INBOUND USA</i></span> Import into the United States
          </button>
          <button className={f.direction === 'US-CA' ? 'on' : ''} onClick={() => switchDir('US-CA')}>
            <span className="dir"><i>INBOUND CANADA</i></span> Import into Canada
          </button>
        </div>

        <label className="lbl">{j === 'US' ? 'HTSUS code (10 digits)' : 'Canadian tariff item'}</label>
        <CodeSearch j={j} value={f.hit} onSelect={(h) => set('hit', h)} />

        <div className="grid2">
          <div>
            <label className="lbl">Country of origin</label>
            <CountrySelect countries={countries} value={f.origin} onChange={(c) => set('origin', c)} />
          </div>
          <div>
            <label className="lbl">Entry date</label>
            <input className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
          </div>
        </div>

        <div className="grid2">
          <div>
            <label className="lbl">Customs value</label>
            <div className="join">
              <input className="input num" inputMode="decimal" value={f.value} onChange={(e) => set('value', e.target.value)} />
              <select className="input" value={f.currency} onChange={(e) => set('currency', e.target.value as Form['currency'])}>
                <option>USD</option>
                <option>CAD</option>
              </select>
            </div>
          </div>
          <div>
            <label className="lbl">Mode of transport</label>
            <select className="input" value={f.mode} onChange={(e) => set('mode', e.target.value as Form['mode'])}>
              <option value="truck">Truck</option>
              <option value="rail">Rail</option>
              <option value="ocean">Ocean</option>
              <option value="air">Air</option>
            </select>
          </div>
        </div>

        {res?.needs.quantityUnits?.map((u) => (
          <div key={u}>
            <label className="lbl">{UNIT_LABELS[u] ?? u} — required for the specific rate</label>
            <input
              className="input num"
              value={f.quantities[u] ?? ''}
              onChange={(e) => set('quantities', { ...f.quantities, [u]: e.target.value })}
            />
          </div>
        ))}

        <label className={`check pref ${res && !res.preferential.eligible ? 'disabled' : ''}`}>
          <input type="checkbox" checked={f.preferential} onChange={(e) => set('preferential', e.target.checked)} />
          <span>
            Claim preferential treatment{' '}
            <b>{res?.preferential.label || (j === 'US' ? 'USMCA' : 'CUSMA')}</b>
            {res?.preferential.program && <em> ({res.preferential.program}: {res.preferential.rateText})</em>}
            {res && !res.preferential.eligible && <em> — not available for this origin / line</em>}
          </span>
        </label>

        {(showUsContent || res?.needs.caMxContent || res?.needs.metalWeight) && (
          <div className="grid2">
            {showUsContent && (
              <div>
                <label className="lbl">U.S. content (% of value)</label>
                <input className="input num" value={f.usContentPct} placeholder="e.g. 40" onChange={(e) => set('usContentPct', e.target.value)} />
              </div>
            )}
            {res?.needs.caMxContent && (
              <div>
                <label className="lbl">Canadian + Mexican content (%)</label>
                <input className="input num" value={f.caMxContentPct} placeholder="e.g. 30" onChange={(e) => set('caMxContentPct', e.target.value)} />
              </div>
            )}
            {res?.needs.metalWeight && (
              <div>
                <label className="lbl">Steel/aluminum/copper content (% by weight)</label>
                <input className="input num" value={f.metalWeightPct} placeholder="e.g. 60" onChange={(e) => set('metalWeightPct', e.target.value)} />
              </div>
            )}
          </div>
        )}

        <div className="grid2">
          <div>
            <label className="lbl">Special regime</label>
            <select className="input" value={f.regime} onChange={(e) => set('regime', e.target.value)}>
              {(res?.regimes ?? [{ id: 'none', label: 'Ordinary import' }]).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code ? `${r.code} — ` : ''}
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          {j === 'CA' ? (
            <div>
              <label className="lbl">Importer's province</label>
              <select className="input" value={f.province} onChange={(e) => set('province', e.target.value)}>
                {PROVINCES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="lbl">USD/CAD rate (optional)</label>
              <input className="input num" placeholder={res?.fx.usdCad?.toFixed(4)} value={f.fx} onChange={(e) => set('fx', e.target.value)} />
            </div>
          )}
        </div>
        {res?.needs.repairValue && (
          <div>
            <label className="lbl">Repair / alteration value ({f.currency})</label>
            <input className="input num" value={f.repairValue} onChange={(e) => set('repairValue', e.target.value)} />
          </div>
        )}

        {(optionsByContext.length > 0 || res?.flags.adcvd.length) && (
          <div className="opts">
            <div className="opts-title">Special conditions and exemptions</div>
            {res?.flags.adcvd.some((x) => x.level === 'danger') && (
              <label className="check">
                <input type="checkbox" checked={f.includeAdcvd} onChange={(e) => set('includeAdcvd', e.target.checked)} />
                <span>Include the AD/CVD cash deposit ("all others" rate) in the total</span>
              </label>
            )}
            {optionsByContext.map(([ctx, list]) => (
              <div key={ctx} className="optgroup">
                <div className="ctx">{ctx}</div>
                {list.map((o) => (
                  <label key={o.key} className="check" title={o.note}>
                    <input
                      type="checkbox"
                      checked={!!f.options[o.key]}
                      onChange={(e) => set('options', { ...f.options, [o.key]: e.target.checked })}
                    />
                    <span>
                      {o.label} {o.status === 'to verify' && <span className="badge warn">to verify</span>}
                    </span>
                  </label>
                ))}
              </div>
            ))}
            {claims.length > 0 && (
              <div className="optgroup">
                <div className="ctx">Exclusions to claim (Chapter 99 headings)</div>
                {claims.map((c) => (
                  <label key={c.id} className="check">
                    <input
                      type="checkbox"
                      checked={f.claimExemptions.includes(c.ch99!)}
                      onChange={(e) =>
                        set('claimExemptions', e.target.checked ? [...f.claimExemptions, c.ch99!] : f.claimExemptions.filter((x) => x !== c.ch99))
                      }
                    />
                    <span>
                      <span className="mono">{c.ch99}</span> — {c.label}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="results">
        {!f.hit && <Empty j={j} />}
        {err && <div className="alert danger">{err}</div>}
        {res && !res.ok && <div className="alert danger">{res.error}</div>}
        {res?.ok && <Result r={res} loading={loading} f={f} setChoice={(p, c) => set('ch99Choice', { ...f.ch99Choice, [p]: c })} />}
      </section>
    </div>
  );
}

function Empty({ j }: { j: 'US' | 'CA' }) {
  return (
    <div className="card empty">
      <h2>Estimate duties, surtaxes, fees and taxes</h2>
      <p>
        Choose the direction, then type a full {j === 'US' ? 'HTSUS code' : 'tariff item'} or keywords and{' '}
        <b>pick the line from the list</b>. The calculation updates on every change.
      </p>
      <ul>
        <li>Base duty (MFN, Column 2 or USMCA / FTA preference)</li>
        <li>Sections 232, 301 (China and "forced labor"), 338, 201 and other Chapter 99 headings</li>
        <li>Canadian surtaxes (U.S., China), steel quotas and steel derivatives</li>
        <li>AD/CVD and SIMA, licences and permits, prohibitions</li>
        <li>MPF / HMF, GST / HST, special regimes (Chapters 98 / 99)</li>
      </ul>
    </div>
  );
}

function Result({ r, loading, f, setChoice }: { r: CalcResult; loading: boolean; f: Form; setChoice: (p: string, c: string) => void }) {
  const cur = r.currency;
  const copy = () => {
    const txt = [
      `${r.line!.display} — ${r.line!.description}`,
      `Origin ${f.origin} · Value ${money(r.value, cur)} · ${r.direction === 'CA-US' ? 'INBOUND USA' : 'INBOUND CANADA'}`,
      ...r.lines.map((l) => `${l.label}${l.ch99 ? ' (' + l.ch99 + ')' : ''}: ${l.ratePct !== null && l.ratePct !== undefined ? pct(l.ratePct) : l.rateText ?? ''} → ${money(l.amount, cur)}`),
      `TOTAL: ${money(r.totals.total, cur)} (duties ${pct(r.totals.dutyPct)})`,
      ...r.flags.bans.map((x) => `PROHIBITED: ${x.title}`),
      ...r.flags.adcvd.map((x) => `AD/CVD: ${x.title}`),
      ...r.flags.licences.filter((x) => x.level !== 'info').map((x) => `Licence: ${x.agency} — ${x.title}`),
    ].join('\n');
    navigator.clipboard.writeText(txt);
  };
  const groups: [string, CalcLine['kind'][]][] = [
    ['Duties and measures', ['base', 'additional']],
    ['Anti-dumping / countervailing', ['adcvd']],
    ['Fees', ['fee']],
    ['Taxes', ['tax']],
  ];
  return (
    <div className={`stack ${loading ? 'loading' : ''}`}>
      {r.flags.bans.map((b, i) => (
        <div key={i} className="alert ban">
          <b>⛔ {b.title}</b>
          {b.detail && <div>{b.detail}</div>}
        </div>
      ))}
      <div className="card head">
        <div className="head-top">
          <div>
            <div className="mono big">{r.line!.display}</div>
            <div className="desc">{r.line!.description}</div>
            {r.line!.path && <div className="path" title={r.line!.path}>{r.line!.path}</div>}
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={copy}>
              Copy
            </button>
            <button className="btn ghost" onClick={() => window.print()}>
              Print
            </button>
          </div>
        </div>
        <div className="rates">
          {r.destination === 'US' ? (
            <>
              <Rate label="General (Col. 1)" v={r.line!.general} />
              <Rate label="Special" v={r.line!.special} />
              <Rate label="Column 2" v={r.line!.other} />
            </>
          ) : (
            <>
              <Rate label="MFN" v={r.line!.general} />
              <Rate label="UST (CUSMA)" v={r.line!.pref?.UST} />
              <Rate label="General Tariff" v={r.line!.other} />
            </>
          )}
          {r.line!.units && <Rate label="Units" v={r.line!.units} />}
        </div>
      </div>

      <div className="totals">
        <Tot label="Duties and surtaxes" v={money(r.totals.duties, cur)} />
        {r.totals.adcvd > 0 && <Tot label="AD/CVD" v={money(r.totals.adcvd, cur)} />}
        <Tot label="Fees" v={money(r.totals.fees, cur)} />
        <Tot label="Taxes" v={money(r.totals.taxes, cur)} />
        <Tot label="Total payable" v={money(r.totals.total, cur)} strong />
        <Tot label="Effective duty rate" v={pct(r.totals.dutyPct)} strong />
      </div>
      {r.deferred && (
        <div className="alert info">
          <b>Duty-suspension regime:</b> {r.deferred.note} Estimated bond: {money(r.deferred.bond, cur)}.
        </div>
      )}

      <div className="card">
        <table className="lines">
          <thead>
            <tr>
              <th>Measure</th>
              <th>Heading / ref.</th>
              <th className="r">Rate</th>
              <th className="r">Basis</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          {groups.map(([title, kinds]) => {
            const ls = r.lines.filter((l) => kinds.includes(l.kind));
            if (!ls.length) return null;
            return (
              <tbody key={title}>
                <tr className="grp">
                  <td colSpan={5}>{title}</td>
                </tr>
                {ls.map((l) => (
                  <tr key={l.key} className={`${l.exempted ? 'exempt' : ''} ${l.notCumulated ? 'nc' : ''}`}>
                    <td>
                      <div className="lname">
                        {l.url ? (
                          <a href={l.url} target="_blank" rel="noreferrer">
                            {l.label}
                          </a>
                        ) : (
                          l.label
                        )}{' '}
                        {l.status === 'to verify' && <span className="badge warn">to verify</span>}
                        {l.exempted && <span className="badge ok">exempt</span>}
                        {l.notCumulated && <span className="badge muted">not stacked</span>}
                      </div>
                      {l.note && <div className="note">{l.note}</div>}
                      {l.alternatives && (
                        <select className="input small" value={f.ch99Choice[l.key] ?? l.ch99} onChange={(e) => setChoice(l.key, e.target.value)}>
                          <option value={l.ch99}>
                            {l.ch99} — {l.rateText} (applied)
                          </option>
                          {l.alternatives.map((a) => (
                            <option key={a.ch99} value={a.ch99}>
                              {a.ch99} — {a.label} ({pct(a.ratePct)})
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>{l.ch99 ? <span className="mono">{l.ch99}</span> : <span className="ref">{l.legal ?? l.program ?? ''}</span>}</td>
                    <td className="r">{l.ratePct !== null && l.ratePct !== undefined ? pct(l.ratePct) : <span className="mono small">{l.rateText}</span>}</td>
                    <td className="r">{money(l.basis, cur)}</td>
                    <td className="r b">{money(l.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            );
          })}
          <tfoot>
            <tr>
              <td colSpan={4}>Estimated landed cost (value + duties + fees + taxes)</td>
              <td className="r b">{money(r.totals.landed, cur)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <FlagBlock title="Anti-dumping / countervailing" flags={r.flags.adcvd} />
      <FlagBlock title="Licences, permits and other government agency requirements" flags={r.flags.licences} grouped />
      <FlagBlock title="To verify" flags={r.flags.warnings} />
      <FlagBlock title="Information" flags={r.flags.info} />

      <div className="meta-line">
        Converted value: {money(r.valueInput.amount, r.valueInput.currency)} → {money(r.value, cur)} (1 USD = {r.fx.usdCad.toFixed(4)} CAD, {r.fx.source}
        {r.fx.date ? `, ${r.fx.date}` : ''}) · Tariff: {r.data.source} ({fmtDate(r.data.importedAt)}) · Rules: {fmtDate(r.data.rulesLoadedAt)}
      </div>
    </div>
  );
}

function Rate({ label, v }: { label: string; v?: string | null }) {
  return (
    <div className="rate-cell">
      <span>{label}</span>
      <b className="mono">{v || '—'}</b>
    </div>
  );
}
function Tot({ label, v, strong }: { label: string; v: string; strong?: boolean }) {
  return (
    <div className={`tot ${strong ? 'strong' : ''}`}>
      <span>{label}</span>
      <b>{v}</b>
    </div>
  );
}
function FlagBlock({ title, flags, grouped }: { title: string; flags: Flag[]; grouped?: boolean }) {
  if (!flags.length) return null;
  const main = grouped ? flags.filter((x) => x.level !== 'info') : flags;
  const infos = grouped ? flags.filter((x) => x.level === 'info') : [];
  return (
    <div className="card flags">
      <h3>{title}</h3>
      {main.length === 0 && <div className="muted small">No specific requirement detected for this code.</div>}
      {main.map((x, i) => (
        <div key={i} className={`flag ${x.level}`}>
          <div>
            {x.agency && <span className="agency">{x.agency}</span>}
            <b>{x.title}</b>
          </div>
          {x.detail && <div className="detail">{x.detail}</div>}
          {x.url && (
            <a href={x.url} target="_blank" rel="noreferrer">
              Source ↗
            </a>
          )}
        </div>
      ))}
      {infos.length > 0 && (
        <div className="muted small infos">
          {infos.map((x, i) => (
            <span key={i}>
              {x.agency}: {x.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
