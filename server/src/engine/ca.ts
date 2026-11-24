import { t } from '../i18n/index.js';
import type { DB, LineRow } from '../db.js';
import { countryName, EU27, matchesOrigin } from '../countries.js';
import type { Measure, Rules } from '../rules.js';
import { computeDuty, parseRate } from './rates.js';
import { adcvdFlags, inDate, licenceFlags, originAllowed, round2, scopeMatch } from './common.js';
import { dedupe, dedupeOptions, summarize } from './us.js';
import { agreementFor, listAgreements, pickAgreement } from './agreements.js';
import type { CalcInput, CalcLine, CalcResult, ExemptionInfo, Flag, OptionInfo } from './types.js';

const GENERAL_TARIFF_COUNTRIES = ['KP'];

export function calcCA(db: DB, rules: Rules, line: LineRow, input: CalcInput, fx: number): Omit<CalcResult, 'data' | 'fx'> {
  const R = rules.ca;
  const origin = input.origin.toUpperCase();
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const opts = input.options ?? {};
  const toCAD = (v: number) => (input.currency === 'USD' ? v * fx : v);
  const value = round2(toCAD(input.value));
  const regime = R.regimes.find((r) => r.id === (input.regime ?? 'none')) ?? R.regimes[0];
  const eff = regime?.effect ?? {};
  const repairValue = input.repairValue !== undefined ? round2(toCAD(input.repairValue)) : undefined;

  const lines: CalcLine[] = [];
  const exemptions: ExemptionInfo[] = [];
  const options: OptionInfo[] = [];
  const flags = { bans: [] as Flag[], adcvd: [] as Flag[], licences: [] as Flag[], warnings: [] as Flag[], info: [] as Flag[] };
  const needs: CalcResult['needs'] = {};
  if (eff.gstOnRepairValue) needs.repairValue = true;

  // ---------------- Traitement tarifaire ----------------
  const pref: Record<string, string> = line.pref_json ? JSON.parse(line.pref_json) : {};
  const key = EU27.includes(origin) ? 'EU' : origin;
  const treatments = R.preferential[key] ?? [];
  const prefRates = Object.fromEntries(Object.entries(pref).filter(([, v]) => v !== undefined && v !== ''));
  const agreements = GENERAL_TARIFF_COUNTRIES.includes(origin) ? [] : listAgreements(R.agreements, prefRates, origin);
  const picked = pickAgreement(agreements, input.agreement);
  const prefCode = picked?.code ?? treatments.find((t) => pref[t] !== undefined && pref[t] !== '');
  const prefEligible = !!prefCode;
  const claimed = !!input.preferential && prefEligible;
  const prefAgreement = prefCode ? agreementFor(R.agreements, prefCode) : undefined;
  const isCusma = !!prefCode && ['UST', 'MXT', 'MUST'].includes(prefCode);
  const prefLabel = isCusma ? t('CUSMA') : prefAgreement?.short ?? prefAgreement?.name ?? t('Free trade agreement');

  let baseText: string;
  let baseNote: string;
  if (GENERAL_TARIFF_COUNTRIES.includes(origin)) {
    baseText = line.other ?? '35%';
    baseNote = t('General Tariff');
  } else if (claimed) {
    baseText = pref[prefCode!];
    baseNote = t('{code} treatment ({pref})', { code: prefCode, pref: prefLabel });
  } else {
    baseText = line.general ?? '';
    baseNote = t('Most-Favoured-Nation Tariff (MFN)');
  }
  if (eff.baseFree) {
    baseText = 'Free';
    baseNote = t('Regime {code} — {label}', { code: regime.code, label: regime.label });
  }
  const parsed = parseRate(baseText);
  const base = computeDuty(parsed, value, input.quantities ?? {});
  if (base.missingQuantity.length) needs.quantityUnits = base.missingQuantity;
  if (parsed.complex)
    flags.warnings.push({ level: 'warning', title: t('Complex base rate'), detail: t('"{raw}" — verify manually.', { raw: parsed.raw }) });
  lines.push({
    key: 'base',
    label: t('Customs duty'),
    program: 'Customs Tariff',
    rateText: parsed.raw || '—',
    ratePct: parsed.specific.length ? null : parsed.adValorem,
    basis: value,
    amount: round2(base.amount),
    kind: 'base',
    status: 'verified',
    note: baseNote,
  });

  // ---------------- Surtaxes et mesures ----------------
  const skipAdditional = origin === 'CA' || !!eff.skipAdditional;
  type Cand = { m: Measure; via: string; rate: number; partial: boolean };
  const cands: Cand[] = [];
  if (!skipAdditional) {
    for (const m of R.measures) {
      if (!inDate(m, date)) continue;
      if (!originAllowed(m, origin)) continue;
      const sm = scopeMatch(db, m, line);
      if (!sm.matched) continue;
      if (m.requiresOption) {
        options.push({ key: m.requiresOption, label: optionLabel(m.requiresOption), context: m.name, status: m.status });
        if (!opts[m.requiresOption]) continue;
      }
      cands.push({ m, via: sm.via, rate: sm.rateOverride ?? m.rate ?? 0, partial: sm.partial });
    }
  }
  const matchedIds = new Set(cands.map((c) => c.m.id));

  type Computed = { c: Cand; amount: number; basis: number; exempt: { label: string } | null; notes: string[] };
  const computed: Computed[] = [];
  for (const c of cands) {
    const m = c.m;
    let exempt: { label: string } | null = null;
    for (const e of m.exemptIf ?? []) {
      if (e.option) {
        options.push({ key: e.option, label: e.label, context: m.name });
        exemptions.push({ id: `${m.id}:${e.option}`, label: e.label, applied: !!opts[e.option], kind: 'option', option: e.option, program: m.name });
        if (opts[e.option]) exempt ??= e;
        continue;
      }
      let ok = false;
      if (e.preferential) ok = claimed;
      else if (e.families) ok = e.families.some((f) => matchedIds.has(f));
      if (ok) {
        exempt ??= e;
        exemptions.push({ id: `${m.id}:${e.label}`, label: e.label, applied: true, kind: 'auto', program: m.name });
      }
    }
    let basis = value;
    const notes: string[] = [];
    if (m.preferentialBasis === 'nonCaMxContent' && claimed && isCusma) {
      needs.caMxContent = true;
      const pct = input.caMxContentPct ?? 0;
      basis = value * (1 - pct / 100);
      notes.push(t('CUSMA: on non-Canadian, non-Mexican content ({pct}%)', { pct: round2(100 - pct) }));
    }
    if (c.partial) notes.push(t('The list covers only some subdivisions: specify the 10-digit number'));
    notes.push(t('Scope: {via}', { via: c.via }));
    computed.push({ c, amount: exempt ? 0 : (c.rate / 100) * basis, basis, exempt, notes });
  }

  // Groupes non cumulatifs : on retient le montant le plus élevé
  const winners = new Set<Computed>();
  const groups = new Map<string, Computed[]>();
  for (const x of computed) {
    const g = x.c.m.group;
    if (!g) winners.add(x);
    else groups.set(g, [...(groups.get(g) ?? []), x]);
  }
  for (const list of groups.values()) {
    const best = [...list].sort((a, b) => b.amount - a.amount || (b.c.m.priority ?? 0) - (a.c.m.priority ?? 0))[0];
    winners.add(best);
  }
  for (const x of computed) {
    const nc = !winners.has(x);
    lines.push({
      key: x.c.m.id,
      label: x.c.m.name,
      program: x.c.m.program,
      legal: x.c.m.legal,
      url: x.c.m.url,
      ratePct: x.exempt || nc ? 0 : x.c.rate,
      basis: round2(x.basis),
      amount: nc ? 0 : round2(x.amount),
      kind: 'additional',
      status: x.c.m.status,
      exempted: !!x.exempt,
      notCumulated: nc,
      note: [
        x.exempt ? t('Remission / exemption: {label}', { label: x.exempt.label }) : '',
        nc ? t('Not cumulative — another measure in the same group applies (highest amount retained)') : '',
        ...x.notes,
        x.c.m.note ?? '',
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }

  // ---------------- LMSI (SIMA) ----------------
  for (const { flag } of adcvdFlags(rules.adcvd.ca.cases, line.code, origin)) {
    flags.adcvd.push({
      ...flag,
      title: t('SIMA {title}', { title: flag.title }),
      detail: t('Possible anti-dumping/countervailing duties (normal values are exporter-specific). Check the product definition of the measure in force.'),
      url: rules.adcvd.ca.searchUrl,
    });
  }

  // ---------------- Licences / autres ministères ----------------
  flags.licences = licenceFlags(null, rules.licences.ca, line.code, origin, 'CA');

  // ---------------- TPS / TVH ----------------
  const dutiesSoFar = lines.reduce((a, l) => a + l.amount, 0);
  const taxBase = (eff.gstOnRepairValue ? repairValue ?? 0 : value) + (eff.gstOnRepairValue ? 0 : dutiesSoFar);
  const prov = (input.province ?? 'QC').toUpperCase();
  const hst = R.taxes.hst[prov];
  if (hst !== undefined) {
    lines.push({
      key: 'hst',
      label: t('HST ({prov})', { prov }),
      ratePct: hst,
      basis: round2(taxBase),
      amount: round2((hst / 100) * taxBase),
      kind: 'tax',
      status: 'verified',
      note: t('Base: value for duty + duties + surtaxes. Recoverable as an input tax credit by registrants.'),
    });
  } else {
    lines.push({
      key: 'gst',
      label: R.taxes.gst.label,
      ratePct: R.taxes.gst.pct,
      basis: round2(taxBase),
      amount: round2((R.taxes.gst.pct / 100) * taxBase),
      kind: 'tax',
      status: R.taxes.gst.status,
      note: t('Base: value for duty + duties + surtaxes. Recoverable as an input tax credit by registrants.') + (prov === 'QC' ? t(' QST is not collected at the border.') : ''),
    });
  }

  if (prefEligible && !input.preferential)
    flags.info.push({
      level: 'success',
      title: t('Eligible for {code} treatment ({pref})', { code: prefCode, pref: prefLabel }),
      detail: t('Rate: {rate}. Tick "Claim" if the goods are originating (proof of origin required).', { rate: pref[prefCode!] }),
    });
  if (origin === 'US' && !prefEligible)
    flags.info.push({ level: 'info', title: t('No UST rate found for this line'), detail: t('Check the imported tariff file.') });
  if (regime.id !== 'none' && regime.note)
    flags.info.push({ level: 'info', title: t('Regime {code} — {label}', { code: regime.code ?? '', label: regime.label }), detail: regime.note });
  if (!skipAdditional && origin === 'US')
    flags.info.push({
      level: 'info',
      title: t('Canadian surtaxes: official lists'),
      detail: t('Surtaxes apply by tariff item. Until a list is imported, matching uses indicative prefixes (flagged as such).'),
    });

  const totals = summarize(lines, value);
  return {
    ok: true,
    direction: input.direction,
    destination: 'CA',
    currency: 'CAD',
    value,
    valueInput: { amount: input.value, currency: input.currency },
    dutiableValue: value,
    lines,
    totals,
    preferential: { eligible: prefEligible, program: prefCode, rateText: prefCode ? pref[prefCode] : undefined, claimed, label: prefLabel },
    agreements,
    exemptions: dedupe(exemptions),
    options: dedupeOptions(options),
    needs,
    flags,
    regimes: R.regimes.map((r) => ({ id: r.id, label: r.label, code: r.code })),
    deferred: eff.deferred ? { bond: round2(totals.duties), note: regime.note ?? '' } : undefined,
  };
}

function optionLabel(k: string): string {
  const m: Record<string, string> = {
    overQuota: 'Over-quota import (quarterly TRQ exhausted for the country)',
    chinaMeltedSteel: 'Contains steel melted and poured in China',
  };
  return m[k] ? t(m[k]) : k;
}

export { countryName, matchesOrigin };
