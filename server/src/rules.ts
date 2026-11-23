import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { config } from './config.js';

const Status = z.enum(['vérifié', 'à valider']).default('à valider');

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
    exemptIf: z.array(ExemptCond).optional(),
    preferentialBasis: z.enum(['value', 'nonUsContent', 'nonCaMxContent']).optional(),
    group: z.string().optional(),
    priority: z.number().default(0),
  })
  .passthrough();
export type Measure = z.infer<typeof Measure>;

const ProgramOption = z
  .object({
    label: z.string(),
    capCombinedPct: z.number().optional(),
    nonUsContentRate: z.number().optional(),
    floorPct: z.number().optional(),
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
    level: z.enum(['requis', 'peut être requis', 'info']),
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

export interface Rules {
  us: UsRules;
  ca: CaRules;
  adcvd: AdcvdRules;
  licences: LicenceRules;
  loadedAt: string;
}

export const RULE_FILES = {
  us: { file: 'us.yaml', schema: UsRules },
  ca: { file: 'ca.yaml', schema: CaRules },
  adcvd: { file: 'adcvd.yaml', schema: AdcvdRules },
  licences: { file: 'licences.yaml', schema: LicenceRules },
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
    adcvd: read('adcvd') as AdcvdRules,
    licences: read('licences') as LicenceRules,
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
