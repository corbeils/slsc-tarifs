import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { config } from './config.js';

// Accepte aussi les anciennes valeurs françaises (fichiers déjà personnalisés)
const Status = z
  .preprocess((v) => (v === 'vérifié' ? 'verified' : v === 'à valider' ? 'to verify' : v), z.enum(['verified', 'to verify']))
  .default('to verify');

const ExemptCond = z
  .object({
    preferential: z.boolean().optional(),
    preferentialDutyFree: z.boolean().optional(),
    origins: z.array(z.string()).optional(),
    families: z.array(z.string()).optional(),
    refs: z.array(z.string()).optional(),
    option: z.string().optional(),
    ch99: z.string().optional(),
    label: z.string(),
  })
  .passthrough();
export type ExemptCond = z.infer<typeof ExemptCond>;

const Source = z.object({
  url: z.string(),
  from: z.string().optional(),
  until: z.string().optional(),
  /** "lastCell": the rate is the last cell of each table row (e.g. Finance Canada lists). */
  rates: z.enum(['lastCell', 'percent', 'stream']).optional(),
  /** Read bare 4-digit headings on their own line (default: true when no rate mode is set). */
  headings: z.boolean().optional(),
});

const Scope = z
  .object({
    all: z.boolean().optional(),
    prefixes: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    refs: z.array(z.string()).optional(),
    codeList: z.boolean().optional(),
  })
  .passthrough();

export const Measure = z
  .object({
    id: z.string(),
    name: z.string(),
    program: z.string().default(''),
    legal: z.string().optional(),
    url: z.string().optional(),
    status: Status,
    note: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    kind: z.enum(['duty', 'ban', 'info']).default('duty'),
    rate: z.number().optional(),
    scope: Scope,
    origins: z.array(z.string()).optional(),
    excludeOrigins: z.array(z.string()).optional(),
    originRates: z.record(z.number()).optional(),
    originCh99: z.record(z.string()).optional(),
    originCaps: z.record(z.number()).optional(),
    autoFromCh99Range: z.tuple([z.string(), z.string()]).optional(),
    requiresOption: z.string().optional(),
    /** Label of the requiresOption checkbox (default: the measure name). */
    optionLabel: z.string().optional(),
    /** Rate is net of these measures already applied (e.g. existing Section 301), percentage points subtracted. */
    netOf: z.array(z.string()).optional(),
    exemptIf: z.array(ExemptCond).optional(),
    preferentialBasis: z.enum(['value', 'nonUsContent', 'nonCaMxContent']).optional(),
    group: z.string().optional(),
    priority: z.number().default(0),
    sources: z.array(Source).optional(),
  })
  .passthrough();
export type Measure = z.infer<typeof Measure>;

const ProgramOption = z
  .object({
    label: z.string(),
    capCombinedPct: z.number().optional(),
    nonUsContentRate: z.number().optional(),
    floorPct: z.number().optional(),
    /** Replaces the program rate (and cancels caps/floors), e.g. 200% for unknown/Russian aluminum. */
    rate: z.number().optional(),
    /** Option keys that have no effect when this option is ticked. */
    disables: z.array(z.string()).optional(),
    warning: z.string().optional(),
    status: Status,
    note: z.string().optional(),
  })
  .passthrough();

const HeadingOverride = z
  .object({
    label: z.string().optional(),
    origins: z.array(z.string()).optional(),
    excludeOrigins: z.array(z.string()).optional(),
    rate: z.number().optional(),
    kind: z.enum(['duty', 'exemption', 'ban']).optional(),
    option: z.string().optional(),
    exemptIfFamilies: z.array(z.string()).optional(),
    exemptionCh99: z.string().optional(),
  })
  .passthrough();

