import type { DB } from '../db.js';
import { setMeta } from '../db.js';
import type { Rules } from '../rules.js';
import { extractCodes, fetchText, saveCodeList, section, validateCodes, type ExtractedCode } from './misc.js';

/**
 * Imports every program list that declares official `sources` (proclamation annex PDFs, etc.):
 * downloads each document, keeps the section between the markers, extracts the tariff numbers,
 * validates them against the imported tariff and replaces the list.
 */
export async function syncOfficialLists(db: DB, rules: Rules, log: (m: string) => void = () => {}) {
  const results: { id: string; label: string; codes?: number; detail?: string; error?: string }[] = [];
  const cache = new Map<string, string>();
  type Target = { id: string; label: string; j: 'US' | 'CA'; sources: { url: string; from?: string; until?: string; rates?: string }[] };
  const targets: Target[] = [
    ...rules.us.programs.flatMap((p) => (p.lists ?? []).map((l) => ({ id: l.id, label: l.label, j: 'US' as const, sources: l.sources ?? [] }))),
    ...rules.us.measures.map((m) => ({ id: m.id, label: m.name, j: 'US' as const, sources: m.sources ?? [] })),
    ...rules.ca.measures.map((m) => ({ id: m.id, label: m.name, j: 'CA' as const, sources: m.sources ?? [] })),
  ].filter((t) => t.sources.length);
  {
    for (const l of targets) {
      try {
        const all = new Map<string, ExtractedCode>();
        for (const s of l.sources) {
          if (!cache.has(s.url)) {
            log(`Downloading ${s.url}`);
            cache.set(s.url, await fetchText(s.url));
          }
          const text = section(cache.get(s.url)!, s.from, s.until);
          const found = extractCodes(text, false, { headings: !s.rates, lastCellRate: s.rates === 'lastCell' });
          for (const c of validateCodes(db, l.j, found)) {
            const prev = all.get(c.code);
            if (!prev || (c.rate ?? 0) > (prev.rate ?? 0)) all.set(c.code, c);
          }
        }
        if (all.size === 0) throw new Error('no tariff numbers found in the source');
        saveCodeList(db, l.id, [...all.values()], { replace: true, source: l.sources.map((s) => s.url).join(' + ') });
        const byRate = new Map<string, number>();
        for (const c of all.values()) if (c.rate !== null) byRate.set(`${c.rate}%`, (byRate.get(`${c.rate}%`) ?? 0) + 1);
        const detail = [...byRate.entries()].map(([r, n]) => `${n} at ${r}`).join(', ');
        log(`${l.label}: ${all.size} codes${detail ? ` (${detail})` : ''}`);
        results.push({ id: l.id, label: l.label, codes: all.size, detail });
      } catch (e) {
        log(`${l.label}: ERROR ${(e as Error).message}`);
        results.push({ id: l.id, label: l.label, error: (e as Error).message });
      }
    }
  }
  const status = { at: new Date().toISOString(), ok: results.every((r) => !r.error), results };
  setMeta(db, 'lists:sync', status);
  return status;
}
