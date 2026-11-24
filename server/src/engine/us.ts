import type { DB, LineRow } from '../db.js';
import { digits } from '../db.js';
import { countryName, matchesOrigin } from '../countries.js';
import type { Program, Rules } from '../rules.js';
import { computeDuty, parseRate, parseUsSpecial } from './rates.js';
import {
  countList,
  codeListMatch,
  adcvdFlags,
  anyPrefix,
  euKey,
  getCh99,
  inDate,
  licenceFlags,
  lineRefs,
  originAllowed,
  round2,
  scopeMatch,
} from './common.js';
import { lang, t } from '../i18n/index.js';
import type { CalcInput, CalcLine, CalcResult, ExemptionInfo, Flag, OptionInfo } from './types.js';

interface Heading {
  code: string;
  priority?: number;
  listId?: string;
  via?: string;
  capCombinedPct?: number;
  label: string;
  description: string;
  addPct: number | null;
  kind: 'duty' | 'exemption' | 'ban' | 'other';
  origins: string[] | null;
  excludeOrigins: string[] | null;
  option?: string;
  exemptIfFamilies?: string[];
  exemptionCh99?: string;
}

function resolveHeading(db: DB, program: Program, code: string): Heading {
  const row = getCh99(db, code);
  const ov = program.headings?.[code] ?? {};
  const countries = row?.countries ? (JSON.parse(row.countries) as string[]) : [];
  const except = row?.except_countries ? (JSON.parse(row.except_countries) as string[]) : [];
  const kind = (ov.kind ?? row?.kind ?? 'other') as Heading['kind'];
  return {
    code,
    label: ov.label ?? (row ? shorten(row.description) : t('Heading {code}', { code })),
    description: row?.description ?? '',
    addPct: ov.rate ?? row?.add_pct ?? null,
    kind: kind === 'other' && (ov.rate ?? row?.add_pct ?? 0) > 0 ? 'duty' : kind,
    origins: ov.origins ?? (countries.length ? countries : program.defaultOrigins ?? null),
    excludeOrigins: ov.excludeOrigins ?? (except.length ? except : null),
    option: ov.option,
    exemptIfFamilies: ov.exemptIfFamilies,
    exemptionCh99: ov.exemptionCh99,
  };
}