export const Program = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string(),
    prefixes: z.array(z.string()).optional(),
    descriptionRegex: z.string().optional(),
    defaultOrigins: z.array(z.string()).optional(),
    url: z.string().optional(),
    status: Status,
    note: z.string().optional(),
    lowMetalExemptPct: z.number().optional(),
    options: z.record(ProgramOption).optional(),
    preferential: z
      .object({ mode: z.enum(['exempt', 'nonUsContent', 'none']), partsExemptOption: z.string().optional() })
      .optional(),
    headings: z.record(HeadingOverride).optional(),
    /** Annex / list based coverage (when USITC does not footnote the lines). */
    lists: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            rate: z.number(),
            ch99: z.string().optional(),
            prefixes: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
            origins: z.array(z.string()).optional(),
            capCombinedPct: z.number().optional(),
            /** Higher priority wins over a higher rate (e.g. Annex III / I-C over I-B). */
            priority: z.number().default(0),
            /** Removal list (e.g. Annex II): goods listed are outside the program. */
            exclusion: z.boolean().optional(),
            /** Official documents the list is imported from automatically. */
            sources: z.array(Source).optional(),
            status: Status,
            note: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type Program = z.infer<typeof Program>;

const Regime = z
  .object({
    id: z.string(),
    code: z.string().optional(),
    label: z.string(),
    effect: z
      .object({
        baseFree: z.boolean().optional(),
        skipAdditional: z.boolean().optional(),
        onRepairValue: z.boolean().optional(),
        freeIfPreferential: z.array(z.string()).optional(),
        deferred: z.boolean().optional(),
        bondMultiple: z.number().optional(),
        gstOnRepairValue: z.boolean().optional(),
        infoOnly: z.boolean().optional(),
      })
      .optional(),
    note: z.string().optional(),
    status: Status,
  })
  .passthrough();
export type Regime = z.infer<typeof Regime>;

