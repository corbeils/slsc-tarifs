/**
 * INBOUND EU — duties computed from the TARIC measures imported in Admin.
 * Third-country duty (103), autonomous suspensions (112), end-use relief (105/115/117/119),
 * preferences (141/142/145) and preferential/non-preferential quotas (143/146/122/123),
 * anti-dumping / countervailing (55x), additional duties (69x, safeguard, countermeasures),
 * non-tariff controls (all other types) and import VAT of the member state of destination.
 */
import type { DB, LineRow } from '../db.js';
import { countryName } from '../countries.js';
import type { Rules } from '../rules.js';
import { lang, t, tx } from '../i18n/index.js';
import { computeDuty, type ParsedRate } from './rates.js';
import { round2 } from './common.js';
import { dedupeOptions, summarize } from './us.js';
import type { AgreementInfo, CalcInput, CalcLine, CalcResult, ExemptionInfo, Flag, OptionInfo } from './types.js';

export interface EuMeasure {
  code: string;
  add_code: string;
  order_no: string;
  start: string;
  end: string;
  origin: string;
  origin_desc: string;
  type: string;
  type_desc: string;
  duty: string;
  legal: string;
}

/** TARIC units → normalized quantity keys (amount per unit of that key). */
const UNITS: Record<string, { per: string; factor: number }> = {
  DTN: { per: 'kg', factor: 100 },
  KGM: { per: 'kg', factor: 1 },
  TNE: { per: 'kg', factor: 1000 },
  GRM: { per: 'kg', factor: 0.001 },
  HLT: { per: 'liter', factor: 100 },
  LTR: { per: 'liter', factor: 1 },
  NAR: { per: 'no.', factor: 1 },
  MIL: { per: 'no.', factor: 1000 },
  NPR: { per: 'no.', factor: 1 },
  MTK: { per: 'm2', factor: 1 },
  MTQ: { per: 'm3', factor: 1 },
  MTR: { per: 'm', factor: 1 },
};

/** "6.700 % MAX 35.150 EUR DTN", "0.000 % + 3.800 EUR DTN", "12.000 %", "NIHIL" → ParsedRate. */
export function parseEuDuty(raw: string): ParsedRate {
  const s = (raw ?? '').trim();
  const out: ParsedRate = { raw: s, free: false, adValorem: 0, specific: [], complex: false, empty: !s };
  if (!s) return out;
  if (/cond|;/i.test(s)) out.complex = true;
  const main = s.split(/;|Cond:/i)[0];
  const pct = main.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
  if (pct) out.adValorem = Number(pct[1].replace(',', '.'));
  const re = /(\+|MIN|MAX)?\s*(\d+(?:[.,]\d+)?)\s*EUR\s+([A-Z]{3})(?:\s+[A-Z])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(main))) {
    const u = UNITS[m[3]];
    if (!u) {
      out.complex = true;
      continue;
    }
    const kind = m[1] === 'MIN' ? 'min' : m[1] === 'MAX' ? 'max' : 'add';
    out.specific.push({ amount: Number(m[2].replace(',', '.')) / u.factor, per: u.per, kind } as ParsedRate['specific'][number]);
  }
  if (/\+\s*(EA|EAR|ADSZ|ADFM|ADSZR|ADFMR)/.test(main)) out.complex = true;
  if (/NIHIL/i.test(main)) out.adValorem = 0;
  out.free = out.adValorem === 0 && !out.specific.length;
  return out;
}

const typeIn = (types: Record<string, string[]>, key: string, type: string) => (types[key] ?? []).includes(type);

/** Measure codes that cover a 10-digit line: chapter, heading, subheading, CN8 and the line itself. */
function coveringCodes(code: string): string[] {
  return [2, 4, 6, 8, 10].map((n) => code.slice(0, n).padEnd(10, '0'));
}

