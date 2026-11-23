import type { DB } from '../db.js';
import { getMeta } from '../db.js';
import type { Rules } from '../rules.js';
import { calcCA } from './ca.js';
import { dataInfo, getLine } from './common.js';
import type { CalcInput, CalcResult } from './types.js';
import { calcUS } from './us.js';

export const DEFAULT_FX = 1.38;

export function currentFx(db: DB): { usdCad: number; source: string; date?: string } {
  const fx = getMeta<{ rate: number; date: string; source: string }>(db, 'fx:USDCAD');
  if (fx) return { usdCad: fx.rate, source: fx.source, date: fx.date };
  return { usdCad: DEFAULT_FX, source: 'valeur par défaut (importer le taux BdC)' };
}

/** Ajoute aux règles les dossiers AD/CVD importés par CSV (table adcvd_import). */
export function withImportedAdcvd(db: DB, rules: Rules): Rules {
  const rows = db.prepare('SELECT * FROM adcvd_import').all() as {
    j: string;
    case_no: string;
    product: string;
    country: string;
    prefixes: string;
    ad_rate: number | null;
    cvd_rate: number | null;
    note: string;
    url: string;
  }[];
  if (!rows.length) return rules;
  const toCase = (r: (typeof rows)[number]) => ({
    case: r.case_no,
    product: r.product || r.case_no,
    country: r.country,
    prefixes: r.prefixes.split(/[;,\s]+/).filter(Boolean),
    allOthers: r.ad_rate !== null || r.cvd_rate !== null ? { ad: r.ad_rate ?? undefined, cvd: r.cvd_rate ?? undefined } : undefined,
    note: r.note || undefined,
    url: r.url || undefined,
    status: 'à valider' as const,
  });
  return {
    ...rules,
    adcvd: {
      us: { ...rules.adcvd.us, cases: [...rules.adcvd.us.cases, ...rows.filter((r) => r.j === 'US').map(toCase)] },
      ca: { ...rules.adcvd.ca, cases: [...rules.adcvd.ca.cases, ...rows.filter((r) => r.j === 'CA').map(toCase)] },
    },
  };
}

export function calculate(db: DB, baseRules: Rules, input: CalcInput): CalcResult {
  const rules = withImportedAdcvd(db, baseRules);
  const j = input.direction === 'CA-US' ? 'US' : 'CA';
  const fxInfo = currentFx(db);
  const fx = input.fxUsdCad && input.fxUsdCad > 0 ? { usdCad: input.fxUsdCad, source: 'saisi manuellement' } : fxInfo;
  const info = dataInfo(db, j);
  const data = { importedAt: info.importedAt, source: info.source, rulesLoadedAt: rules.loadedAt, seed: info.seed };
  const line = getLine(db, j, input.code);
  if (!line) {
    return {
      ok: false,
      error: `Code ${input.code} introuvable dans le tarif ${j === 'US' ? 'américain (HTSUS)' : 'canadien'}.`,
      direction: input.direction,
      destination: j,
      currency: j === 'US' ? 'USD' : 'CAD',
      value: 0,
      valueInput: { amount: input.value, currency: input.currency },
      fx,
      dutiableValue: 0,
      lines: [],
      totals: { duties: 0, adcvd: 0, fees: 0, taxes: 0, total: 0, dutyPct: 0, landed: 0 },
      preferential: { eligible: false, claimed: false, label: '' },
      exemptions: [],
      options: [],
      needs: {},
      flags: { bans: [], adcvd: [], licences: [], warnings: [], info: [] },
      regimes: [],
      data,
    };
  }
  const r = j === 'US' ? calcUS(db, rules, line, input, fx.usdCad) : calcCA(db, rules, line, input, fx.usdCad);
  if (data.seed)
    r.flags.warnings.unshift({
      level: 'warning',
      title: 'Données de démonstration',
      detail: 'Le tarif officiel n\'a pas encore été importé. Lancer l\'import dans Admin pour des taux à jour.',
    });
  if (!line.is_leaf)
    r.flags.warnings.push({
      level: 'warning',
      title: 'Code non terminal',
      detail: 'Ce code a des subdivisions : choisir la ligne tarifaire complète (8/10 chiffres) pour un calcul exact.',
    });
  return {
    ...r,
    fx,
    data,
    line: {
      code: line.code,
      display: line.display,
      description: line.description,
      path: line.path,
      general: line.general,
      special: line.special,
      other: line.other,
      units: line.units,
      rateFrom: line.rate_from,
      source: line.source,
      pref: line.pref_json ? JSON.parse(line.pref_json) : {},
    },
  };
}