/** Free trade agreement / preference program, keyed by the SPI or tariff treatment code. */
export const Agreement = z
  .object({
    name: z.string(),
    short: z.string().optional(),
    /** Origins that can claim it; omitted = eligibility to check (beneficiary lists). */
    countries: z.array(z.string()).optional(),
    /** Program open to every origin (subject to end-use conditions). */
    anyOrigin: z.boolean().optional(),
    /** Possible beneficiaries when the list changes (eligibility still to check). */
    candidates: z.array(z.string()).optional(),
    /** Origins that can never claim it. */
    excludeOrigins: z.array(z.string()).optional(),
    state: z.enum(['active', 'expired', 'to verify']).default('active'),
    mpfExempt: z.boolean().optional(),
    url: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();
export type Agreement = z.infer<typeof Agreement>;

export const UsRules = z
  .object({
    currency: z.literal('USD'),
    fees: z.object({
      mpf: z.object({
        label: z.string(),
        pct: z.number(),
        min: z.number(),
        max: z.number(),
        formalThreshold: z.number(),
        informalFlat: z.number(),
        exemptPreferentialOrigins: z.array(z.string()).default([]),
        legal: z.string().optional(),
        status: Status,
      }),
      hmf: z.object({ label: z.string(), pct: z.number(), modes: z.array(z.string()), legal: z.string().optional(), status: Status }),
    }),
    column2Countries: z.array(z.string()),
    preferentialPrograms: z.record(z.array(z.string())),
    agreements: z.record(Agreement).default({}),
    programs: z.array(Program),
    measures: z.array(Measure),
    regimes: z.array(Regime),
  })
  .passthrough();
export type UsRules = z.infer<typeof UsRules>;

export const CaRules = z
  .object({
    currency: z.literal('CAD'),
    taxes: z.object({
      gst: z.object({ label: z.string(), pct: z.number(), status: Status }),
      hst: z.record(z.number()),
      note: z.string().optional(),
    }),
    preferential: z.record(z.array(z.string())),
    agreements: z.record(Agreement).default({}),
    ftaPartners: z.array(z.string()),
    measures: z.array(Measure),
    regimes: z.array(Regime),
  })
  .passthrough();
export type CaRules = z.infer<typeof CaRules>;

const AdCase = z
  .object({
    case: z.string(),
    product: z.string(),
    country: z.string().optional(),
    countries: z.array(z.string()).optional(),
    prefixes: z.array(z.string()),
    allOthers: z.object({ ad: z.number().optional(), cvd: z.number().optional() }).optional(),
    companies: z.array(z.object({ name: z.string(), ad: z.number().optional(), cvd: z.number().optional() })).optional(),
    note: z.string().optional(),
    url: z.string().optional(),
    status: Status,
  })
  .passthrough();
export type AdCase = z.infer<typeof AdCase>;

export const AdcvdRules = z.object({
  us: z.object({
    searchUrl: z.string(),
    proceedingsUrl: z.string().optional(),
    cases: z.array(AdCase),
    riskOrigins: z.array(z.string()).default([]),
    riskPrefixes: z.array(z.string()).default([]),
  }),
  ca: z.object({ searchUrl: z.string(), cases: z.array(AdCase) }),
});
export type AdcvdRules = z.infer<typeof AdcvdRules>;

const Licence = z
  .object({
    agency: z.string(),
    label: z.string(),
    level: z.preprocess(
      (v) => (v === 'requis' ? 'required' : v === 'peut être requis' ? 'may be required' : v),
      z.enum(['required', 'may be required', 'info']),
    ),
    prefixes: z.array(z.string()),
    origins: z.array(z.string()).optional(),
    excludeOrigins: z.array(z.string()).optional(),
    url: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();
export type Licence = z.infer<typeof Licence>;
export const LicenceRules = z.object({ us: z.array(Licence), ca: z.array(Licence) });
export type LicenceRules = z.infer<typeof LicenceRules>;

export const EuRules = z
  .object({
    currency: z.literal('EUR'),
    vat: z.record(z.number()),
    vatNote: z.string().optional(),
    measureTypes: z.record(z.array(z.string())),
    outOfQuota: z.object({ legal: z.array(z.string()), label: z.string(), note: z.string().optional() }).optional(),
    agreements: z.record(Agreement).default({}),
  })
  .passthrough();
export type EuRules = z.infer<typeof EuRules>;

export const NewsSource = z.object({
  id: z.string(),
  source: z.string(),
  jurisdiction: z.enum(['US', 'CA', 'EU']),
  kind: z.enum(['federalregister', 'feed', 'cbsa']),
  url: z.string(),
  lang: z.enum(['en', 'fr']).optional(),
  group: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});
export type NewsSource = z.infer<typeof NewsSource>;
export const NewsRules = z.object({ keepDays: z.number().default(400), sources: z.array(NewsSource) });
export type NewsRules = z.infer<typeof NewsRules>;

export interface Rules {
  news: NewsRules;
  us: UsRules;
  ca: CaRules;
  eu: EuRules;
  adcvd: AdcvdRules;
  licences: LicenceRules;
  loadedAt: string;
}

export const RULE_FILES = {
  us: { file: 'us.yaml', schema: UsRules },
  ca: { file: 'ca.yaml', schema: CaRules },
  eu: { file: 'eu.yaml', schema: EuRules },
  adcvd: { file: 'adcvd.yaml', schema: AdcvdRules },
  licences: { file: 'licences.yaml', schema: LicenceRules },
  news: { file: 'news.yaml', schema: NewsRules },
} as const;
export type RuleKey = keyof typeof RULE_FILES;

export function parseRuleText(key: RuleKey, text: string) {
  const data = YAML.parse(text);
  return RULE_FILES[key].schema.parse(data);
}

let current: Rules | null = null;

export function loadRules(dir = config.rulesDir): Rules {
  const read = (k: RuleKey) => parseRuleText(k, fs.readFileSync(path.join(dir, RULE_FILES[k].file), 'utf8'));
  current = {
    us: read('us') as UsRules,
    ca: read('ca') as CaRules,
    eu: read('eu') as EuRules,
    adcvd: read('adcvd') as AdcvdRules,
    licences: read('licences') as LicenceRules,
    news: read('news') as NewsRules,
    loadedAt: new Date().toISOString(),
  };
  return current;
}

export function getRules(): Rules {
  return current ?? loadRules();
}

export function readRuleFile(key: RuleKey, dir = config.rulesDir): string {
  return fs.readFileSync(path.join(dir, RULE_FILES[key].file), 'utf8');
}

/** Valide puis écrit un fichier de règles (copie de sauvegarde .bak conservée). */
export function writeRuleFile(key: RuleKey, text: string, dir = config.rulesDir) {
  parseRuleText(key, text);
  const p = path.join(dir, RULE_FILES[key].file);
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, text, 'utf8');
  return loadRules(dir);
}
