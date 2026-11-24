import { countryName, matchesOrigin } from '../countries.js';
import type { Agreement } from '../rules.js';
import { lang, t, tx } from '../i18n/index.js';
import type { AgreementInfo } from './types.js';

/** Codes of the rate maps that are not preferential programs. */
const NOT_PROGRAMS = new Set(['MFN', 'GT', 'GENERAL', 'NPF', 'TG']);

/** Catalog entry for an SPI / treatment code ("S+" → "S", "CPJPT" → CPTPP Japan tariff). */
export function agreementFor(catalog: Record<string, Agreement>, code: string): Agreement | undefined {
  const c = code.trim().toUpperCase();
  if (catalog[c]) return catalog[c];
  const base = c.replace(/[*+]+$/, '');
  if (catalog[base]) return catalog[base];
  const cp = c.match(/^CP([A-Z]{2})T$/);
  if (cp && catalog.CPTPT) {
    const iso = cp[1] === 'UK' ? 'GB' : cp[1];
    return {
      ...catalog.CPTPT,
      name: t('CPTPP — {country} tariff', { country: countryName(iso, lang()) }),
      short: 'CPTPP',
      countries: [iso],
    };
  }
  return undefined;
}

/** Every preferential program with a rate on the line, most relevant for the origin first. */
export function listAgreements(catalog: Record<string, Agreement>, rates: Record<string, string>, origin: string): AgreementInfo[] {
  const out: AgreementInfo[] = [];
  for (const [code, rateText] of Object.entries(rates)) {
    if (!code || NOT_PROGRAMS.has(code.toUpperCase())) continue;
    const a = agreementFor(catalog, code);
    const applicable: AgreementInfo['applicable'] =
      a?.excludeOrigins && matchesOrigin(origin, a.excludeOrigins)
        ? 'no'
        : a?.anyOrigin
          ? 'check'
          : a?.countries?.length
            ? matchesOrigin(origin, a.countries)
              ? 'yes'
              : 'no'
            : a?.candidates?.length
              ? matchesOrigin(origin, a.candidates)
                ? 'check'
                : 'no'
              : 'check';
    out.push({
      code,
      name: a ? tx(a.name)! : t('Preferential program {code}', { code }),
      short: tx(a?.short),
      rateText,
      applicable,
      state: a?.state ?? 'to verify',
      url: a?.url,
      note: tx(a?.note),
      countries: a?.countries,
    });
  }
  const rank = (x: AgreementInfo) => (x.state === 'expired' ? 3 : x.applicable === 'yes' ? 0 : x.applicable === 'check' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

/** The agreement the user picked, if it can be claimed for this origin. */
export function pickAgreement(list: AgreementInfo[], code: string | undefined): AgreementInfo | undefined {
  if (!code) return undefined;
  return list.find((a) => a.code === code && a.applicable !== 'no' && a.state !== 'expired');
}
