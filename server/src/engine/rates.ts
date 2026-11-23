/**
 * Analyse des taux de droits tels qu'écrits dans le HTSUS (USITC) et le Tarif des douanes (CBSA).
 * Exemples gérés :
 *   "Free" | "4.4%" | "2.2¢/kg" | "$1.035/kg" | "6.4¢/kg + 2.8%" | "37.5¢/kg + 15%"
 *   "245.5% but not less than $4.52/kg" | "$1.48/kg" | "Free (A,AU,S,SG)" | "5% (JP)"
 * Tout ce qui n'est pas reconnu est marqué `complex` pour être affiché tel quel avec avertissement.
 */

export interface SpecificPart {
  amount: number; // en unités monétaires (dollars)
  per: string; // unité normalisée (kg, liter, no., doz., pf.liter, ...)
  kind: 'add' | 'min' | 'max';
}

export interface ParsedRate {
  raw: string;
  free: boolean;
  adValorem: number; // pourcentage
  specific: SpecificPart[];
  complex: boolean;
  empty: boolean;
}

const UNIT_ALIASES: Record<string, string> = {
  kg: 'kg',
  'kg.': 'kg',
  kilogram: 'kg',
  kgm: 'kg',
  l: 'liter',
  liter: 'liter',
  litre: 'liter',
  ltr: 'liter',
  'pf.liter': 'pf.liter',
  'proof liter': 'pf.liter',
  each: 'no.',
  'no.': 'no.',
  no: 'no.',
  nmb: 'no.',
  unit: 'no.',
  doz: 'doz.',
  'doz.': 'doz.',
  dozen: 'doz.',
  'doz.prs.': 'doz.prs.',
  pair: 'prs.',
  'prs.': 'prs.',
  m: 'm',
  m2: 'm2',
  'm²': 'm2',
  m3: 'm3',
  'm³': 'm3',
  t: 't',
  tonne: 't',
  ton: 't',
  'clean kg': 'kg',
  'kg on drained weight': 'kg',
  'kg of total sugars': 'kg',
  'kg of dry product': 'kg',
};

export function normUnit(u: string): string {
  const k = u.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.\s+/g, '.');
  if (UNIT_ALIASES[k]) return UNIT_ALIASES[k];
  for (const [alias, n] of Object.entries(UNIT_ALIASES)) {
    if (k.startsWith(alias + ' ') || k === alias) return n;
  }
  return k;
}

export function parseRate(input: string | null | undefined): ParsedRate {
  const raw = (input ?? '').replace(/\s+/g, ' ').trim();
  const out: ParsedRate = { raw, free: false, adValorem: 0, specific: [], complex: false, empty: raw === '' };
  if (!raw) return out;
  let s = raw
    .replace(/\(\s*[A-Z+*,\s]+\)/g, '') // retire listes de programmes "(A,AU,...)"
    .replace(/[ ]/g, ' ')
    .trim();
  if (/^(free|en franchise)\.?$/i.test(s)) {
    out.free = true;
    return out;
  }
  // "but not less than" / "but not more than"
  let minPart: string | null = null;
  let maxPart: string | null = null;
  const mMin = s.match(/but not less than (.*?)(?:,|$| and | but)/i);
  if (mMin) {
    minPart = mMin[1];
    s = s.replace(mMin[0], ' ');
  }
  const mMax = s.match(/but not more than (.*?)(?:,|$| and )/i);
  if (mMax) {
    maxPart = mMax[1];
    s = s.replace(mMax[0], ' ');
  }
  const parts = s.split(/\s*\+\s*/);
  let recognized = false;
  for (const p0 of parts) {
    const p = p0.trim();
    if (!p) continue;
    if (/^free$/i.test(p)) {
      out.free = true;
      continue;
    }
    const pct = p.match(/^([\d.,]+)\s*%$/);
    if (pct) {
      out.adValorem += toNum(pct[1]);
      recognized = true;
      continue;
    }
    const sp = parseSpecific(p);
    if (sp) {
      out.specific.push({ ...sp, kind: 'add' });
      recognized = true;
      continue;
    }
    out.complex = true;
  }
  for (const [txt, kind] of [
    [minPart, 'min'],
    [maxPart, 'max'],
  ] as const) {
    if (!txt) continue;
    const sp = parseSpecific(txt.trim());
    if (sp) out.specific.push({ ...sp, kind });
    else {
      const pct = txt.match(/([\d.,]+)\s*%/);
      if (!pct) out.complex = true;
    }
  }
  if (!recognized && !out.free) out.complex = true;
  if (recognized && out.adValorem === 0 && out.specific.length === 0) out.free = true;
  return out;
}

function toNum(s: string): number {
  return Number(s.replace(/,/g, '.'));
}

