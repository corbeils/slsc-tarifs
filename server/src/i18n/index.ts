/**
 * Server-side translation (EN source strings → FR).
 * The engine runs synchronously, so the current language is a module-level value set by withLang().
 */
import type { Rules } from '../rules.js';
import { FR } from './fr.js';

export type Lang = 'en' | 'fr';
let current: Lang = 'en';

export const lang = (): Lang => current;
export const asLang = (v: unknown): Lang => (String(v ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en');

export function withLang<T>(l: Lang, fn: () => T): T {
  const prev = current;
  current = l;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** Translate an English string; {name} placeholders are filled from vars. Unknown strings fall back to English. */
export function t(en: string, vars?: Record<string, string | number | undefined | null>): string {
  const s = current === 'fr' ? FR[en] ?? en : en;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? fmtVar(vars[k]) : m));
}

function fmtVar(v: string | number | undefined | null): string {
  if (typeof v === 'number') return current === 'fr' ? v.toLocaleString('fr-CA', { maximumFractionDigits: 4 }) : String(v);
  return String(v ?? '');
}

/** Translate a free-form string from the rules or the engine (exact match only). */
export function tx(s: string | undefined): string | undefined {
  if (s === undefined || current === 'en') return s;
  return FR[s] ?? FR[s.trim()] ?? s;
}

export const TEXT_KEYS = new Set(['name', 'label', 'note', 'description', 'title', 'detail', 'context', 'warning', 'product', 'text', 'intro']);

function deep<T>(o: T, key?: string): T {
  if (typeof o === 'string') return (key && TEXT_KEYS.has(key) ? FR[o] ?? o : o) as T;
  if (Array.isArray(o)) return o.map((x) => deep(x, key)) as T;
  if (o && typeof o === 'object') {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) r[k] = deep(v, k);
    return r as T;
  }
  return o;
}

const cache = new WeakMap<object, Rules>();
/** Rules with their descriptive texts translated (cached per rules object). */
export function localizeRules(rules: Rules, l: Lang = current): Rules {
  if (l === 'en') return rules;
  let r = cache.get(rules);
  if (!r) {
    r = deep(rules);
    cache.set(rules, r);
  }
  return r;
}
