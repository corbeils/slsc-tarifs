import type { DB, LineRow, Ch99Row } from '../db.js';
import { digits, getMeta } from '../db.js';
import { EU27, matchesOrigin } from '../countries.js';
import type { AdCase, Licence, Measure } from '../rules.js';
import type { Flag } from './types.js';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function prefixMatch(code: string, prefix: string): boolean {
  const p = digits(prefix);
  return p === '' || digits(code).startsWith(p);
}

export function anyPrefix(code: string, prefixes: string[] | undefined): boolean {
  return !!prefixes && prefixes.some((p) => prefixMatch(code, p));
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function inDate(m: { from?: string; to?: string }, date: string): boolean {
  if (m.from && date < m.from) return false;
  if (m.to && date > m.to) return false;
  return true;
}

export function originAllowed(m: { origins?: string[]; excludeOrigins?: string[] }, origin: string): boolean {
  if (m.origins && m.origins.length && !matchesOrigin(origin, m.origins)) return false;
  if (m.excludeOrigins && m.excludeOrigins.length && matchesOrigin(origin, m.excludeOrigins)) return false;
  return true;
}

export function euKey(origin: string): string {
  return EU27.includes(origin) ? 'EU' : origin;
}

/** Recherche dans les listes de codes importées (table code_lists). */
export function codeListMatch(
  db: DB,
  measureId: string,
  code: string,
): { matched: boolean; partial: boolean; rate: number | null; entry?: string } {
  const rows = db
    .prepare('SELECT code, rate FROM code_lists WHERE measure_id = ?')
    .all(measureId) as { code: string; rate: number | null }[];
  const c = digits(code);
  let best: { code: string; rate: number | null } | null = null;
  let partial = false;
  for (const r of rows) {
    if (c.startsWith(r.code)) {
      if (!best || r.code.length > best.code.length) best = r;
    } else if (r.code.startsWith(c)) partial = true;
  }
  if (best) return { matched: true, partial: false, rate: best.rate, entry: best.code };
  return { matched: partial, partial, rate: null };
}

export function scopeMatch(
  db: DB,
  m: Measure,
  line: LineRow,
): { matched: boolean; partial: boolean; rateOverride: number | null; via: string } {
  const s = m.scope;
  if (s.exclude && anyPrefix(line.code, s.exclude)) return { matched: false, partial: false, rateOverride: null, via: '' };
  if (s.all) return { matched: true, partial: false, rateOverride: null, via: 'toutes marchandises' };
  if (s.codeList) {
    const cl = codeListMatch(db, m.id, line.code);
    if (cl.matched)
      return {
        matched: true,
        partial: cl.partial,
        rateOverride: cl.rate,
        via: cl.partial ? 'liste importée (sous-positions seulement)' : 'liste importée',
      };
  }
  if (s.prefixes && anyPrefix(line.code, s.prefixes)) {
    const listCount = s.codeList ? countList(db, m.id) : -1;
    // Si une liste officielle a été importée, elle fait foi ; les préfixes ne sont qu'un amorçage.
    if (s.codeList && listCount > 0) return { matched: false, partial: false, rateOverride: null, via: '' };
    return { matched: true, partial: false, rateOverride: null, via: 'préfixe indicatif (liste non importée)' };
  }
  if (s.refs && lineRefs(line).some((r) => s.refs!.includes(r)))
    return { matched: true, partial: false, rateOverride: null, via: 'renvoi ch. 99' };
  return { matched: false, partial: false, rateOverride: null, via: '' };
}

const listCountCache = new Map<string, { n: number; t: number }>();
function countList(db: DB, id: string): number {
  const c = listCountCache.get(id);
  if (c && Date.now() - c.t < 5000) return c.n;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM code_lists WHERE measure_id = ?').get(id) as { n: number }).n;
  listCountCache.set(id, { n, t: Date.now() });
  return n;
}
export function clearListCache() {
  listCountCache.clear();
}

export function lineRefs(line: LineRow): string[] {
  return (line.refs ?? '').split(',').filter(Boolean);
}

export function getCh99(db: DB, code: string): Ch99Row | undefined {
  return db.prepare('SELECT * FROM ch99 WHERE code = ?').get(code) as Ch99Row | undefined;
}

export function getLine(db: DB, j: 'US' | 'CA', code: string): LineRow | undefined {
  const c = digits(code);
  const exact = db.prepare('SELECT * FROM lines WHERE j = ? AND code = ?').get(j, c) as LineRow | undefined;
  if (exact) return exact;
  // Code à 8 chiffres sans suffixe statistique : prendre la ligne 8 chiffres ou la 1re ligne 10 chiffres
  const child = db
    .prepare('SELECT * FROM lines WHERE j = ? AND code LIKE ? ORDER BY length(code), code LIMIT 1')
    .get(j, c + '%') as LineRow | undefined;
  if (child) return child;
  // Code plus précis que le tarif importé (ex. 10 chiffres US saisi dans le tarif CA) : remonter au parent
  for (const len of [8, 6]) {
    if (c.length <= len) continue;
    const p = db.prepare('SELECT * FROM lines WHERE j = ? AND code = ?').get(j, c.slice(0, len)) as LineRow | undefined;
    if (p) return p;
  }
  return undefined;
}

export function adcvdFlags(
  cases: AdCase[],
  code: string,
  origin: string,
): { c: AdCase; flag: Flag }[] {
  const out: { c: AdCase; flag: Flag }[] = [];
  for (const c of cases) {
    const countries = c.countries ?? (c.country ? [c.country] : []);
    if (!matchesOrigin(origin, countries)) continue;
    if (!anyPrefix(code, c.prefixes)) continue;
    const rates =
      c.allOthers && (c.allOthers.ad !== undefined || c.allOthers.cvd !== undefined)
        ? ` — taux « tous les autres » : AD ${c.allOthers.ad ?? 0} % + CVD ${c.allOthers.cvd ?? 0} %`
        : '';
    out.push({
      c,
      flag: {
        level: 'danger',
        title: `${c.case} — ${c.product}`,
        detail: (c.note ? c.note + ' ' : '') + rates + ' Portée à confirmer selon la description du produit.',
        url: c.url,
      },
    });
  }
  return out;
}

const PGA_AGENCIES: Record<string, string> = {
  FD: 'FDA',
  EP: 'EPA',
  AM: 'USDA AMS',
  AL: 'USDA APHIS — Lacey Act',
  AQ: 'USDA APHIS',
  FS: 'USDA FSIS',
  FW: 'USFWS',
  DT: 'NHTSA',
  NM: 'NOAA Fisheries',
  OM: 'NOAA',
  TB: 'TTB',
  AT: 'ATF',
  DE: 'DEA',
  CP: 'CPSC',
  DR: 'DEA',
  NR: 'NRC',
  TT: 'TTB',
  DO: 'DOE',
};

export function licenceFlags(db: DB | null, list: Licence[], code: string, origin: string, j: 'US' | 'CA'): Flag[] {
  const flags: Flag[] = [];
  for (const l of list) {
    if (!anyPrefix(code, l.prefixes)) continue;
    if (!originAllowed(l, origin)) continue;
    flags.push({
      level: l.level === 'requis' ? 'danger' : l.level === 'info' ? 'info' : 'warning',
      title: l.label,
      agency: l.agency,
      detail: (l.level === 'requis' ? 'Requis' : l.level === 'info' ? 'Information' : 'Peut être requis') + (l.note ? ' — ' + l.note : ''),
      url: l.url,
    });
  }
  if (db && j === 'US') {
    const c = digits(code);
    const rows = db
      .prepare('SELECT DISTINCT flag FROM pga_flags WHERE ? LIKE code || \'%\' OR code LIKE ? || \'%\'')
      .all(c, c) as { flag: string }[];
    for (const r of rows) {
      const ag = PGA_AGENCIES[r.flag.slice(0, 2)] ?? r.flag.slice(0, 2);
      const lvl = /2$/.test(r.flag) ? 'danger' : 'warning';
      flags.push({
        level: lvl,
        title: `Indicateur PGA ACE : ${r.flag}`,
        agency: ag,
        detail: lvl === 'danger' ? 'Données PGA requises (indicateur officiel CBP)' : 'Données PGA possiblement requises (indicateur officiel CBP)',
      });
    }
  }
  const order = { danger: 0, warning: 1, info: 2, success: 3 } as const;
  return flags.sort((a, b) => order[a.level] - order[b.level]);
}

export function dataInfo(db: DB, j: 'US' | 'CA') {
  const meta = getMeta<{ at: string; source: string; count: number }>(db, `import:${j}`);
  return { importedAt: meta?.at ?? null, source: meta?.source ?? 'aucune', seed: (meta?.source ?? 'seed').startsWith('seed') };
}