function membership(db: DB, origin: string, date: string): Set<string> {
  const rows = db
    .prepare("SELECT grp FROM eu_geo WHERE member = ? AND (start = '' OR start <= ?) AND (end = '' OR end >= ?)")
    .all(origin, date, date) as { grp: string }[];
  return new Set([origin, ...rows.map((r) => r.grp)]);
}

export function calcEU(db: DB, rules: Rules, line: LineRow, input: CalcInput, fx: { usdCad: number; eurCad: number }): Omit<CalcResult, 'data' | 'fx'> {
  const R = rules.eu;
  const T = R.measureTypes;
  const origin = input.origin.toUpperCase();
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const opts = input.options ?? {};
  const qty = input.quantities ?? {};
  const toEUR = (v: number) => (input.currency === 'EUR' ? v : input.currency === 'CAD' ? v / fx.eurCad : (v * fx.usdCad) / fx.eurCad);
  const goodsValue = round2(toEUR(input.value));
  const freight = round2(toEUR(input.freight ?? 0));
  const insurance = round2(toEUR(input.insurance ?? 0));
  const value = round2(goodsValue + freight + insurance); // customs value (CIF at the EU border)
  const inland = round2(toEUR(input.inlandFreight ?? 0));
  const ms = (input.memberState ?? 'FR').toUpperCase();

  const lines: CalcLine[] = [];
  const exemptions: ExemptionInfo[] = [];
  const options: OptionInfo[] = [];
  const flags = { bans: [] as Flag[], adcvd: [] as Flag[], licences: [] as Flag[], warnings: [] as Flag[], info: [] as Flag[] };
  const needs: CalcResult['needs'] = {};

  const all = db
    .prepare(
      `SELECT * FROM eu_measures WHERE code IN (${coveringCodes(line.code).map(() => '?').join(',')})
       AND (start = '' OR start <= ?) AND (end = '' OR end >= ?)`,
    )
    .all(...coveringCodes(line.code), date, date) as EuMeasure[];
  const groups = membership(db, origin, date);
  const excl = db.prepare(`SELECT code, type, grp, excluded FROM eu_excl WHERE code IN (${coveringCodes(line.code).map(() => '?').join(',')}) AND excluded = ?`).all(...coveringCodes(line.code), origin) as {
    code: string;
    type: string;
    grp: string;
  }[];
  const excluded = (m: EuMeasure) => excl.some((e) => e.code === m.code && e.type === m.type && e.grp === m.origin);
  const forOrigin = (m: EuMeasure) => (m.origin === '1011' || groups.has(m.origin)) && !excluded(m);
  // The most specific measure (longest significant code) wins for a given type and origin
  const depth = (c: string) => c.replace(/(00)+$/, '').length;
  const mine = all.filter(forOrigin).sort((a, b) => depth(b.code) - depth(a.code));
  const pick = (key: string) => mine.find((m) => typeIn(T, key, m.type));
  const label = (m: EuMeasure) => tx(m.type_desc) || t('TARIC measure {type}', { type: m.type });
  const originName = (m: EuMeasure) => (m.origin === '1011' ? t('All third countries (ERGA OMNES)') : m.origin_desc || countryName(m.origin, lang()));

  // ---------------- Base duty: third-country duty, unless a suspension / end-use / preference / quota is used ----------------
  const third = pick('thirdCountry');
  let base = third;
  let baseNote = third ? t('Third country duty (ERGA OMNES)') : '';
  const susp = pick('suspension');
  if (susp && parseEuDuty(susp.duty).adValorem <= parseEuDuty(third?.duty ?? '').adValorem) {
    base = susp;
    baseNote = t('Autonomous tariff suspension ({legal})', { legal: susp.legal });
  }
  for (const m of mine.filter((x) => typeIn(T, 'endUse', x.type) || typeIn(T, 'endUseSuspension', x.type))) {
    const key = `enduse:${m.type}:${m.order_no || m.code}`;
    options.push({ key, label: `${label(m)} — ${m.duty || '0 %'}`, context: t('End-use relief'), note: m.legal });
    if (opts[key]) {
      base = m;
      baseNote = t('{measure} (end-use authorisation required)', { measure: label(m) });
    }
  }
  const cu = pick('customsUnion');
  if (cu) {
    base = cu;
    baseNote = t('Customs union duty ({origin})', { origin: originName(cu) });
  }

  // ---------------- Preferences (every preference on the line, claimable when the origin belongs to it) ----------------
  const prefs = all.filter((m) => typeIn(T, 'preference', m.type));
  const agreements: AgreementInfo[] = [];
  const seenPref = new Set<string>();
  for (const m of prefs.sort((a, b) => depth(b.code) - depth(a.code))) {
    if (seenPref.has(m.origin)) continue;
    seenPref.add(m.origin);
    const a = R.agreements[m.origin];
    agreements.push({
      code: m.origin,
      name: a ? tx(a.name)! : m.origin_desc || m.origin,
      short: tx(a?.short) ?? (m.origin_desc && m.origin_desc.length < 40 ? m.origin_desc : undefined),
      rateText: m.duty || '0 %',
      applicable: forOrigin(m) ? 'yes' : 'no',
      state: 'active',
      url: a?.url,
      note: m.legal ? t('Legal base: {legal}', { legal: m.legal }) : undefined,
    });
  }
  agreements.sort((a, b) => (a.applicable === b.applicable ? a.code.localeCompare(b.code) : a.applicable === 'yes' ? -1 : 1));
  const claimable = agreements.filter((a) => a.applicable === 'yes');
  const chosen = claimable.find((a) => a.code === input.agreement) ?? claimable[0];
  const claimed = !!input.preferential && !!chosen;
  if (claimed) {
    const m = prefs.filter((x) => x.origin === chosen.code).sort((a, b) => depth(b.code) - depth(a.code))[0];
    base = m;
    baseNote = t('Preferential rate {agreement} (proof of origin required)', { agreement: chosen.short ?? chosen.name });
  }

  // ---------------- Tariff quotas ----------------
  const quotas = mine.filter((m) => typeIn(T, 'preferentialQuota', m.type) || typeIn(T, 'quota', m.type));
  const seenQ = new Set<string>();
  for (const m of quotas) {
    const order = m.order_no || m.code;
    if (seenQ.has(order)) continue;
    seenQ.add(order);
    const key = `quota:${order}`;
    options.push({
      key,
      label: t('Within tariff quota {order} — {duty} ({origin})', { order: m.order_no || '—', duty: m.duty || '0 %', origin: originName(m) }),
      context: t('Tariff quotas'),
      status: 'to verify',
      note: t('Check the remaining balance of the quota before relying on it.'),
    });
    flags.info.push({
      level: 'info',
      title: t('Tariff quota {order}: {duty}', { order: m.order_no || '—', duty: m.duty || '0 %' }),
      detail: `${label(m)} · ${originName(m)}${m.legal ? ' · ' + m.legal : ''}${typeIn(T, 'preferentialQuota', m.type) ? ' · ' + t('proof of origin required') : ''}`,
      url: 'https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-customs/tariff-quota-database-quota_en',
    });
    if (opts[key]) {
      base = m;
      baseNote = t('Within tariff quota {order}', { order: m.order_no || '—' });
    }
  }

  const parsed = parseEuDuty(base?.duty ?? '');
  const bd = computeDuty(parsed, value, qty);
  if (bd.missingQuantity.length) needs.quantityUnits = bd.missingQuantity;
  if (parsed.complex)
    flags.warnings.push({ level: 'warning', title: t('Complex duty expression'), detail: t('"{raw}" — conditions or agricultural components apply; verify manually.', { raw: parsed.raw }) });
  if (!base)
    flags.warnings.push({ level: 'warning', title: t('No third country duty found'), detail: t('Check that the TARIC measures file has been imported in Admin.') });
  lines.push({
    key: 'base',
    label: t('Customs duty'),
    program: 'TARIC',
    legal: base?.legal,
    rateText: parsed.raw || '—',
    ratePct: parsed.specific.length ? null : parsed.adValorem,
    basis: value,
    amount: round2(bd.amount),
    kind: 'base',
    status: 'verified',
    note: [baseNote, base && base.code !== line.code ? t('measure set at {code}', { code: base.code }) : ''].filter(Boolean).join(' · '),
  });

  // ---------------- Additional duties (safeguard, countermeasures…) ----------------
  // Steel out-of-quota duty: recognised by its legal base, even under a TARIC type not listed in measureTypes.
  const OQ = R.outOfQuota;
  const known = new Set(Object.values(T).flat());
  const isOutOfQuota = (m: { legal: string }) => !!OQ && OQ.legal.some((l) => m.legal.replace(/\s/g, '').includes(l));
  const quotaTicked = quotas.some((q) => isOutOfQuota(q) && opts[`quota:${q.order_no || q.code}`]);
  for (const m of mine.filter((x) => typeIn(T, 'additional', x.type) || (!known.has(x.type) && isOutOfQuota(x)))) {
    const p = parseEuDuty(m.duty);
    const d = computeDuty(p, value, qty);
    if (isOutOfQuota(m)) {
      lines.push({
        key: `add:${m.type}:${m.origin}:${m.add_code}:${m.order_no}`,
        label: t(OQ!.label),
        program: m.type,
        legal: m.legal,
        rateText: m.duty,
        ratePct: p.specific.length ? null : p.adValorem,
        basis: value,
        amount: quotaTicked ? 0 : round2(d.amount),
        exempted: quotaTicked,
        kind: 'additional',
        status: 'to verify',
        note: [originName(m), quotaTicked ? t('Within the tariff quota: not due') : OQ!.note ? t(OQ!.note) : ''].filter(Boolean).join(' · '),
      });
      continue;
    }
    if (d.missingQuantity.length) needs.quantityUnits = [...new Set([...(needs.quantityUnits ?? []), ...d.missingQuantity])];
    lines.push({
      key: `add:${m.type}:${m.origin}:${m.add_code}:${m.order_no}`,
      label: label(m),
      program: m.type,
      legal: m.legal,
      rateText: m.duty,
      ratePct: p.specific.length ? null : p.adValorem,
      basis: value,
      amount: round2(d.amount),
      kind: 'additional',
      status: p.complex ? 'to verify' : 'verified',
      note: [originName(m), m.add_code ? t('additional code {code}', { code: m.add_code }) : '', m.order_no ? t('quota {order}', { order: m.order_no }) : ''].filter(Boolean).join(' · '),
    });
  }

  // ---------------- Anti-dumping / countervailing ----------------
  const ad = mine.filter((x) => typeIn(T, 'antiDumping', x.type));
  const byCase = new Map<string, EuMeasure[]>();
  for (const m of ad) byCase.set(`${m.type}|${m.legal}|${m.origin}`, [...(byCase.get(`${m.type}|${m.legal}|${m.origin}`) ?? []), m]);
  const addDesc = db.prepare('SELECT description FROM eu_addcodes WHERE code = ?');
  for (const list of byCase.values()) {
    const m0 = list[0];
    const companies = list.filter((m) => m.add_code);
    const others =
      list.find((m) => !m.add_code) ??
      companies.find((m) => /all other|other compan|autres soci/i.test((addDesc.get(m.add_code) as { description: string } | undefined)?.description ?? '')) ??
      companies.find((m) => /999$/.test(m.add_code)) ??
      [...list].sort((a, b) => parseEuDuty(b.duty).adValorem - parseEuDuty(a.duty).adValorem)[0];
    const chosenAd = companies.find((m) => m.add_code === input.adcvdCompany) ?? others;
    flags.adcvd.push({
      level: 'danger',
      title: `${label(m0)} — ${originName(m0)}`,
      detail:
        t('{legal} · "all other companies" rate: {duty}', { legal: m0.legal, duty: others.duty }) +
        (companies.length > 1 ? ' · ' + t('{n} company-specific rates (TARIC additional codes)', { n: companies.length }) : ''),
      url: `https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp?Lang=en&Taric=${line.code}&GoodsText=&Area=${origin}`,
    });
    if (input.includeAdcvd) {
      const p = parseEuDuty(chosenAd.duty);
      const d = computeDuty(p, value, qty);
      const desc = chosenAd.add_code ? (addDesc.get(chosenAd.add_code) as { description: string } | undefined)?.description : undefined;
      lines.push({
        key: `ad:${m0.type}:${m0.legal}`,
        label: label(m0),
        program: 'AD/CVD',
        legal: m0.legal,
        rateText: chosenAd.duty,
        ratePct: p.specific.length ? null : p.adValorem,
        basis: value,
        amount: round2(d.amount),
        kind: 'adcvd',
        status: 'verified',
        note: [originName(m0), chosenAd.add_code ? `${chosenAd.add_code}${desc ? ' — ' + desc : ''}` : t('all other companies')].join(' · '),
      });
    }
  }

  // ---------------- Non-tariff measures (controls, licences, prohibitions, surveillance) ----------------
  const handled = new Set(Object.values(T).flat());
  const seenCtl = new Set<string>();
  for (const m of mine.filter((x) => !handled.has(x.type))) {
    const k = `${m.type}|${m.origin}|${m.legal}`;
    if (seenCtl.has(k)) continue;
    seenCtl.add(k);
    const ban = /prohibit|restriction on entry|import ban|embargo/i.test(m.type_desc);
    const f: Flag = {
      level: ban ? 'danger' : 'warning',
      title: label(m),
      agency: originName(m),
      detail: [m.legal, m.duty ? t('condition: {c}', { c: m.duty }) : ''].filter(Boolean).join(' · '),
    };
    (ban ? flags.bans : flags.licences).push(f);
  }

  // ---------------- Import VAT of the member state ----------------
  const dutiesSoFar = lines.reduce((a, l) => a + l.amount, 0);
  const vatBase = round2(value + dutiesSoFar + inland);
  const vat = R.vat[ms];
  if (vat !== undefined)
    lines.push({
      key: 'vat',
      label: t('Import VAT ({country})', { country: countryName(ms, lang()) }),
      ratePct: vat,
      basis: vatBase,
      amount: round2((vat / 100) * vatBase),
      kind: 'tax',
      status: 'verified',
      note: tx(R.vatNote),
    });

  if (claimable.length && !input.preferential)
    flags.info.push({
      level: 'success',
      title: t('{agreement} preference available', { agreement: claimable[0].short ?? claimable[0].name }),
      detail: t('Rate: {rate}. Tick the agreement if the goods are originating (statement on origin / proof of origin required).', { rate: claimable[0].rateText }),
    });
  if (freight === 0 && insurance === 0)
    flags.info.push({
      level: 'info',
      title: t('Customs value = CIF'),
      detail: t('EU duties are calculated on the value at the EU border: enter the international freight and insurance to include them.'),
    });

  const totals = summarize(lines, value);
  return {
    ok: true,
    direction: input.direction,
    destination: 'EU',
    currency: 'EUR',
    value,
    valueInput: { amount: input.value, currency: input.currency },
    dutiableValue: value,
    lines,
    totals,
    preferential: { eligible: claimable.length > 0, program: chosen?.code, rateText: chosen?.rateText, claimed, label: chosen?.short ?? chosen?.name ?? '' },
    agreements,
    lineUrl: `https://ec.europa.eu/taxation_customs/dds2/taric/taric_consultation.jsp?Lang=en&Taric=${line.code}&Area=${origin}`,
    exemptions: [],
    options: dedupeOptions(options),
    needs,
    flags,
    regimes: [{ id: 'none', label: t('Ordinary import') }],
  };
}

