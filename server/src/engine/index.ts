import { localizeRules, t, withLang, type Lang } from '../i18n/index.js';
import type { DB } from '../db.js';
import { getMeta } from '../db.js';
import type { Rules } from '../rules.js';
import { calcCA } from './ca.js';
import { dataInfo, getLine } from './common.js';
import type { CalcInput, CalcResult } from './types.js';
import { calcUS } from './us.js';
import { calcEU } from './eu.js';

export const DEFAULT_FX = 1.38;
export const DEFAULT_EUR_CAD = 1.6;

export function currentFx(db: DB): { usdCad: number; source: string; date?: string; eurCad: number } {
  const fx = getMeta<{ rate: number; date: string; source: string }>(db, 'fx:USDCAD');
  const eur = getMeta<{ rate: number }>(db, 'fx:EURCAD');
  const eurCad = eur?.rate ?? DEFAULT_EUR_CAD;
  if (fx) return { usdCad: fx.rate, source: fx.source, date: fx.date, eurCad };
  return { usdCad: DEFAULT_FX, source: t('default value (import the Bank of Canada rate)'), eurCad };
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
    status: 'to verify' as const,
  });
  return {
    ...rules,
    adcvd: {
      us: { ...rules.adcvd.us, cases: [...rules.adcvd.us.cases, ...rows.filter((r) => r.j === 'US').map(toCase)] },
      ca: { ...rules.adcvd.ca, cases: [...rules.adcvd.ca.cases, ...rows.filter((r) => r.j === 'CA').map(toCase)] },
    },
  };
}

export function calculate(db: DB, baseRules: Rules, input: CalcInput, l: Lang = 'en'): CalcResult {
  return withLang(l, () => calculateIn(db, localizeRules(baseRules, l), input));
}

function calculateIn(db: DB, baseRules: Rules, input: CalcInput): CalcResult {
  const rules = withImportedAdcvd(db, baseRules);
  const j = input.direction === 'CA-US' ? 'US' : input.direction === 'IN-EU' ? 'EU' : 'CA';
  const fxInfo = currentFx(db);
  const fx = input.fxUsdCad && input.fxUsdCad > 0 ? { ...fxInfo, usdCad: input.fxUsdCad, source: t('entered manually') } : fxInfo;
  const info = dataInfo(db, j);
  const data = { importedAt: info.importedAt, source: info.source, rulesLoadedAt: rules.loadedAt, seed: info.seed };
  const line = getLine(db, j, input.code);
  if (!line) {
    return {
      ok: false,
      error:
        j === 'EU' && !info.importedAt
          ? t('The EU tariff (TARIC) has not been imported yet: import it in Admin.')
          : t(j === 'US' ? 'Code {code} not found in the U.S. tariff (HTSUS).' : j === 'EU' ? 'Code {code} not found in the EU tariff (TARIC).' : 'Code {code} not found in the Canadian Customs Tariff.', { code: input.code }),
      direction: input.direction,
      destination: j,
      currency: j === 'US' ? 'USD' : j === 'EU' ? 'EUR' : 'CAD',
      value: 0,
      valueInput: { amount: input.value, currency: input.currency },
      fx,
      dutiableValue: 0,
      lines: [],
      totals: { duties: 0, adcvd: 0, fees: 0, taxes: 0, total: 0, dutyPct: 0, landed: 0 },
      preferential: { eligible: false, claimed: false, label: '' },
      agreements: [],
      exemptions: [],
      options: [],
      needs: {},
      flags: { bans: [], adcvd: [], licences: [], warnings: [], info: [] },
      regimes: [],
      data,
    };
  }
  const r =
    j === 'US'
      ? calcUS(db, rules, line, input, fx.usdCad)
      : j === 'EU'
        ? calcEU(db, rules, line, input, { usdCad: fx.usdCad, eurCad: fx.eurCad })
        : calcCA(db, rules, line, input, fx.usdCad);
  if (data.seed && j !== 'EU')
    r.flags.warnings.unshift({
      level: 'warning',
      title: t('Demo data'),
      detail: t('The official tariff has not been imported yet. Run the import in Admin for current rates.'),
    });
  if (!line.is_leaf)
    r.flags.warnings.push({
      level: 'warning',
      title: t('Non-terminal code'),
      detail: t('This code has subdivisions: choose the full tariff line (8/10 digits) for an exact calculation.'),
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