function shorten(s: string, n = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function programMatchesRef(db: DB, p: Program, ref: string): boolean {
  if (p.prefixes?.some((pre) => ref.startsWith(pre))) return true;
  if (p.descriptionRegex) {
    const row = getCh99(db, ref);
    if (row && new RegExp(p.descriptionRegex, 'i').test(row.description)) return true;
  }
  return false;
}

export function calcUS(db: DB, rules: Rules, line: LineRow, input: CalcInput, fx: number): Omit<CalcResult, 'data' | 'fx'> {
  const R = rules.us;
  const origin = input.origin.toUpperCase();
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const opts = input.options ?? {};
  const qty = input.quantities ?? {};
  const toUSD = (v: number) => (input.currency === 'CAD' ? v / fx : v);
  const value = round2(toUSD(input.value));
  const regime = R.regimes.find((r) => r.id === (input.regime ?? 'none')) ?? R.regimes[0];
  const eff = regime?.effect ?? {};
  const repairValue = input.repairValue !== undefined ? round2(toUSD(input.repairValue)) : undefined;
  const dutiable = eff.onRepairValue ? repairValue ?? 0 : value;

  const lines: CalcLine[] = [];
  const exemptions: ExemptionInfo[] = [];
  const options: OptionInfo[] = [];
  const flags = { bans: [] as Flag[], adcvd: [] as Flag[], licences: [] as Flag[], warnings: [] as Flag[], info: [] as Flag[] };
  const needs: CalcResult['needs'] = {};
  if (eff.onRepairValue) needs.repairValue = true;

  // ---------------- Droit de base ----------------
  const column2 = R.column2Countries.includes(origin);
  const special = parseUsSpecial(line.special);
  const progCodes = R.preferentialPrograms[origin] ?? [];
  const prefCode = progCodes.find((c) => special[c] !== undefined);
  const isNA = origin === 'CA' || origin === 'MX';
  // Canada/Mexique : l'origine ACEUM se réclame même sans indicateur S/S+ (taux général déjà « Free »,
  // exemption 301 et MPF) — cf. 9903.05.93.
  const prefEligible = (!!prefCode || isNA) && !column2;
  const claimed = !!input.preferential && prefEligible;
  const prefLabel = isNA ? t('USMCA') : t('Free trade agreement');

  let baseText = column2 ? line.other ?? '' : claimed && prefCode ? special[prefCode] : line.general ?? '';
  let baseNote = column2
    ? t('Column 2 ({country})', { country: countryName(origin, lang()) })
    : claimed && prefCode
      ? t('{pref} preferential rate (SPI {spi})', { pref: prefLabel, spi: prefCode })
      : claimed
        ? t('Column 1 — General ({pref} origin claimed)', { pref: prefLabel })
        : t('Column 1 — General (MFN)');
  if (eff.baseFree || (eff.freeIfPreferential?.includes(origin) && input.preferential)) {
    baseText = 'Free';
    baseNote = t('Regime {code} — {label}', { code: regime.code, label: regime.label });
  }
  const parsed = parseRate(baseText);
  const base = computeDuty(parsed, dutiable, qty);
  if (base.missingQuantity.length) needs.quantityUnits = base.missingQuantity;
  if (parsed.complex)
    flags.warnings.push({
      level: 'warning',
      title: t('Complex base rate'),
      detail: t('"{raw}" could not be fully interpreted; verify manually.', { raw: parsed.raw }),
    });
  lines.push({
    key: 'base',
    label: t('Base customs duty'),
    program: 'HTSUS',
    rateText: parsed.raw || '—',
    ratePct: parsed.specific.length ? null : parsed.adValorem,
    basis: dutiable,
    amount: round2(base.amount),
    kind: 'base',
    status: 'verified',
    note: baseNote + (line.rate_from && line.rate_from !== line.code ? t(' · rate from line {line}', { line: fmt(line.rate_from) }) : ''),
  });
  const basePct = base.effectivePct;

  // Les droits additionnels du ch. 99 visent les produits étrangers
  const skipAdditional = origin === 'US' || !!eff.skipAdditional;
  if (origin === 'US' && !eff.skipAdditional)
    flags.info.push({
      level: 'info',
      title: t('U.S. origin'),
      detail: t('U.S.-origin goods returned: consider 9801.00.10 (no Chapter 99 additional duties).'),
    });

  const appliedFamilies = new Set<string>();
  const appliedPrograms = new Set<string>();
  const consumed = new Set<string>();
  const refs = lineRefs(line);

  if (!skipAdditional) {
    // ---------------- Programmes liés au ch. 99 ----------------
    for (const p of R.programs) {
      const mine = refs.filter((r) => !consumed.has(r) && programMatchesRef(db, p, r));
      mine.forEach((r) => consumed.add(r));
      const heads = mine.map((r) => resolveHeading(db, p, r));
      // Removal lists (e.g. Annex II): official list only
      const removed = (p.lists ?? []).find((l) => l.exclusion && codeListMatch(db, l.id, line.code).matched && !codeListMatch(db, l.id, line.code).partial);
      if (removed) {
        flags.info.push({ level: 'success', title: t('{name}: not applicable', { name: p.name }), detail: t('Listed in {list}.', { list: removed.label }) });
        continue;
      }
      // Annex / list coverage (official list imported in Admin, else indicative prefixes)
      for (const l of p.lists ?? []) {
        if (l.exclusion) continue;
        if (l.exclude && anyPrefix(line.code, l.exclude)) continue;
        const cl = codeListMatch(db, l.id, line.code);
        const hasList = countList(db, l.id) > 0;
        let via = '';
        if (cl.matched) via = cl.partial ? t('official list (some subdivisions only)') : t('official list');
        else if (!hasList && anyPrefix(line.code, l.prefixes)) via = INDICATIVE();
        if (!via) continue;
        if (heads.some((h) => h.code === (l.ch99 ?? l.id))) continue;
        heads.push({
          code: l.ch99 ?? l.id,
          listId: l.id,
          via,
          label: l.label,
          description: l.label,
          addPct: cl.rate ?? l.rate,
          kind: 'duty',
          origins: l.origins ?? p.defaultOrigins ?? null,
          excludeOrigins: null,
          capCombinedPct: l.capCombinedPct,
          priority: l.priority ?? 0,
        });
      }
      if (!heads.length) continue;
      const duty = heads.filter(
        (h) =>
          h.kind === 'duty' &&
          (h.origins === null || matchesOrigin(origin, h.origins)) &&
          !(h.excludeOrigins && matchesOrigin(origin, h.excludeOrigins)),
      );
      const exHeads = heads.filter((h) => h.kind === 'exemption');
      for (const b of heads.filter((h) => h.kind === 'ban' && (h.origins === null || matchesOrigin(origin, h.origins))))
        flags.bans.push({ level: 'danger', title: `${b.code} — ${b.label}`, detail: t('Importation prohibited.') });
      if (!duty.length) continue;

      if (p.family === 's232' && appliedFamilies.has('s232')) {
        flags.info.push({
          level: 'info',
          title: t('{name}: not stacked', { name: p.name }),
          detail: t('Only one Section 232 program applies per article (priority: autos > trucks > metals > wood).'),
        });
        continue;
      }
      const choice = input.ch99Choice?.[p.id];
      const sorted = [...duty].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.addPct ?? 0) - (a.addPct ?? 0));
      const chosen = sorted.find((h) => h.code === choice) ?? sorted[0];
      const alternatives = sorted
        .filter((h) => h !== chosen)
        .map((h) => ({ ch99: h.code, label: h.label, ratePct: h.addPct }));

      let exempt: { label: string; ch99?: string } | null = null;
      if (chosen.exemptIfFamilies?.some((f) => appliedFamilies.has(f)))
        exempt = { label: t('Already subject to an exclusive program'), ch99: chosen.exemptionCh99 };
      for (const eh of exHeads) {
        if (eh.option) {
          options.push({ key: eh.option, label: `${eh.label} (${eh.code})`, context: p.name });
          const applied = !!opts[eh.option];
          exemptions.push({ id: `${p.id}:${eh.code}`, label: eh.label, ch99: eh.code, applied, kind: 'option', option: eh.option, program: p.name });
          if (applied) exempt = { label: eh.label, ch99: eh.code };
        } else if (!p.headings?.[eh.code]?.kind) {
          const applied = !!input.claimExemptions?.includes(eh.code);
          exemptions.push({ id: `${p.id}:${eh.code}`, label: eh.label, ch99: eh.code, applied, kind: 'claim', program: p.name });
          if (applied) exempt = { label: eh.label, ch99: eh.code };
        }
      }

      let rate = chosen.addPct ?? 0;
      let basis = dutiable;
      let floor = 0;
      let cap: number | undefined = chosen.capCombinedPct;
      const notes: string[] = [];
      if (chosen.via) notes.push(t('Scope: {via}', { via: chosen.via }));
      if (cap !== undefined) notes.push(t('Listed in {list}: base duty + 232 capped at {cap}% combined', { list: chosen.label, cap }));

      if (p.lowMetalExemptPct !== undefined) {
        needs.metalWeight = true;
        if (input.metalWeightPct !== undefined && input.metalWeightPct < p.lowMetalExemptPct)
          exempt = { label: t('Metal content < {pct}% by weight', { pct: p.lowMetalExemptPct }) };
      }
      const naOrigin = origin === 'CA' || origin === 'MX';
      if (p.preferential && naOrigin) {
        if (p.preferential.partsExemptOption) {
          options.push({ key: p.preferential.partsExemptOption, label: t('USMCA-qualifying auto part (exempt)'), context: p.name });
          if (opts[p.preferential.partsExemptOption] && claimed) exempt = { label: t('USMCA-qualifying part') };
        }
        if (p.preferential.mode === 'nonUsContent' && claimed && !exempt) {
          needs.usContent = true;
          const us = input.usContentPct ?? 0;
          basis = dutiable * (1 - us / 100);
          notes.push(t('USMCA: on non-U.S. content ({pct}% of value)', { pct: round2(100 - us) }));
        }
      }
      const disabled = new Set(Object.entries(p.options ?? {}).flatMap(([k, o]) => (opts[k] ? o.disables ?? [] : [])));
      let override: { rate: number; label: string } | null = null;
      for (const [key, o] of Object.entries(p.options ?? {})) {
        options.push({ key, label: o.label, context: p.name, status: o.status, note: o.note });
        if (!opts[key]) continue;
        if (disabled.has(key)) {
          notes.push(t('"{option}" not applicable ({reason})', { option: o.label, reason: Object.entries(p.options ?? {}).find(([k, x]) => opts[k] && x.disables?.includes(key))?.[1].label }));
          continue;
        }
        if (o.warning) flags.warnings.push({ level: 'warning', title: o.label, detail: o.warning });
        if (o.rate !== undefined) {
          override = { rate: o.rate, label: o.label };
          continue;
        }
        if (o.capCombinedPct !== undefined) {
          cap = o.capCombinedPct;
          notes.push(t('Base duty + 232 capped at {cap}% combined', { cap }));
        }
        if (o.nonUsContentRate !== undefined) {
          if (claimed && naOrigin) {
            needs.usContent = true;
            rate = o.nonUsContentRate;
            basis = dutiable * (1 - (input.usContentPct ?? 0) / 100);
            floor = o.floorPct ?? 0;
            notes.push(t('{rate}% on non-U.S. content, {floor}% floor', { rate, floor }));
          } else notes.push(t('USMCA 232 option ignored: USMCA not claimed or origin outside Canada/Mexico'));
        }
      }

      if (override) {
        rate = override.rate;
        basis = dutiable;
        floor = 0;
        cap = undefined;
        notes.unshift(t('{label}: {rate}% on the full value', { label: override.label, rate: override.rate }));
      }
      let amount = (rate / 100) * basis;
      if (floor) amount = Math.max(amount, (floor / 100) * dutiable);
      let ratePct: number | null = rate;
      if (cap !== undefined) {
        ratePct = Math.max(0, cap - basePct);
        amount = (ratePct / 100) * dutiable;
      }
      if (exempt) amount = 0;
      if (exempt) exemptions.push({ id: `${p.id}:auto`, label: exempt.label, ch99: exempt.ch99, applied: true, kind: 'auto', program: p.name });

      lines.push({
        key: p.id,
        label: p.name,
        program: p.family.toUpperCase(),
        ch99: exempt?.ch99 ?? (chosen.listId && !/^99/.test(chosen.code) ? undefined : chosen.code),
        ratePct: exempt ? 0 : round2(ratePct ?? 0),
        rateText: chosen.label,
        status: chosen.via === INDICATIVE() ? 'to verify' : p.status,
        basis: round2(basis),
        amount: round2(amount),
        kind: 'additional',
        url: p.url,
        exempted: !!exempt,
        note: [exempt ? t('Exempt: {label}', { label: exempt.label }) : '', ...notes, p.note ?? ''].filter(Boolean).join(' · '),
        alternatives: alternatives.length ? alternatives : undefined,
      });
      if (!exempt) {
        appliedFamilies.add(p.family);
        appliedPrograms.add(p.id);
      }
    }

    // Renvois non cartographiés
    for (const r of refs) {
      if (consumed.has(r) || r.startsWith('9903.05') || !r.startsWith('9903')) continue;
      const row = getCh99(db, r);
      if (!row || row.kind !== 'duty' || !row.add_pct) continue;
      const countries = row.countries ? (JSON.parse(row.countries) as string[]) : [];
      if (countries.length && matchesOrigin(origin, countries)) {
        const amount = (row.add_pct / 100) * dutiable;
        lines.push({
          key: `ch99:${r}`,
          label: t('Chapter 99 measure (unmapped)'),
          ch99: r,
          ratePct: row.add_pct,
          rateText: shorten(row.description),
          basis: dutiable,
          amount: round2(amount),
          kind: 'additional',
          status: 'to verify',
          note: t('Add a program in rules/us.yaml to define exclusions and stacking.'),
        });
      } else if (!countries.length) {
        flags.warnings.push({
          level: 'warning',
          title: t('Reference {ref} (+{pct}%) to verify', { ref: r, pct: row.add_pct }),
          detail: shorten(row.description, 260),
        });
      }
    }

    // ---------------- Mesures par origine ----------------
    for (const m of R.measures) {
      if (!inDate(m, date)) continue;
      if (!originAllowed(m, origin)) continue;
      const sm = scopeMatch(db, m, line);
      if (!sm.matched) continue;
      if (m.kind === 'ban') {
        flags.bans.push({
          level: 'danger',
          title: m.name,
          detail: `${m.note ?? ''} ${sm.partial ? t('(some subdivisions only)') : ''}`.trim(),
          url: m.url,
        });
        continue;
      }
      let rate: number | undefined;
      let ch99 = m.originCh99?.[origin];
      if (m.autoFromCh99Range) {
        const rows = db
          .prepare("SELECT * FROM ch99 WHERE code >= ? AND code <= ? AND kind = 'duty'")
          .all(m.autoFromCh99Range[0], m.autoFromCh99Range[1]) as import('../db.js').Ch99Row[];
        const hit = rows.find((r) => r.countries && matchesOrigin(origin, JSON.parse(r.countries)));
        if (hit && hit.add_pct !== null) {
          rate = hit.add_pct;
          ch99 = hit.code;
        }
      }
      rate ??= m.originRates?.[origin] ?? m.originRates?.[euKey(origin)] ?? sm.rateOverride ?? m.rate;
      if (rate === undefined) continue;
      const cap = m.originCaps?.[origin] ?? m.originCaps?.[euKey(origin)];

      let exempt: { label: string; ch99?: string } | null = null;
      for (const c of m.exemptIf ?? []) {
        if (c.origins && !matchesOrigin(origin, c.origins)) continue;
        if (c.option) {
          options.push({ key: c.option, label: c.label, context: m.name });
          if (opts[c.option]) exempt ??= c;
          exemptions.push({ id: `${m.id}:${c.option}`, label: c.label, ch99: c.ch99, applied: !!opts[c.option], kind: 'option', option: c.option, program: m.name });
          continue;
        }
        let ok = false;
        if (c.preferentialDutyFree) ok = claimed && base.amount === 0;
        else if (c.preferential) ok = claimed;
        else if (c.families) ok = c.families.some((f) => appliedFamilies.has(f) || appliedPrograms.has(f));
        else if (c.refs) ok = refs.some((r) => c.refs!.includes(r));
        if (ok) {
          exempt ??= c;
          exemptions.push({ id: `${m.id}:${c.ch99 ?? c.label}`, label: c.label, ch99: c.ch99, applied: true, kind: 'auto', program: m.name });
        }
      }
      let ratePct = rate;
      if (cap !== undefined) ratePct = Math.max(0, Math.min(rate, cap - basePct));
      const amount = exempt ? 0 : (ratePct / 100) * dutiable;
      lines.push({
        key: m.id,
        label: m.name,
        program: m.program,
        ch99: exempt?.ch99 ?? ch99,
        legal: m.legal,
        url: m.url,
        ratePct: exempt ? 0 : round2(ratePct),
        rateText: cap !== undefined ? t('combined cap {cap}%', { cap }) : undefined,
        basis: dutiable,
        amount: round2(amount),
        kind: 'additional',
        status: m.status,
        exempted: !!exempt,
        note: [exempt ? t('Exempt: {label}', { label: exempt.label }) : '', sm.via !== t('all goods') ? t('Scope: {via}', { via: sm.via }) : '', m.note ?? '']
          .filter(Boolean)
          .join(' · '),
      });
      if (!exempt) appliedPrograms.add(m.id);
    }
  }

  // ---------------- ADD / CVD ----------------
  const ad = adcvdFlags(rules.adcvd.us.cases, line.code, origin);
  for (const { c, flag } of ad) {
    flags.adcvd.push(flag);
    const comp = c.companies?.find((x) => x.name === input.adcvdCompany);
    const ra = comp ?? c.allOthers;
    if (input.includeAdcvd && ra && (ra.ad !== undefined || ra.cvd !== undefined)) {
      for (const [k, v] of [
        ['AD', ra.ad],
        ['CVD', ra.cvd],
      ] as const) {
        if (v === undefined) continue;
        lines.push({
          key: `adcvd:${c.case}:${k}`,
          label: t(k === 'AD' ? 'Anti-dumping cash deposit — {product}' : 'Countervailing cash deposit — {product}', { product: c.product }),
          program: 'ADD/CVD',
          legal: c.case,
          ratePct: v,
          rateText: comp ? comp.name : t('All others'),
          basis: value,
          amount: round2((v / 100) * value),
          kind: 'adcvd',
          status: c.status,
          url: c.url,
        });
      }
    }
  }
  if (!ad.length && matchesOrigin(origin, rules.adcvd.us.riskOrigins) && anyPrefix(line.code, rules.adcvd.us.riskPrefixes))
    flags.adcvd.push({
      level: 'warning',
      title: t('Possible AD/CVD exposure'),
      detail: t('Origin {country} and a chapter with many orders: check CBP ADCVD Search.', { country: countryName(origin, lang()) }),
      url: rules.adcvd.us.searchUrl,
    });

  // ---------------- Licences / PGA ----------------
  flags.licences = licenceFlags(db, rules.licences.us, line.code, origin, 'US');

  // ---------------- Frais ----------------
  const mpf = R.fees.mpf;
  const mpfExempt = claimed && mpf.exemptPreferentialOrigins.includes(origin);
  let mpfAmt = 0;
  let mpfNote = '';
  if (mpfExempt) mpfNote = t('Exempt: USMCA-originating goods');
  else if (value < mpf.formalThreshold) {
    mpfAmt = mpf.informalFlat;
    mpfNote = t('Informal entry (< ${threshold}) — automated flat fee', { threshold: mpf.formalThreshold });
  } else {
    const raw = (mpf.pct / 100) * dutiable;
    mpfAmt = Math.min(Math.max(raw, mpf.min), mpf.max);
    mpfNote = t('{pct}% (min. ${min}, max. ${max})', { pct: mpf.pct, min: mpf.min, max: mpf.max });
  }
  lines.push({
    key: 'mpf',
    label: mpf.label,
    ratePct: mpfExempt ? 0 : mpf.pct,
    basis: dutiable,
    amount: round2(mpfAmt),
    kind: 'fee',
    legal: mpf.legal,
    status: mpf.status,
    exempted: mpfExempt,
    note: mpfNote,
  });
  if (input.mode && R.fees.hmf.modes.includes(input.mode)) {
    lines.push({
      key: 'hmf',
      label: R.fees.hmf.label,
      ratePct: R.fees.hmf.pct,
      basis: value,
      amount: round2((R.fees.hmf.pct / 100) * value),
      kind: 'fee',
      legal: R.fees.hmf.legal,
      status: R.fees.hmf.status,
    });
  }

  if (prefEligible && !input.preferential)
    flags.info.push({
      level: 'success',
      title: prefCode ? t('{pref} treatment ({spi}) available', { pref: prefLabel, spi: prefCode }) : t('{pref} treatment available', { pref: prefLabel }),
      detail:
        (prefCode
          ? t('Preferential rate: {rate}. ', { rate: special[prefCode] })
          : t('The general rate already applies; USMCA origin still exempts from Section 301 and the MPF. ')) +
        t('Tick "Claim" if the goods are originating (certification of origin required).'),
    });

  if (eff.deferred) {
    flags.info.push({ level: 'info', title: t('Regime {label}', { label: regime.label }), detail: regime.note });
  } else if (regime.id !== 'none' && regime.note) {
    flags.info.push({ level: regime.status === 'verified' ? 'info' : 'warning', title: t('Regime {code} — {label}', { code: regime.code ?? '', label: regime.label }), detail: regime.note });
  }

  const totals = summarize(lines, value);
  const deferred = eff.deferred
    ? {
        bond: round2((totals.duties + totals.adcvd) * (eff.bondMultiple ?? 2)),
        note: t('Duties are not collected if the regime conditions are met; estimated bond amount.'),
      }
    : undefined;

  return {
    ok: true,
    direction: input.direction,
    destination: 'US',
    currency: 'USD',
    value,
    valueInput: { amount: input.value, currency: input.currency },
    dutiableValue: dutiable,
    lines,
    totals,
    preferential: { eligible: prefEligible, program: prefCode, rateText: prefCode ? special[prefCode] : undefined, claimed, label: prefLabel },
    exemptions: dedupe(exemptions),
    options: dedupeOptions(options),
    needs,
    flags,
    regimes: R.regimes.map((r) => ({ id: r.id, label: r.label, code: r.code })),
    deferred,
  };
}

