import type { DB, LineRow } from '../db.js';
import { digits } from '../db.js';
import { countryName, matchesOrigin } from '../countries.js';
import type { Program, Rules } from '../rules.js';
import { computeDuty, parseRate, parseUsSpecial } from './rates.js';
import {
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
import type { CalcInput, CalcLine, CalcResult, ExemptionInfo, Flag, OptionInfo } from './types.js';

interface Heading {
  code: string;
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
    label: ov.label ?? (row ? shorten(row.description) : `Rubrique ${code}`),
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
  const prefLabel = isNA ? 'ACEUM / USMCA' : 'Accord de libre-échange';

  let baseText = column2 ? line.other ?? '' : claimed && prefCode ? special[prefCode] : line.general ?? '';
  let baseNote = column2
    ? `Colonne 2 (${countryName(origin)})`
    : claimed && prefCode
      ? `Taux préférentiel ${prefLabel} (indicateur ${prefCode})`
      : claimed
        ? `Colonne 1 — Général (originaire ${prefLabel} réclamé)`
        : 'Colonne 1 — Général (NPF)';
  if (eff.baseFree || (eff.freeIfPreferential?.includes(origin) && input.preferential)) {
    baseText = 'Free';
    baseNote = `Régime ${regime.code} — ${regime.label}`;
  }
  const parsed = parseRate(baseText);
  const base = computeDuty(parsed, dutiable, qty);
  if (base.missingQuantity.length) needs.quantityUnits = base.missingQuantity;
  if (parsed.complex)
    flags.warnings.push({
      level: 'warning',
      title: 'Taux de base complexe',
      detail: `« ${parsed.raw} » n'a pas pu être entièrement interprété ; vérifier manuellement.`,
    });
  lines.push({
    key: 'base',
    label: 'Droit de douane de base',
    program: 'HTSUS',
    rateText: parsed.raw || '—',
    ratePct: parsed.specific.length ? null : parsed.adValorem,
    basis: dutiable,
    amount: round2(base.amount),
    kind: 'base',
    status: 'vérifié',
    note: baseNote + (line.rate_from && line.rate_from !== line.code ? ` · taux de la ligne ${fmt(line.rate_from)}` : ''),
  });
  const basePct = base.effectivePct;

  // Les droits additionnels du ch. 99 visent les produits étrangers
  const skipAdditional = origin === 'US' || !!eff.skipAdditional;
  if (origin === 'US' && !eff.skipAdditional)
    flags.info.push({
      level: 'info',
      title: 'Origine américaine',
      detail: 'Marchandise d\'origine É.-U. retournée : envisager le n° 9801.00.10 (aucun droit additionnel du ch. 99).',
    });

  const appliedFamilies = new Set<string>();
  const appliedPrograms = new Set<string>();
  const consumed = new Set<string>();
  const refs = lineRefs(line);

  if (!skipAdditional) {
    // ---------------- Programmes liés au ch. 99 ----------------
    for (const p of R.programs) {
      const mine = refs.filter((r) => !consumed.has(r) && programMatchesRef(db, p, r));
      if (!mine.length) continue;
      mine.forEach((r) => consumed.add(r));
      const heads = mine.map((r) => resolveHeading(db, p, r));
      const duty = heads.filter(
        (h) =>
          h.kind === 'duty' &&
          (h.origins === null || matchesOrigin(origin, h.origins)) &&
          !(h.excludeOrigins && matchesOrigin(origin, h.excludeOrigins)),
      );
      const exHeads = heads.filter((h) => h.kind === 'exemption');
      for (const b of heads.filter((h) => h.kind === 'ban' && (h.origins === null || matchesOrigin(origin, h.origins))))
        flags.bans.push({ level: 'danger', title: `${b.code} — ${b.label}`, detail: 'Importation interdite.' });
      if (!duty.length) continue;

      if (p.family === 's232' && appliedFamilies.has('s232')) {
        flags.info.push({
          level: 'info',
          title: `${p.name} : non cumulé`,
          detail: 'Un seul programme 232 s\'applique par article (priorité : autos > camions > métaux > bois).',
        });
        continue;
      }
      const choice = input.ch99Choice?.[p.id];
      const sorted = [...duty].sort((a, b) => (b.addPct ?? 0) - (a.addPct ?? 0));
      const chosen = sorted.find((h) => h.code === choice) ?? sorted[0];
      const alternatives = sorted
        .filter((h) => h !== chosen)
        .map((h) => ({ ch99: h.code, label: h.label, ratePct: h.addPct }));

      let exempt: { label: string; ch99?: string } | null = null;
      if (chosen.exemptIfFamilies?.some((f) => appliedFamilies.has(f)))
        exempt = { label: 'Déjà visé par un programme exclusif', ch99: chosen.exemptionCh99 };
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
      let cap: number | undefined;
      const notes: string[] = [];

      if (p.lowMetalExemptPct !== undefined) {
        needs.metalWeight = true;
        if (input.metalWeightPct !== undefined && input.metalWeightPct < p.lowMetalExemptPct)
          exempt = { label: `Teneur en métal < ${p.lowMetalExemptPct} % du poids` };
      }
      const naOrigin = origin === 'CA' || origin === 'MX';
      if (p.preferential && naOrigin) {
        if (p.preferential.partsExemptOption) {
          options.push({ key: p.preferential.partsExemptOption, label: 'Pièce automobile admissible ACEUM (exemptée)', context: p.name });
          if (opts[p.preferential.partsExemptOption] && claimed) exempt = { label: 'Pièce ACEUM admissible' };
        }
        if (p.preferential.mode === 'nonUsContent' && claimed && !exempt) {
          needs.usContent = true;
          const us = input.usContentPct ?? 0;
          basis = dutiable * (1 - us / 100);
          notes.push(`ACEUM : sur le contenu non américain (${round2(100 - us)} % de la valeur)`);
        }
      }
      for (const [key, o] of Object.entries(p.options ?? {})) {
        options.push({ key, label: o.label, context: p.name, status: o.status, note: o.note });
        if (!opts[key]) continue;
        if (o.capCombinedPct !== undefined) {
          cap = o.capCombinedPct;
          notes.push(`Total droit de base + 232 plafonné à ${cap} %`);
        }
        if (o.nonUsContentRate !== undefined) {
          if (claimed && naOrigin) {
            needs.usContent = true;
            rate = o.nonUsContentRate;
            basis = dutiable * (1 - (input.usContentPct ?? 0) / 100);
            floor = o.floorPct ?? 0;
            notes.push(`${rate} % sur le contenu non américain, plancher ${floor} %`);
          } else notes.push('Option ACEUM 232 ignorée : traitement ACEUM non réclamé ou origine hors Canada/Mexique');
        }
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
        ch99: exempt?.ch99 ?? chosen.code,
        ratePct: exempt ? 0 : round2(ratePct ?? 0),
        rateText: chosen.label,
        basis: round2(basis),
        amount: round2(amount),
        kind: 'additional',
        status: p.status,
        url: p.url,
        exempted: !!exempt,
        note: [exempt ? `Exempté : ${exempt.label}` : '', ...notes, p.note ?? ''].filter(Boolean).join(' · '),
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
          label: 'Mesure du ch. 99 (non cartographiée)',
          ch99: r,
          ratePct: row.add_pct,
          rateText: shorten(row.description),
          basis: dutiable,
          amount: round2(amount),
          kind: 'additional',
          status: 'à valider',
          note: 'Ajouter un programme dans rules/us.yaml pour préciser exclusions et cumul.',
        });
      } else if (!countries.length) {
        flags.warnings.push({
          level: 'warning',
          title: `Renvoi ${r} (+${row.add_pct} %) à vérifier`,
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
          detail: `${m.note ?? ''} ${sm.partial ? '(certaines sous-positions seulement)' : ''}`.trim(),
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
        rateText: cap !== undefined ? `plafond combiné ${cap} %` : undefined,
        basis: dutiable,
        amount: round2(amount),
        kind: 'additional',
        status: m.status,
        exempted: !!exempt,
        note: [exempt ? `Exempté : ${exempt.label}` : '', sm.via !== 'toutes marchandises' ? `Portée : ${sm.via}` : '', m.note ?? '']
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
          label: `Dépôt ${k === 'AD' ? 'antidumping' : 'compensateur'} — ${c.product}`,
          program: 'ADD/CVD',
          legal: c.case,
          ratePct: v,
          rateText: comp ? comp.name : 'Tous les autres',
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
      title: 'Exposition AD/CVD possible',
      detail: `Origine ${countryName(origin)} et chapitre à forte concentration d'ordonnances : vérifier dans CBP ADCVD Search.`,
      url: rules.adcvd.us.searchUrl,
    });

  // ---------------- Licences / PGA ----------------
  flags.licences = licenceFlags(db, rules.licences.us, line.code, origin, 'US');

  // ---------------- Frais ----------------
  const mpf = R.fees.mpf;
  const mpfExempt = claimed && mpf.exemptPreferentialOrigins.includes(origin);
  let mpfAmt = 0;
  let mpfNote = '';
  if (mpfExempt) mpfNote = 'Exemptée : marchandise originaire ACEUM';
  else if (value < mpf.formalThreshold) {
    mpfAmt = mpf.informalFlat;
    mpfNote = `Entrée informelle (< ${mpf.formalThreshold} $) — montant forfaitaire automatisé`;
  } else {
    const raw = (mpf.pct / 100) * dutiable;
    mpfAmt = Math.min(Math.max(raw, mpf.min), mpf.max);
    mpfNote = `${mpf.pct} % (min. ${mpf.min} $, max. ${mpf.max} $)`;
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
      title: `Traitement ${prefLabel}${prefCode ? ` (${prefCode})` : ''} possible`,
      detail: `${prefCode ? `Taux préférentiel : ${special[prefCode]}. ` : 'Taux général déjà applicable ; l\'origine ACEUM exempte néanmoins de la 301 et de la MPF. '}Cocher « Réclamer » si la marchandise est originaire (certification d'origine requise).`,
    });

  if (eff.deferred) {
    flags.info.push({ level: 'info', title: `Régime ${regime.label}`, detail: regime.note });
  } else if (regime.id !== 'none' && regime.note) {
    flags.info.push({ level: regime.status === 'vérifié' ? 'info' : 'warning', title: `Régime ${regime.code ?? ''} — ${regime.label}`, detail: regime.note });
  }

  const totals = summarize(lines, value);
  const deferred = eff.deferred
    ? {
        bond: round2((totals.duties + totals.adcvd) * (eff.bondMultiple ?? 2)),
        note: 'Droits non perçus si les conditions du régime sont respectées ; montant de cautionnement estimatif.',
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

function fmt(c: string) {
  const d = digits(c);
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join('.');
}
