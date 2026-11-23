import { createRequire } from 'node:module';
import countries from 'i18n-iso-countries';

const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
countries.registerLocale(require('i18n-iso-countries/langs/fr.json'));

export const EU27 = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];

export interface Country {
  code: string;
  fr: string;
  en: string;
}

let cache: Country[] | null = null;
export function listCountries(): Country[] {
  if (cache) return cache;
  const fr = countries.getNames('fr', { select: 'official' });
  const en = countries.getNames('en', { select: 'official' });
  cache = Object.keys(fr)
    .map((code) => ({ code, fr: fr[code], en: en[code] ?? fr[code] }))
    .sort((a, b) => a.fr.localeCompare(b.fr, 'fr'));
  return cache;
}

export function countryName(code: string, lang: 'fr' | 'en' = 'fr'): string {
  if (code === 'EU') return lang === 'fr' ? 'Union européenne' : 'European Union';
  return countries.getName(code, lang) ?? code;
}

const EXTRA_ALIASES: Record<string, string[]> = {
  KR: ['korea', 'south korea', 'republic of korea', 'korea, south'],
  KP: ['north korea', "democratic people's republic of korea"],
  TW: ['taiwan', 'chinese taipei'],
  TR: ['turkey', 'türkiye', 'turkiye'],
  VN: ['vietnam', 'viet nam'],
  RU: ['russia', 'russian federation'],
  GB: ['united kingdom', 'uk', 'great britain'],
  US: ['united states', 'usa'],
  CN: ['china', "people's republic of china"],
  HK: ['hong kong'],
  CZ: ['czech republic', 'czechia'],
  CH: ['switzerland'],
  LA: ['laos', 'lao pdr'],
  BO: ['bolivia'],
  VE: ['venezuela'],
  IR: ['iran'],
  SY: ['syria'],
  MD: ['moldova'],
  TZ: ['tanzania'],
  CD: ['congo (kinshasa)', 'democratic republic of the congo'],
  CI: ["cote d'ivoire", "côte d'ivoire", 'ivory coast'],
  BN: ['brunei'],
  MK: ['north macedonia'],
};

let aliasIndex: [string, string][] | null = null;
function buildAliasIndex(): [string, string][] {
  if (aliasIndex) return aliasIndex;
  const pairs: [string, string][] = [];
  for (const c of listCountries()) {
    pairs.push([c.en.toLowerCase(), c.code]);
    const short = countries.getName(c.code, 'en', { select: 'alias' });
    if (short) pairs.push([short.toLowerCase(), c.code]);
  }
  for (const [code, list] of Object.entries(EXTRA_ALIASES)) for (const a of list) pairs.push([a, code]);
  pairs.push(['european union', 'EU']);
  // plus longs d'abord pour éviter les collisions ("niger" vs "nigeria")
  aliasIndex = pairs.sort((a, b) => b[0].length - a[0].length);
  return aliasIndex;
}

/** Détecte les pays nommés dans un texte anglais (descriptions de rubriques du ch. 99). */
export function detectCountries(text: string): string[] {
  const t = ' ' + text.toLowerCase().replace(/[^a-zà-ÿ' ,()-]/g, ' ') + ' ';
  const found = new Set<string>();
  let rest = t;
  for (const [alias, code] of buildAliasIndex()) {
    const re = new RegExp(`[\\s,(]${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,)]`, 'i');
    if (re.test(rest)) {
      found.add(code);
      rest = rest.replace(re, ' ');
    }
  }
  return [...found];
}

/** Applique l'appartenance UE : un pays membre correspond aussi à "EU". */
export function matchesOrigin(origin: string, list: string[] | undefined | null): boolean {
  if (!list || list.length === 0) return true;
  if (list.includes(origin)) return true;
  if (list.includes('EU') && EU27.includes(origin)) return true;
  return false;
}