function parseSpecific(p: string): { amount: number; per: string } | null {
  // 2.2¢/kg | 2.2 ¢/kg | $1.035/kg | 1.035$/kg | 4.52 $/kg
  let m = p.match(/^([\d.,]+)\s*¢\s*(?:\/|per)\s*(.+)$/i);
  if (m) return { amount: Math.round(toNum(m[1]) * 1e4) / 1e6, per: normUnit(m[2]) };
  m = p.match(/^\$\s*([\d.,]+)\s*(?:\/|per)\s*(.+)$/i);
  if (m) return { amount: toNum(m[1]), per: normUnit(m[2]) };
  m = p.match(/^([\d.,]+)\s*\$\s*(?:\/|per)\s*(.+)$/i);
  if (m) return { amount: toNum(m[1]), per: normUnit(m[2]) };
  m = p.match(/^([\d.,]+)\s*¢\s*each$/i);
  if (m) return { amount: Math.round(toNum(m[1]) * 1e4) / 1e6, per: 'no.' };
  m = p.match(/^\$\s*([\d.,]+)\s*each$/i);
  if (m) return { amount: toNum(m[1]), per: 'no.' };
  return null;
}

export interface DutyComputation {
  amount: number;
  adValoremAmount: number;
  specificAmount: number;
  missingQuantity: string[]; // unités pour lesquelles une quantité est requise
  effectivePct: number;
}

/**
 * Calcule le montant de droit pour une valeur et des quantités (par unité normalisée).
 */
export function computeDuty(
  rate: ParsedRate,
  value: number,
  quantities: Record<string, number>,
): DutyComputation {
  const adv = (rate.adValorem / 100) * value;
  let spec = 0;
  let min = -Infinity;
  let max = Infinity;
  const missing: string[] = [];
  for (const sp of rate.specific) {
    const q = quantities[sp.per];
    if (q === undefined || Number.isNaN(q)) {
      missing.push(sp.per);
      continue;
    }
    const amt = sp.amount * q;
    if (sp.kind === 'add') spec += amt;
    else if (sp.kind === 'min') min = Math.max(min, amt);
    else max = Math.min(max, amt);
  }
  let amount = adv + spec;
  if (min > -Infinity) amount = Math.max(amount, min);
  if (max < Infinity) amount = Math.min(amount, max);
  return {
    amount,
    adValoremAmount: adv,
    specificAmount: amount - adv,
    missingQuantity: missing,
    effectivePct: value > 0 ? (amount / value) * 100 : 0,
  };
}

/**
 * Colonne « Special » du HTSUS : "Free (A+,AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG) 3.4% (JP)".
 * Renvoie un dictionnaire indicateur de programme -> texte du taux.
 */
export function parseUsSpecial(special: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!special) return out;
  const re = /([^()]+?)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(special))) {
    const rate = m[1].trim().replace(/^[,;]\s*/, '');
    for (const code of m[2].split(',')) {
      const c = code.trim();
      if (c) out[c] = rate;
    }
  }
  return out;
}

/** Vrai si la ligne admet le traitement ACEUM/USMCA (indicateurs S ou S+). */
export function usmcaRateFromSpecial(special: string | null | undefined): string | null {
  const m = parseUsSpecial(special);
  return m['S'] ?? m['S+'] ?? null;
}

/**
 * Tarifs préférentiels canadiens : "UST, MXT, CIAT, CT: Free GPT: 6% CPTPT: 1.1%"
 * (le texte peut contenir des retours à la ligne). Renvoie traitement -> taux.
 */
export function parseCaPreferential(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  const s = text.replace(/\s+/g, ' ').trim();
  const re = /((?:[A-Z]{2,7}\s*,\s*)*[A-Z]{2,7})\s*:/g;
  const hits: { codes: string[]; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    hits.push({
      codes: m[1].split(',').map((c) => c.trim()),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (let i = 0; i < hits.length; i++) {
    const rateTxt = s
      .slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : s.length)
      .trim()
      .replace(/[;,]$/, '');
    for (const c of hits[i].codes) out[c] = rateTxt;
  }
  return out;
}

/** Extrait les renvois de type 9903.88.03 / 9902.xx.xx / 9817.00.xx d'un texte. */
export function extractChapter99Refs(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(/\b(99\d{2}\.\d{2}\.\d{2})\b/g)) set.add(m[1]);
  return [...set];
}

/** Taux additionnel d'une rubrique du ch. 99 : "The duty provided in the applicable subheading + 25%". */
export function parseCh99Additional(general: string | null | undefined): {
  addPct: number | null;
  kind: 'duty' | 'exemption' | 'other';
} {
  const g = (general ?? '').replace(/\s+/g, ' ').trim();
  if (!g) return { addPct: null, kind: 'other' };
  const plus = g.match(/applicable subheading\s*\+\s*([\d.]+)\s*%/i);
  if (plus) return { addPct: Number(plus[1]), kind: 'duty' };
  if (/^the duty provided in the applicable subheading\.?$/i.test(g)) return { addPct: 0, kind: 'exemption' };
  if (/^no change\.?$/i.test(g)) return { addPct: 0, kind: 'exemption' };
  if (/^free\.?$/i.test(g)) return { addPct: 0, kind: 'exemption' };
  const pct = g.match(/^([\d.]+)\s*%$/);
  if (pct) return { addPct: Number(pct[1]), kind: 'duty' };
  return { addPct: null, kind: 'other' };
}
