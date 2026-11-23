export type Direction = 'CA-US' | 'US-CA';

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
  status?: 'vérifié' | 'à valider';
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
}
export interface CalcResult {
  ok: boolean;
  error?: string;
  direction: Direction;
  destination: 'US' | 'CA';
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
  exemptions: { id: string; label: string; ch99?: string; applied: boolean; kind: 'auto' | 'option' | 'claim'; option?: string; program?: string }[];
  options: { key: string; label: string; context: string; status?: string; note?: string }[];
  needs: { usContent?: boolean; caMxContent?: boolean; metalWeight?: boolean; quantityUnits?: string[]; repairValue?: boolean };
  flags: { bans: Flag[]; adcvd: Flag[]; licences: Flag[]; warnings: Flag[]; info: Flag[] };
  regimes: { id: string; label: string; code?: string }[];
  deferred?: { bond: number; note: string };
  data: { importedAt: string | null; source: string; rulesLoadedAt: string; seed: boolean };
}
export interface SearchHit {
  code: string;
  display: string;
  description: string;
  path: string;
  general: string | null;
  is_leaf: number;
}
export interface Country {
  code: string;
  fr: string;
  en: string;
}

const tokenKey = 'slsc-tarifs-admin';
export const adminToken = {
  get: () => localStorage.getItem(tokenKey) ?? '',
  set: (t: string) => localStorage.setItem(tokenKey, t),
};

async function req<T>(url: string, init: RequestInit = {}, admin = false): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (admin) headers['x-admin-token'] = adminToken.get();
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  meta: () => req<any>('/api/meta'),
  countries: () => req<Country[]>('/api/countries'),
  search: (j: 'US' | 'CA', q: string) => req<SearchHit[]>(`/api/search?j=${j}&q=${encodeURIComponent(q)}`),
  calc: (body: unknown) => req<CalcResult>('/api/calc', { method: 'POST', body: JSON.stringify(body) }),
  measures: () => req<any>('/api/measures'),
  admin: {
    check: () => req<{ ok: boolean }>('/api/admin/check', {}, true),
    importUs: () => req<{ job: string }>('/api/admin/import/us', { method: 'POST' }, true),
    job: (id: string) => req<any>(`/api/admin/jobs/${id}`, {}, true),
    upload: (path: string, file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return req<any>(path, { method: 'POST', body: fd }, true);
    },
    caUrl: (url: string) => req<{ job: string }>('/api/admin/import/ca-url', { method: 'POST', body: JSON.stringify({ url }) }, true),
    fxOnline: () => req<any>('/api/admin/import/fx', { method: 'POST' }, true),
    fxManual: (rate: number) => req<any>('/api/admin/fx', { method: 'POST', body: JSON.stringify({ rate }) }, true),
    codes: (body: unknown) => req<any>('/api/admin/codes', { method: 'POST', body: JSON.stringify(body) }, true),
    listCodes: (id: string) => req<any[]>(`/api/admin/codes/${id}`, {}, true),
    deleteCodes: (id: string) => req<any>(`/api/admin/codes/${id}`, { method: 'DELETE' }, true),
    rules: (key: string) => req<{ text: string; file: string }>(`/api/admin/rules/${key}`, {}, true),
    saveRules: (key: string, text: string) => req<any>(`/api/admin/rules/${key}`, { method: 'PUT', body: JSON.stringify({ text }) }, true),
  },
};

export const money = (n: number, cur: string) =>
  new Intl.NumberFormat('fr-CA', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n || 0);
export const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 3 }).format(n)} %`;
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
