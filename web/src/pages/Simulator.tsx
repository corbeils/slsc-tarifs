import { useEffect, useMemo, useState } from 'react';
import CodeSearch from '../components/CodeSearch';
import CountrySelect from '../components/CountrySelect';
import { api, fmtDate, money, pct, type CalcLine, type CalcResult, type Country, type Direction, type Flag, type SearchHit } from '../api';

const UNIT_LABELS: Record<string, string> = {
  kg: 'Poids net (kg)',
  liter: 'Volume (litres)',
  'pf.liter': 'Litres d’alcool pur (proof liters)',
  'no.': 'Nombre d’unités',
  m3: 'Volume (m³)',
  m2: 'Surface (m²)',
  'doz.': 'Douzaines',
  t: 'Tonnes',
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
            <span className="dir"><i>INBOUND USA</i></span> Importation aux États-Unis
          </button>
          <button className={f.direction === 'US-CA' ? 'on' : ''} onClick={() => switchDir('US-CA')}>
            <span className="dir"><i>INBOUND CANADA</i></span> Importation au Canada
          </button>
        </div>

        <label className="lbl">{j === 'US' ? 'Code HTSUS (10 chiffres)' : 'Numéro tarifaire canadien'}</label>
        <CodeSearch j={j} value={f.hit} onSelect={(h) => set('hit', h)} />

        <div className="grid2">
          <div>
            <label className="lbl">Pays d’origine</label>
            <CountrySelect countries={countries} value={f.origin} onChange={(c) => set('origin', c)} />
          </div>
          <div>
            <label className="lbl">Date d’entrée</label>
            <input className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
          </div>
        </div>

        <div className="grid2">
          <div>
            <label className="lbl">Valeur en douane</label>
            <div className="join">
              <input className="input num" inputMode="decimal" value={f.value} onChange={(e) => set('value', e.target.value)} />
              <select className="input" value={f.currency} onChange={(e) => set('currency', e.target.value as Form['currency'])}>
                <option>USD</option>
                <option>CAD</option>
              </select>
            </div>
          </div>
          <div>
            <label className="lbl">Mode de transport</label>
            <select className="input" value={f.mode} onChange={(e) => set('mode', e.target.value as Form['mode'])}>
              <option value="truck">Routier</option>
              <option value="rail">Ferroviaire</option>
              <option value="ocean">Maritime</option>
              <option value="air">Aérien</option>
            </select>
          </div>
        </div>

        {res?.needs.quantityUnits?.map((u) => (
          <div key={u}>
            <label className="lbl">{UNIT_LABELS[u] ?? u} — requis pour le taux spécifique</label>
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
            Réclamer le traitement préférentiel{' '}
            <b>{res?.preferential.label || (j === 'US' ? 'ACEUM / USMCA' : 'ACEUM / CUSMA')}</b>
            {res?.preferential.program && <em> ({res.preferential.program} : {res.preferential.rateText})</em>}
            {res && !res.preferential.eligible && <em> — non admissible pour cette origine / ligne</em>}
          </span>
        </label>

        {(showUsContent || res?.needs.caMxContent || res?.needs.metalWeight) && (
          <div className="grid2">
            {showUsContent && (
              <div>
                <label className="lbl">Contenu américain (% de la valeur)</label>
                <input className="input num" value={f.usContentPct} placeholder="ex. 40" onChange={(e) => set('usContentPct', e.target.value)} />
              </div>
            )}
            {res?.needs.caMxContent && (
              <div>
                <label className="lbl">Contenu canadien + mexicain (%)</label>
                <input className="input num" value={f.caMxContentPct} placeholder="ex. 30" onChange={(e) => set('caMxContentPct', e.target.value)} />
              </div>
            )}
            {res?.needs.metalWeight && (
              <div>
                <label className="lbl">Teneur en acier/alu/cuivre (% du poids)</label>
                <input className="input num" value={f.metalWeightPct} placeholder="ex. 60" onChange={(e) => set('metalWeightPct', e.target.value)} />
              </div>
            )}
          </div>
        )}

        <div className="grid2">
          <div>
            <label className="lbl">Régime spécial</label>
            <select className="input" value={f.regime} onChange={(e) => set('regime', e.target.value)}>
              {(res?.regimes ?? [{ id: 'none', label: 'Importation ordinaire' }]).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code ? `${r.code} — ` : ''}
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          {j === 'CA' ? (
            <div>
              <label className="lbl">Province de l’importateur</label>
              <select className="input" value={f.province} onChange={(e) => set('province', e.target.value)}>
                {PROVINCES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="lbl">Taux USD/CAD (facultatif)</label>
              <input className="input num" placeholder={res?.fx.usdCad?.toFixed(4)} value={f.fx} onChange={(e) => set('fx', e.target.value)} />
            </div>
          )}
        </div>
        {res?.needs.repairValue && (
          <div>
            <label className="lbl">Valeur de la réparation / modification ({f.currency})</label>
            <input className="input num" value={f.repairValue} onChange={(e) => set('repairValue', e.target.value)} />
          </div>
        )}

        {(optionsByContext.length > 0 || res?.flags.adcvd.length) && (
          <div className="opts">
            <div className="opts-title">Conditions particulières et exemptions</div>
            {res?.flags.adcvd.some((x) => x.level === 'danger') && (
              <label className="check">
                <input type="checkbox" checked={f.includeAdcvd} onChange={(e) => set('includeAdcvd', e.target.checked)} />
                <span>Inclure le dépôt AD/CVD (taux « tous les autres ») dans le total</span>
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
                      {o.label} {o.status === 'à valider' && <span className="badge warn">à valider</span>}
                    </span>
                  </label>
                ))}
              </div>
            ))}
            {claims.length > 0 && (
              <div className="optgroup">
                <div className="ctx">Exclusions à réclamer (rubriques du ch. 99)</div>
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
      <h2>Estimez les droits, surtaxes, frais et taxes</h2>
      <p>
        Choisissez la direction, puis tapez un {j === 'US' ? 'code HTSUS' : 'numéro tarifaire'} complet ou des mots-clés et{' '}
        <b>choisissez la ligne dans la liste</b>. Le calcul se met à jour à chaque changement.
      </p>
      <ul>
        <li>Droit de base (NPF, colonne 2 ou préférence ACEUM / ALE)</li>
        <li>Sections 232, 301 (Chine et « travail forcé »), 338, 201 et autres rubriques du ch. 99</li>
        <li>Surtaxes canadiennes (É.-U., Chine), contingents et dérivés de l’acier</li>
        <li>AD/CVD et LMSI, licences et permis, interdictions</li>
        <li>MPF / HMF, TPS / TVH, régimes spéciaux (ch. 98 / 99)</li>
      </ul>
    </div>
  );
}

function Result({ r, loading, f, setChoice }: { r: CalcResult; loading: boolean; f: Form; setChoice: (p: string, c: string) => void }) {
  const cur = r.currency;
  const copy = () => {
    const txt = [
      `${r.line!.display} — ${r.line!.description}`,
      `Origine ${f.origin} · Valeur ${money(r.value, cur)} · ${r.direction === 'CA-US' ? 'INBOUND USA' : 'INBOUND CANADA'}`,
      ...r.lines.map((l) => `${l.label}${l.ch99 ? ' (' + l.ch99 + ')' : ''} : ${l.ratePct !== null && l.ratePct !== undefined ? pct(l.ratePct) : l.rateText ?? ''} → ${money(l.amount, cur)}`),
      `TOTAL : ${money(r.totals.total, cur)} (droits ${pct(r.totals.dutyPct)})`,
      ...r.flags.bans.map((x) => `INTERDICTION : ${x.title}`),
      ...r.flags.adcvd.map((x) => `AD/CVD : ${x.title}`),
      ...r.flags.licences.filter((x) => x.level !== 'info').map((x) => `Licence : ${x.agency} — ${x.title}`),
    ].join('\n');
    navigator.clipboard.writeText(txt);
  };
  const groups: [string, CalcLine['kind'][]][] = [
    ['Droits et mesures', ['base', 'additional']],
    ['Antidumping / compensateurs', ['adcvd']],
    ['Frais', ['fee']],
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
              Copier
            </button>
            <button className="btn ghost" onClick={() => window.print()}>
              Imprimer
            </button>
          </div>
        </div>
        <div className="rates">
          {r.destination === 'US' ? (
            <>
              <Rate label="Général (col. 1)" v={r.line!.general} />
              <Rate label="Spécial" v={r.line!.special} />
              <Rate label="Colonne 2" v={r.line!.other} />
            </>
          ) : (
            <>
              <Rate label="NPF" v={r.line!.general} />
              <Rate label="TÉU (UST)" v={r.line!.pref?.UST} />
              <Rate label="Tarif général" v={r.line!.other} />
            </>
          )}
          {r.line!.units && <Rate label="Unités" v={r.line!.units} />}
        </div>
      </div>

      <div className="totals">
        <Tot label="Droits et surtaxes" v={money(r.totals.duties, cur)} />
        {r.totals.adcvd > 0 && <Tot label="AD/CVD" v={money(r.totals.adcvd, cur)} />}
        <Tot label="Frais" v={money(r.totals.fees, cur)} />
        <Tot label="Taxes" v={money(r.totals.taxes, cur)} />
        <Tot label="Total à payer" v={money(r.totals.total, cur)} strong />
        <Tot label="Taux effectif (droits)" v={pct(r.totals.dutyPct)} strong />
      </div>
      {r.deferred && (
        <div className="alert info">
          <b>Régime suspensif :</b> {r.deferred.note} Garantie estimative : {money(r.deferred.bond, cur)}.
        </div>
      )}

      <div className="card">
        <table className="lines">
          <thead>
            <tr>
              <th>Mesure</th>
              <th>Rubrique / réf.</th>
              <th className="r">Taux</th>
              <th className="r">Base</th>
              <th className="r">Montant</th>
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
                        {l.status === 'à valider' && <span className="badge warn">à valider</span>}
                        {l.exempted && <span className="badge ok">exempté</span>}
                        {l.notCumulated && <span className="badge muted">non cumulé</span>}
                      </div>
                      {l.note && <div className="note">{l.note}</div>}
                      {l.alternatives && (
                        <select className="input small" value={f.ch99Choice[l.key] ?? l.ch99} onChange={(e) => setChoice(l.key, e.target.value)}>
                          <option value={l.ch99}>
                            {l.ch99} — {l.rateText} (retenue)
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
              <td colSpan={4}>Valeur débarquée estimée (valeur + droits + frais + taxes)</td>
              <td className="r b">{money(r.totals.landed, cur)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <FlagBlock title="Antidumping / compensateurs" flags={r.flags.adcvd} />
      <FlagBlock title="Licences, permis et exigences des autres ministères" flags={r.flags.licences} grouped />
      <FlagBlock title="À vérifier" flags={r.flags.warnings} />
      <FlagBlock title="Informations" flags={r.flags.info} />

      <div className="meta-line">
        Valeur convertie : {money(r.valueInput.amount, r.valueInput.currency)} → {money(r.value, cur)} (1 USD = {r.fx.usdCad.toFixed(4)} CAD, {r.fx.source}
        {r.fx.date ? `, ${r.fx.date}` : ''}) · Tarif : {r.data.source} ({fmtDate(r.data.importedAt)}) · Règles : {fmtDate(r.data.rulesLoadedAt)}
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
      {main.length === 0 && <div className="muted small">Aucune exigence particulière détectée pour ce code.</div>}
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
              {x.agency} : {x.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
