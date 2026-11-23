export type Direction = 'CA-US' | 'US-CA';
export type Jurisdiction = 'US' | 'CA';

export interface CalcInput {
  /** CA-US = importation aux États-Unis ; US-CA = importation au Canada */
  direction: Direction;
  code: string;
  origin: string;
  value: number;
  currency: 'USD' | 'CAD';
  quantities?: Record<string, number>;
  date?: string;
  mode?: 'truck' | 'rail' | 'ocean' | 'air';
  preferential?: boolean;
  usContentPct?: number;
  caMxContentPct?: number;
  metalWeightPct?: number;
  options?: Record<string, boolean>;
  regime?: string;
  repairValue?: number;
  province?: string;
  includeAdcvd?: boolean;
  adcvdCompany?: string;
  ch99Choice?: Record<string, string>;
  claimExemptions?: string[];
  fxUsdCad?: number;
}

export type Status = 'vérifié' | 'à valider';

export interface CalcLine {
  key: string;
  label: string;
  program?: string;
  ch99?: string;
  legal?: string;
  url?: string;
  ratePct?: number | null;
  rateText?: string;
  basis: number;
  amount: number;
  kind: 'base' | 'additional' | 'adcvd' | 'fee' | 'tax';
  status?: Status;
  note?: string;
  exempted?: boolean;
  notCumulated?: boolean;
  alternatives?: { ch99: string; label: string; ratePct: number | null }[];
}

export interface Flag {
  level: 'danger' | 'warning' | 'info' | 'success';
  title: string;
  detail?: string;
  url?: string;
  agency?: string;
  amount?: number;
}

export interface ExemptionInfo {
  id: string;
  label: string;
  ch99?: string;
  applied: boolean;
  kind: 'auto' | 'option' | 'claim';
  option?: string;
  program?: string;
}

export interface OptionInfo {
  key: string;
  label: string;
  context: string;
  status?: Status;
  note?: string;
}

export interface CalcResult {
  ok: boolean;
  error?: string;
  direction: Direction;
  destination: Jurisdiction;
  currency: 'USD' | 'CAD';
  line?: {
    code: string;
    display: string;
    description: string;
    path: string;
    general: string | null;
    special: string | null;
    other: string | null;
    units: string | null;
    rateFrom: string | null;
    source: string;
    pref: Record<string, string>;
  };
  value: number;
  valueInput: { amount: number; currency: string };
  fx: { usdCad: number; source: string; date?: string };
  dutiableValue: number;
  lines: CalcLine[];
  totals: { duties: number; adcvd: number; fees: number; taxes: number; total: number; dutyPct: number; landed: number };
  preferential: { eligible: boolean; program?: string; rateText?: string; claimed: boolean; label: string };
  exemptions: ExemptionInfo[];
  options: OptionInfo[];
  needs: { usContent?: boolean; caMxContent?: boolean; metalWeight?: boolean; quantityUnits?: string[]; repairValue?: boolean };
  flags: { bans: Flag[]; adcvd: Flag[]; licences: Flag[]; warnings: Flag[]; info: Flag[] };
  regimes: { id: string; label: string; code?: string }[];
  deferred?: { bond: number; note: string };
  data: { importedAt: string | null; source: string; rulesLoadedAt: string; seed: boolean };
}