export function summarize(lines: CalcLine[], value: number) {
  const sum = (k: CalcLine['kind'][]) => round2(lines.filter((l) => k.includes(l.kind)).reduce((a, l) => a + l.amount, 0));
  const duties = sum(['base', 'additional']);
  const adcvd = sum(['adcvd']);
  const fees = sum(['fee']);
  const taxes = sum(['tax']);
  const total = round2(duties + adcvd + fees + taxes);
  return { duties, adcvd, fees, taxes, total, dutyPct: value > 0 ? round2(((duties + adcvd) / value) * 100) : 0, landed: round2(value + total) };
}

export function dedupe(list: ExemptionInfo[]): ExemptionInfo[] {
  const m = new Map<string, ExemptionInfo>();
  for (const e of list) {
    const k = e.id;
    const prev = m.get(k);
    if (!prev || (e.applied && !prev.applied)) m.set(k, e);
  }
  return [...m.values()];
}
export function dedupeOptions(list: OptionInfo[]): OptionInfo[] {
  const m = new Map<string, OptionInfo>();
  for (const o of list) if (!m.has(o.key)) m.set(o.key, o);
  return [...m.values()];
}

const INDICATIVE = () => t('indicative prefix (official list not imported)');

function fmt(c: string) {
  const d = digits(c);
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join('.');
}
