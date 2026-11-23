import type { DB, LineRow } from '../db.js';
import { countryName, EU27, matchesOrigin } from '../countries.js';
import type { Measure, Rules } from '../rules.js';
import { computeDuty, parseRate } from './rates.js';
import { adcvdFlags, inDate, licenceFlags, originAllowed, round2, scopeMatch } from './common.js';
import { dedupe, dedupeOptions, summarize } from './us.js';
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
  const prefCode = treatments.find((t) => pref[t] !== undefined && pref[t] !== '');
  const prefEligible = !!prefCode;
  const claimed = !!input.preferential && prefEligible;
  const prefLabel = origin === 'US' || origin === 'MX' ? 'ACEUM / CUSMA' : 'Accord de libre-échange';

  let baseText: string;
  let baseNote: string;
  if (GENERAL_TARIFF_COUNTRIES.includes(origin)) {
    baseText = line.other ?? '35%';
    baseNote = 'Tarif général';
  } else if (claimed) {
    baseText = pref[prefCode!];
    baseNote = `Traitement ${prefCode} (${prefLabel})`;
  } else {
    baseText = line.general ?? '';
    baseNote = 'Tarif de la nation la plus favorisée (NPF)';
  }
  if (eff.baseFree) {
    baseText = 'Free';
    baseNote = `Régime ${regime.code} — ${regime.label}`;
  }
  const parsed = parseRate(baseText);
  const base = computeDuty(parsed, value, input.quantities ?? {});
  if (base.missingQuantity.length) needs.quantityUnits = base.missingQuantity;
  if (parsed.complex)
    flags.warnings.push({ level: 'warning', title: 'Taux de base complexe', detail: `« ${parsed.raw} » à vérifier manuellement.` });
  lines.push({
    key: 'base',
    label: 'Droits de douane',
    program: 'Tarif des douanes',
    rateText: parsed.raw || '—',
    ratePct: parsed.specific.length ? null : parsed.adValorem,
    basis: value,
    amount: round2(base.amount),
    kind: 'base',
    status: 'vérifié',
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
    if (m.preferentialBasis === 'nonCaMxContent' && claimed) {
      needs.caMxContent = true;
      const pct = input.caMxContentPct ?? 0;
      basis = value * (1 - pct / 100);
      notes.push(`CUSMA : sur le contenu non canadien et non mexicain (${round2(100 - pct)} %)`);
    }
    if (c.partial) notes.push('La liste ne vise que certaines sous-positions : préciser le numéro à 10 chiffres');
    notes.push(`Portée : ${c.via}`);
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
        x.exempt ? `Remise / exemption : ${x.exempt.label}` : '',
        nc ? 'Non cumulatif — une autre mesure du même groupe s\'applique (montant le plus élevé retenu)' : '',
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
      title: `LMSI ${flag.title}`,
      detail: 'Droits antidumping/compensateurs possibles (valeur normale propre à l\'exportateur). Vérifier la définition du produit dans la mesure en vigueur.',
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
      label: `TVH (${prov})`,
      ratePct: hst,
      basis: round2(taxBase),
      amount: round2((hst / 100) * taxBase),
      kind: 'tax',
      status: 'vérifié',
      note: 'Base : valeur en douane + droits + surtaxes. Récupérable par CTI pour les inscrits.',
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
      note: 'Base : valeur en douane + droits + surtaxes. Récupérable par CTI pour les inscrits.' + (prov === 'QC' ? ' TVQ non perçue à la frontière.' : ''),
    });
  }

  if (prefEligible && !input.preferential)
    flags.info.push({
      level: 'success',
      title: `Admissible au traitement ${prefCode} (${prefLabel})`,
      detail: `Taux : ${pref[prefCode!]}. Cocher « Réclamer » si la marchandise est originaire (preuve d'origine requise).`,
    });
  if (origin === 'US' && !prefEligible)
    flags.info.push({ level: 'info', title: 'Aucun taux TÉU (UST) trouvé pour cette ligne', detail: 'Vérifier le fichier du tarif importé.' });
  if (regime.id !== 'none' && regime.note)
    flags.info.push({ level: 'info', title: `Régime ${regime.code ?? ''} — ${regime.label}`, detail: regime.note });
  if (!skipAdditional && origin === 'US')
    flags.info.push({
      level: 'info',
      title: 'Surtaxes canadiennes : listes officielles',
      detail:
        'Les surtaxes s\'appliquent par numéro tarifaire. Si une liste n\'est pas encore importée, la correspondance se fait par préfixe indicatif (marquée comme telle).',
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
    overQuota: 'Importation hors contingent (contingent trimestriel épuisé pour le pays)',
    chinaMeltedSteel: 'Contient de l\'acier fondu et coulé en Chine',
  };
  return m[k] ?? k;
}

export { countryName, matchesOrigin };
