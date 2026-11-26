import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import CodeSearch from '../components/CodeSearch';
import CountrySelect from '../components/CountrySelect';
import { useI18n } from '../i18n';
import { convert, useDisplayCurrency } from '../currency';
import { api, fmtDate, money, pct, type AgreementInfo, type CalcLine, type CalcResult, type Country, type Direction, type Flag, type SearchHit } from '../api';

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
export const EU27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

interface Form {
  direction: Direction;
  hit: SearchHit | null;
  origin: string;
  value: string;
  currency: 'USD' | 'CAD' | 'EUR';
  date: string;
  mode: 'truck' | 'rail' | 'ocean' | 'air';
  preferential: boolean;
  agreement: string;
  usContentPct: string;
  caMxContentPct: string;
  metalWeightPct: string;
  province: string;
  memberState: string;
  freight: string;
  insurance: string;
  inlandFreight: string;
  adcvdCompany: string;
  regime: string;
  repairValue: string;
  includeAdcvd: boolean;
  options: Record<string, boolean>;
  claimExemptions: string[];
  ch99Choice: Record<string, string>;
  quantities: Record<string, string>;
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
    preferential: false,
    agreement: '',
    usContentPct: '',
    caMxContentPct: '',
    metalWeightPct: '',
    province: 'QC',
    memberState: 'FR',
    freight: '',
    insurance: '',
    inlandFreight: '',
    adcvdCompany: '',
    regime: 'none',
    repairValue: '',
    includeAdcvd: false,
    options: {},
    claimExemptions: [],
    ch99Choice: {},
    quantities: {},
  };
  try {
    // a preference is never claimed by default
    return saved ? { ...base, ...JSON.parse(saved), date: today(), preferential: false, agreement: '' } : base;
  } catch {
    return base;
  }
};

