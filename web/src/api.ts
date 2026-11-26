import { getLang } from './i18n';

export type Direction = 'CA-US' | 'US-CA' | 'IN-EU';

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
  status?: 'verified' | 'to verify';
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
  destination: 'US' | 'CA' | 'EU';
  currency: 'USD' | 'CAD' | 'EUR';
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
  fx: { usdCad: number; source: string; date?: string; eurCad?: number };
  dutiableValue: number;
  lines: CalcLine[];
  totals: { duties: number; adcvd: number; fees: number; taxes: number; total: number; dutyPct: number; landed: number };
  preferential: { eligible: boolean; program?: string; rateText?: string; claimed: boolean; label: string };
  agreements: AgreementInfo[];
  lineUrl?: string;
  exemptions: { id: string; label: string; ch99?: string; applied: boolean; kind: 'auto' | 'option' | 'claim'; option?: string; program?: string }[];
  options: { key: string; label: string; context: string; status?: string; note?: string }[];
  needs: { usContent?: boolean; caMxContent?: boolean; metalWeight?: boolean; quantityUnits?: string[]; repairValue?: boolean };
  flags: { bans: Flag[]; adcvd: Flag[]; licences: Flag[]; warnings: Flag[]; info: Flag[] };
  regimes: { id: string; label: string; code?: string }[];
  deferred?: { bond: number; note: string };
  data: { importedAt: string | null; source: string; rulesLoadedAt: string; seed: boolean };
}
export interface AgreementInfo {
  code: string;
  name: string;
  short?: string;
  rateText: string;
  applicable: 'yes' | 'check' | 'no';
  state: 'active' | 'expired' | 'to verify';
  url?: string;
  note?: string;
  countries?: string[];
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

const tokenKey = 'slsc-tariff-session';
export const session = {
  get: () => localStorage.getItem(tokenKey) ?? '',
  set: (t: string) => {
    localStorage.setItem(tokenKey, t);
    window.dispatchEvent(new Event('slsc-session'));
  },
  clear: () => {
    localStorage.removeItem(tokenKey);
    window.dispatchEvent(new Event('slsc-session'));
  },
};

async function req<T>(url: string, init: RequestInit = {}, admin = false): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (admin) headers['Authorization'] = `Bearer ${session.get()}`;
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  meta: () => req<any>('/api/meta'),
  countries: () => req<Country[]>('/api/countries'),
  search: (j: 'US' | 'CA' | 'EU', q: string) => req<SearchHit[]>(`/api/search?j=${j}&q=${encodeURIComponent(q)}`),
  /** Retries network failures ("Failed to fetch": connection dropped by a proxy / container restart). */
  calc: async (body: object, signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await req<CalcResult>('/api/calc', { method: 'POST', body: JSON.stringify({ ...body, lang: getLang() }), signal });
      } catch (e) {
        const network = e instanceof TypeError || (e as { status?: number }).status === 502 || (e as { status?: number }).status === 504;
        if (!network || signal?.aborted || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  },
  changelog: () => req<{ version: string; beta: boolean; at: string; notes: string }[]>('/api/changelog'),
  measures: () => req<any>(`/api/measures?lang=${getLang()}`),
  lookup: (q: string, j: string) => req<any[]>(`/api/lookup/search?q=${encodeURIComponent(q)}&j=${j}`, {}, true),
  classify: (j: string, turns: unknown[]) => req<any>('/api/lookup/classify', { method: 'POST', body: JSON.stringify({ j, turns, lang: getLang() }) }, true),
  lookupHs: (hs6: string) => req<any>(`/api/lookup/hs/${hs6}`, {}, true),
  measuresEu: (origin: string) => req<any>(`/api/measures/eu?lang=${getLang()}&origin=${encodeURIComponent(origin)}`),
  login: (username: string, password: string) =>
    req<{ token: string; username: string; mustChange: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req<any>('/api/auth/logout', { method: 'POST' }, true),
  admin: {
    me: () => req<{ username: string; mustChange: boolean; role: 'admin' | 'user'; prefs: Record<string, string> }>('/api/admin/me', {}, true),
    prefs: (p: Record<string, string>) => req<any>('/api/admin/prefs', { method: 'POST', body: JSON.stringify(p) }, true),
    setRole: (u: string, role: string) => req<any>(`/api/admin/users/${encodeURIComponent(u)}/role`, { method: 'POST', body: JSON.stringify({ role }) }, true),
    changePassword: (current: string, next: string) =>
      req<any>('/api/admin/password', { method: 'POST', body: JSON.stringify({ current, next }) }, true),
    users: () => req<{ username: string; mustChange: number; createdAt: string; role: 'admin' | 'user' }[]>('/api/admin/users', {}, true),
    addUser: (username: string, password: string, role = 'user') => req<any>('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }, true),
    resetUser: (username: string, password: string) =>
      req<any>(`/api/admin/users/${encodeURIComponent(username)}/reset`, { method: 'POST', body: JSON.stringify({ password }) }, true),
    deleteUser: (username: string) => req<any>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' }, true),
    importUs: () => req<{ job: string }>('/api/admin/import/us', { method: 'POST' }, true),
    job: (id: string) => req<any>(`/api/admin/jobs/${id}`, {}, true),
    upload: (path: string, file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return req<any>(path, { method: 'POST', body: fd }, true);
    },
    caUrl: (url: string) => req<{ job: string }>('/api/admin/import/ca-url', { method: 'POST', body: JSON.stringify({ url }) }, true),
    syncLists: () => req<{ job: string }>('/api/admin/sync/official-lists', { method: 'POST' }, true),
    syncCbsa: (force = false) => req<{ job: string }>('/api/admin/sync/cbsa', { method: 'POST', body: JSON.stringify({ force }) }, true),
    fxOnline: () => req<any>('/api/admin/import/fx', { method: 'POST' }, true),
    siteVersion: (version: string, beta: boolean, notes = '') => req<any>('/api/admin/site-version', { method: 'POST', body: JSON.stringify({ version, beta, notes }) }, true),
    taricUpload: (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append('file', f, f.name));
      return req<{ job: string }>('/api/admin/import/taric', { method: 'POST', body: fd }, true);
    },
    taricUrls: (urls: string[]) => req<any>('/api/admin/taric-urls', { method: 'POST', body: JSON.stringify({ urls }) }, true),
    changelog: () => req<any[]>('/api/admin/changelog', {}, true),
    rename: (username: string, password: string) => req<{ username: string }>('/api/admin/username', { method: 'POST', body: JSON.stringify({ username, password }) }, true),
    aiGet: () => req<any>('/api/admin/ai', {}, true),
    aiSet: (v: { provider?: string; key?: string; model?: string; baseUrl?: string; vision?: boolean; active?: boolean }) => req<any>('/api/admin/ai', { method: 'POST', body: JSON.stringify(v) }, true),
    taricSync: () => req<{ job: string }>('/api/admin/sync/taric', { method: 'POST' }, true),
    fxManual: (rate: number) => req<any>('/api/admin/fx', { method: 'POST', body: JSON.stringify({ rate }) }, true),
    codes: (body: Record<string, unknown>, file?: File | null) => {
      if (!file) return req<any>('/api/admin/codes', { method: 'POST', body: JSON.stringify(body) }, true);
      const fd = new FormData();
      for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) fd.append(k, String(v));
      fd.append('file', file);
      return req<any>('/api/admin/codes', { method: 'POST', body: fd }, true);
    },
    listCodes: (id: string) => req<any[]>(`/api/admin/codes/${id}`, {}, true),
    deleteCodes: (id: string) => req<any>(`/api/admin/codes/${id}`, { method: 'DELETE' }, true),
    rules: (key: string) => req<{ text: string; file: string }>(`/api/admin/rules/${key}`, {}, true),
    saveRules: (key: string, text: string) => req<any>(`/api/admin/rules/${key}`, { method: 'PUT', body: JSON.stringify({ text }) }, true),
  },
};

const loc = () => (getLang() === 'fr' ? 'fr-CA' : 'en-CA');
export const money = (n: number, cur: string) =>
  new Intl.NumberFormat(loc(), { style: 'currency', currency: cur, currencyDisplay: 'code', maximumFractionDigits: 2 }).format(n || 0);
export const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat(loc(), { maximumFractionDigits: 3 }).format(n)}${getLang() === 'fr' ? '\u00a0' : ''}%`;
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString(loc(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