export default function Simulator() {
  const { t, lang } = useI18n();
  const t_ = t;
  const [f, setF] = useState<Form>(initial);
  const [countries, setCountries] = useState<Country[]>([]);
  const [res, setRes] = useState<CalcResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const j: 'US' | 'CA' | 'EU' = f.direction === 'CA-US' ? 'US' : f.direction === 'IN-EU' ? 'EU' : 'CA';

  useEffect(() => {
    api.countries().then(setCountries).catch(() => {});
  }, []);
  useEffect(() => localStorage.setItem('slsc-tarifs-form', JSON.stringify(f)), [f]);
  // New line or new origin: nothing claimed until the user ticks an agreement
  useEffect(() => setF((x) => ({ ...x, preferential: false, agreement: '' })), [f.origin, f.hit?.code, f.direction]);

  const switchDir = (d: Direction) =>
    setF((x) => ({
      ...x,
      direction: d,
      hit: null,
      origin: d === 'CA-US' ? (x.origin === 'US' ? 'CA' : x.origin) : d === 'US-CA' ? (x.origin === 'CA' ? 'US' : x.origin) : EU27.includes(x.origin) ? 'CA' : x.origin,
      currency: d === 'CA-US' ? 'USD' : d === 'IN-EU' ? 'EUR' : 'CAD',
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
      agreement: f.agreement || undefined,
      usContentPct: n(f.usContentPct),
      caMxContentPct: n(f.caMxContentPct),
      metalWeightPct: n(f.metalWeightPct),
      province: f.province,
      memberState: f.memberState,
      freight: n(f.freight),
      insurance: n(f.insurance),
      inlandFreight: n(f.inlandFreight),
      adcvdCompany: f.adcvdCompany || undefined,
      regime: f.regime,
      repairValue: n(f.repairValue),
      includeAdcvd: f.includeAdcvd,
      options: f.options,
      claimExemptions: f.claimExemptions,
      ch99Choice: f.ch99Choice,
      quantities: q,
    };
  }, [f]);

  useEffect(() => {
    if (!body) {
      setRes(null);
      return;
    }
    setLoading(true);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api
        .calc(body, ctl.signal)
        .then((r) => {
          setRes(r);
          setErr('');
        })
        .catch((e) => {
          if (ctl.signal.aborted) return; // superseded by a newer request
          setErr(e instanceof TypeError ? t_('The server could not be reached. Check your connection and try again.') : e.message);
        })
        .finally(() => {
          if (!ctl.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [JSON.stringify(body), lang]);

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
            <span className="dir"><i>INBOUND USA</i></span> {t('Import into the United States')}
          </button>
          <button className={f.direction === 'US-CA' ? 'on' : ''} onClick={() => switchDir('US-CA')}>
            <span className="dir"><i>INBOUND CANADA</i></span> {t('Import into Canada')}
          </button>
          <button className={f.direction === 'IN-EU' ? 'on' : ''} onClick={() => switchDir('IN-EU')}>
            <span className="dir"><i>INBOUND EU</i></span> {t('Import into the European Union')}
          </button>
        </div>

        <label className="lbl">{j === 'US' ? t('HTSUS code (10 digits)') : j === 'EU' ? t('TARIC code (10 digits)') : t('Canadian tariff item')}</label>
        <CodeSearch j={j} value={f.hit} onSelect={(h) => set('hit', h)} />

        <div className="grid2">
          <div>
            <label className="lbl">{t('Country of origin')}</label>
            <CountrySelect countries={countries} value={f.origin} onChange={(c) => set('origin', c)} />
          </div>
          <div>
            <label className="lbl">{t('Entry date')}</label>
            <input className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
          </div>
        </div>

        <div className="grid2">
          <div>
            <label className="lbl">{t('Customs value')}</label>
            <div className="join">
              <input className="input num" inputMode="decimal" value={f.value} onChange={(e) => set('value', e.target.value)} />
              <select className="input" value={f.currency} onChange={(e) => set('currency', e.target.value as Form['currency'])}>
                <option>USD</option>
                <option>CAD</option>
                <option>EUR</option>
              </select>
            </div>
          </div>
          <div>
            <label className="lbl">{t('Mode of transport')}</label>
            <select className="input" value={f.mode} onChange={(e) => set('mode', e.target.value as Form['mode'])}>
              <option value="truck">{t('Truck')}</option>
              <option value="rail">{t('Rail')}</option>
              <option value="ocean">{t('Ocean')}</option>
              <option value="air">{t('Air')}</option>
            </select>
          </div>
        </div>

        {res?.needs.quantityUnits?.map((u) => (
          <div key={u}>
            <label className="lbl">{UNIT_LABELS[u] ? t(UNIT_LABELS[u]) : u} — {t('required for the specific rate')}</label>
            <input
              className="input num"
              value={f.quantities[u] ?? ''}
              onChange={(e) => set('quantities', { ...f.quantities, [u]: e.target.value })}
            />
          </div>
        ))}

        {res?.ok && <FtaClaim r={res} f={f} setF={setF} />}

        {(showUsContent || res?.needs.caMxContent || res?.needs.metalWeight) && (
          <div className="grid2">
            {showUsContent && (
              <div>
                <label className="lbl">{t('U.S. content (% of value)')}</label>
                <input className="input num" value={f.usContentPct} placeholder={t('e.g. 40')} onChange={(e) => set('usContentPct', e.target.value)} />
              </div>
            )}
            {res?.needs.caMxContent && (
              <div>
                <label className="lbl">{t('Canadian + Mexican content (%)')}</label>
                <input className="input num" value={f.caMxContentPct} placeholder={t('e.g. 30')} onChange={(e) => set('caMxContentPct', e.target.value)} />
              </div>
            )}
            {res?.needs.metalWeight && (
              <div>
                <label className="lbl">{t('Steel/aluminum/copper content (% by weight)')}</label>
                <input className="input num" value={f.metalWeightPct} placeholder={t('e.g. 60')} onChange={(e) => set('metalWeightPct', e.target.value)} />
              </div>
            )}
          </div>
        )}

        {j === 'EU' && (
          <div className="grid3">
            <div>
              <label className="lbl">{t('Freight to the EU border ({cur})', { cur: f.currency })}</label>
              <input className="input num" inputMode="decimal" placeholder="0" value={f.freight} onChange={(e) => set('freight', e.target.value)} />
            </div>
            <div>
              <label className="lbl">{t('Insurance ({cur})', { cur: f.currency })}</label>
              <input className="input num" inputMode="decimal" placeholder="0" value={f.insurance} onChange={(e) => set('insurance', e.target.value)} />
            </div>
            <div>
              <label className="lbl">{t('Transport to destination in the EU ({cur})', { cur: f.currency })}</label>
              <input className="input num" inputMode="decimal" placeholder="0" value={f.inlandFreight} onChange={(e) => set('inlandFreight', e.target.value)} />
            </div>
          </div>
        )}

        <div className={j !== 'US' ? 'grid2' : ''}>
          <div>
            <label className="lbl">{t('Special regime')}</label>
            <select className="input" value={f.regime} onChange={(e) => set('regime', e.target.value)}>
              {(res?.regimes ?? [{ id: 'none', label: t('Ordinary import') }]).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code ? `${r.code} — ` : ''}
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          {j === 'EU' && (
            <div>
              <label className="lbl">{t('Member state of destination (VAT)')}</label>
              <select className="input" value={f.memberState} onChange={(e) => set('memberState', e.target.value)}>
                {[...EU27]
                  .map((c) => ({ c, n: countries.find((x) => x.code === c)?.[lang === 'fr' ? 'fr' : 'en'] ?? c }))
                  .sort((a, b) => a.n.localeCompare(b.n, lang))
                  .map(({ c, n }) => (
                    <option key={c} value={c}>
                      {n} ({c})
                    </option>
                  ))}
              </select>
            </div>
          )}
          {j === 'CA' && (
            <div>
              <label className="lbl">{t("Importer's province")}</label>
              <select className="input" value={f.province} onChange={(e) => set('province', e.target.value)}>
                {PROVINCES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {res?.needs.repairValue && (
          <div>
            <label className="lbl">{t('Repair / alteration value ({cur})', { cur: f.currency })}</label>
            <input className="input num" value={f.repairValue} onChange={(e) => set('repairValue', e.target.value)} />
          </div>
        )}

        {(optionsByContext.length > 0 || res?.flags.adcvd.length) && (
          <div className="opts">
            <div className="opts-title">{t('Special conditions and exemptions')}</div>
            {res?.flags.adcvd.some((x) => x.level === 'danger') && (
              <label className="check">
                <input type="checkbox" checked={f.includeAdcvd} onChange={(e) => set('includeAdcvd', e.target.checked)} />
                <span>{t('Include the AD/CVD cash deposit ("all others" rate) in the total')}</span>
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
                      {o.label} {o.status === 'to verify' && <span className="badge warn">{t('to verify')}</span>}
                    </span>
                  </label>
                ))}
              </div>
            ))}
            {claims.length > 0 && (
              <div className="optgroup">
                <div className="ctx">{t('Exclusions to claim (Chapter 99 headings)')}</div>
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

const isClaimed = (f: Form, r: CalcResult, code: string) => f.preferential && (f.agreement ? f.agreement === code : r.preferential.program === code);

/** Agreements the user can claim for this origin on this line (none ticked by default). */
function FtaClaim({ r, f, setF }: { r: CalcResult; f: Form; setF: Dispatch<SetStateAction<Form>> }) {
  const { t } = useI18n();
  const claimable = r.agreements.filter((a) => a.applicable !== 'no' && a.state !== 'expired');
  const pick = (code: string, on: boolean) => setF((x) => ({ ...x, preferential: on, agreement: on ? code : '' }));
  // Canada/Mexico into the U.S. with no "S" indicator: USMCA origin can still be claimed (301 / MPF)
  const genericUsmca = !claimable.length && r.preferential.eligible;
  return (
    <div className="fta">
      <div className="opts-title">{t('Free trade agreements')}</div>
      {claimable.map((a) => (
        <label key={a.code} className={`check pref ${isClaimed(f, r, a.code) ? 'on' : ''}`}>
          <input type="checkbox" checked={isClaimed(f, r, a.code)} onChange={(e) => pick(a.code, e.target.checked)} />
          <span>
            {t('Claim')} <b>{a.short ?? a.code}</b> <em>({a.code}: {a.rateText})</em>
            {a.applicable === 'check' && <span className="badge warn">{t('check eligibility')}</span>}
            <small className="fta-name">{a.name}</small>
          </span>
        </label>
      ))}
      {genericUsmca && (
        <label className={`check pref ${f.preferential ? 'on' : ''}`}>
          <input type="checkbox" checked={f.preferential} onChange={(e) => pick('', e.target.checked)} />
          <span>
            {t('Claim')} <b>{t(r.preferential.label)}</b> <em>— {t('originating goods (the general rate already applies)')}</em>
          </span>
        </label>
      )}
      {!claimable.length && !genericUsmca && <div className="muted small">{t('No free trade agreement can be claimed for this origin on this line.')}</div>}
    </div>
  );
}

function AgreementsCard({ r, origin }: { r: CalcResult; origin: string }) {
  const { t, lang } = useI18n();
  const href = (u?: string) => (u && lang === 'fr' ? u.replace(/-eng\.(html|pdf)/, '-fra.$1') : u);
  const status = (a: AgreementInfo) =>
    a.state === 'expired' ? <span className="badge muted">{t('expired')}</span>
    : a.applicable === 'yes' ? <span className="badge ok">{t('available for {origin}', { origin })}</span>
    : a.applicable === 'check' ? <span className="badge warn">{t('check eligibility')}</span>
    : <span className="badge muted">{t('other countries')}</span>;
  return (
    <div className="card flags">
      <h3>{t('Free trade agreements for this tariff line')}</h3>
      {r.agreements.length === 0 ? (
        <div className="muted small">{t('No preferential rate on this line: the general rate applies to every origin.')}</div>
      ) : (
        <table className="simple fta-table">
          <thead>
            <tr>
              <th>{t('Code')}</th>
              <th>{t('Agreement / program')}</th>
              <th className="r">{t('Rate')}</th>
              <th>{t('Status')}</th>
            </tr>
          </thead>
          <tbody>
            {r.agreements.map((a) => (
              <tr key={a.code} className={a.applicable === 'no' || a.state === 'expired' ? 'dim' : ''}>
                <td className="mono">{a.code}</td>
                <td>
                  {a.url ? <a href={href(a.url)} target="_blank" rel="noreferrer">{a.name}</a> : a.name}
                  {a.short && a.short !== a.code && <span className="muted"> · {a.short}</span>}
                  {a.note && <div className="muted small">{a.note}</div>}
                </td>
                <td className="r mono">{a.rateText}</td>
                <td>{status(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.lineUrl && (
        <a className="small" href={r.lineUrl} target="_blank" rel="noreferrer">
          {t('View this line on the official tariff')} ({r.line?.display}) ↗
        </a>
      )}
    </div>
  );
}

function Empty({ j }: { j: 'US' | 'CA' | 'EU' }) {
  const { t } = useI18n();
  return (
    <div className="card empty">
      <h2>{t('Estimate duties, surtaxes, fees and taxes')}</h2>
      <p>
        {t(j === 'US' ? 'Choose the direction, then type a full HTSUS code or keywords and' : j === 'EU' ? 'Choose the direction, then type a full TARIC code or keywords and' : 'Choose the direction, then type a full tariff item or keywords and')}{' '}
        <b>{t('pick the line from the list')}</b>. {t('The calculation updates on every change.')}
      </p>
      <ul>
        <li>{t('Base duty (MFN, Column 2 or USMCA / FTA preference)')}</li>
        <li>{t('Sections 232, 301 (China and "forced labor"), 338, 201 and other Chapter 99 headings')}</li>
        <li>{t('Canadian surtaxes (U.S., China), steel quotas and steel derivatives')}</li>
        <li>{t('AD/CVD and SIMA, licences and permits, prohibitions')}</li>
        <li>{t('MPF / HMF, GST / HST, special regimes (Chapters 98 / 99)')}</li>
      </ul>
    </div>
  );
}

function Result({ r, loading, f, setChoice }: { r: CalcResult; loading: boolean; f: Form; setChoice: (p: string, c: string) => void }) {
  const { t } = useI18n();
  const cur = r.currency;
  const { cur: shown } = useDisplayCurrency();
  /** Same amount in the currency chosen at the top (only when it differs from the local currency). */
  const alt = (n: number) => {
    if (shown === r.currency) return null;
    const v = convert(n, r.currency, shown, r.fx);
    return v === null ? null : money(v, shown);
  };
  const copy = () => {
    const txt = [
      `${r.line!.display} — ${r.line!.description}`,
      `${t('Origin')} ${f.origin} · ${t('Value')} ${money(r.value, cur)} · ${r.direction === 'CA-US' ? 'INBOUND USA' : r.direction === 'IN-EU' ? 'INBOUND EU' : 'INBOUND CANADA'}`,
      ...r.lines.map((l) => `${l.label}${l.ch99 ? ' (' + l.ch99 + ')' : ''}: ${l.ratePct !== null && l.ratePct !== undefined ? pct(l.ratePct) : l.rateText ?? ''} → ${money(l.amount, cur)}`),
      `${t('TOTAL')}: ${money(r.totals.total, cur)} (${t('duties')} ${pct(r.totals.dutyPct)})`,
      ...r.flags.bans.map((x) => `${t('PROHIBITED')}: ${x.title}`),
      ...r.flags.adcvd.map((x) => `AD/CVD: ${x.title}`),
      ...r.flags.licences.filter((x) => x.level !== 'info').map((x) => `${t('Licence')}: ${x.agency} — ${x.title}`),
    ].join('\n');
    navigator.clipboard.writeText(txt);
  };
  const groups: [string, CalcLine['kind'][]][] = [
    [t('Duties and measures'), ['base', 'additional']],
    [t('Anti-dumping / countervailing'), ['adcvd']],
    [t('Fees'), ['fee']],
    [t('Taxes'), ['tax']],
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
              {t('Copy')}
            </button>
            <button className="btn ghost" onClick={() => window.print()}>
              {t('Print')}
            </button>
          </div>
        </div>
        <div className="rates">
          {r.destination === 'EU' ? (
            <>
              <Rate label={t('Applied customs duty')} v={r.lines.find((l) => l.key === 'base')?.rateText} />
              <Rate label={t('Import VAT')} v={r.lines.find((l) => l.key === 'vat') ? pct(r.lines.find((l) => l.key === 'vat')!.ratePct) : null} />
            </>
          ) : r.destination === 'US' ? (
            <>
              <Rate label={t('General (Col. 1)')} v={r.line!.general} />
              <Rate label={t('Special')} v={r.line!.special} />
              <Rate label={t('Column 2')} v={r.line!.other} />
            </>
          ) : (
            <>
              <Rate label={t('MFN')} v={r.line!.general} />
              <Rate label={t('UST (CUSMA)')} v={r.line!.pref?.UST} />
              <Rate label={t('General Tariff')} v={r.line!.other} />
            </>
          )}
          {r.line!.units && <Rate label={t('Units')} v={r.line!.units} />}
        </div>
      </div>

      <div className="totals">
        <Tot label={t('Duties and surtaxes')} v={money(r.totals.duties, cur)} alt={alt(r.totals.duties)} />
        {r.totals.adcvd > 0 && <Tot label="AD/CVD" v={money(r.totals.adcvd, cur)} alt={alt(r.totals.adcvd)} />}
        <Tot label={t('Fees')} v={money(r.totals.fees, cur)} alt={alt(r.totals.fees)} />
        <Tot label={t('Taxes')} v={money(r.totals.taxes, cur)} alt={alt(r.totals.taxes)} />
        <Tot label={t('Total payable')} v={money(r.totals.total, cur)} alt={alt(r.totals.total)} strong />
        <Tot label={t('Effective duty rate')} v={pct(r.totals.dutyPct)} strong />
      </div>
      {r.deferred && (
        <div className="alert info">
          <b>{t('Duty-suspension regime:')}</b> {r.deferred.note} {t('Estimated bond:')} {money(r.deferred.bond, cur)}.
        </div>
      )}

      <div className="card">
        <table className="lines">
          <thead>
            <tr>
              <th>{t('Measure')}</th>
              <th>{t('Heading / ref.')}</th>
              <th className="r">{t('Rate')}</th>
              <th className="r">{t('Basis')}</th>
              <th className="r">{t('Amount')}</th>
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
                        {l.status === 'to verify' && <span className="badge warn">{t('to verify')}</span>}
                        {l.exempted && <span className="badge ok">{t('exempt')}</span>}
                        {l.notCumulated && <span className="badge muted">{t('not stacked')}</span>}
                      </div>
                      {l.note && <div className="note">{l.note}</div>}
                      {l.alternatives && (
                        <select className="input small" value={f.ch99Choice[l.key] ?? l.ch99} onChange={(e) => setChoice(l.key, e.target.value)}>
                          <option value={l.ch99}>
                            {l.ch99} — {l.rateText} ({t('applied')})
                          </option>
                          {l.alternatives.map((a) => (
                            <option key={a.ch99} value={a.ch99}>
                              {a.ch99} — {a.label} ({pct(a.ratePct)})
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className={l.ch99 || l.legal || l.program ? '' : 'empty'} data-label={t('Heading / ref.')}>
                      {l.ch99 ? <span className="mono">{l.ch99}</span> : <span className="ref">{l.legal ?? l.program ?? ''}</span>}
                    </td>
                    <td className="r" data-label={t('Rate')}>{l.ratePct !== null && l.ratePct !== undefined ? pct(l.ratePct) : <span className="mono small">{l.rateText}</span>}</td>
                    <td className="r" data-label={t('Basis')}>{money(l.basis, cur)}</td>
                    <td className="r b" data-label={t('Amount')}>{money(l.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            );
          })}
          <tfoot>
            <tr>
              <td colSpan={4} className="landed-label">{t('Estimated landed cost (value + duties + fees + taxes)')}</td>
              <td className="r b">
                {money(r.totals.landed, cur)}
                {alt(r.totals.landed) && <div className="alt-cur">≈ {alt(r.totals.landed)}</div>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <AgreementsCard r={r} origin={f.origin} />
      <FlagBlock title={t('Anti-dumping / countervailing')} flags={r.flags.adcvd} />
      <FlagBlock title={t('Licences, permits and other government agency requirements')} flags={r.flags.licences} grouped />
      <FlagBlock title={t('To verify')} flags={r.flags.warnings} />
      <FlagBlock title={t('Information')} flags={r.flags.info} />

      <div className="meta-line">
        {t('Converted value:')} {money(r.valueInput.amount, r.valueInput.currency)} → {money(r.value, cur)} (1 USD = {r.fx.usdCad.toFixed(4)} CAD{r.destination === 'EU' && r.fx.eurCad ? ` · 1 EUR = ${r.fx.eurCad.toFixed(4)} CAD` : ''}, {r.fx.source}
        {r.fx.date ? `, ${r.fx.date}` : ''}) · {t('Tariff:')} {r.data.source} ({fmtDate(r.data.importedAt)}) · {t('Rules:')} {fmtDate(r.data.rulesLoadedAt)}
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
function Tot({ label, v, strong, alt }: { label: string; v: string; strong?: boolean; alt?: string | null }) {
  return (
    <div className={`tot ${strong ? 'strong' : ''}`}>
      <span>{label}</span>
      <b>{v}</b>
      {alt && <small className="alt-cur">≈ {alt}</small>}
    </div>
  );
}
function FlagBlock({ title, flags, grouped }: { title: string; flags: Flag[]; grouped?: boolean }) {
  const { t } = useI18n();
  if (!flags.length) return null;
  const main = grouped ? flags.filter((x) => x.level !== 'info') : flags;
  const infos = grouped ? flags.filter((x) => x.level === 'info') : [];
  return (
    <div className="card flags">
      <h3>{title}</h3>
      {main.length === 0 && <div className="muted small">{t('No specific requirement detected for this code.')}</div>}
      {main.map((x, i) => (
        <div key={i} className={`flag ${x.level}`}>
          <div>
            {x.agency && <span className="agency">{x.agency}</span>}
            <b>{x.title}</b>
          </div>
          {x.detail && <div className="detail">{x.detail}</div>}
          {x.url && (
            <a href={x.url} target="_blank" rel="noreferrer">
              {t('Source')} ↗
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
