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
  const results: { id: string; label: string; codes?: number; error?: string }[] = [];
  const cache = new Map<string, string>();
  for (const p of rules.us.programs) {
    for (const l of p.lists ?? []) {
      if (!l.sources?.length) continue;
      try {
        const all = new Map<string, ExtractedCode>();
        for (const s of l.sources) {
          if (!cache.has(s.url)) {
            log(`Downloading ${s.url}`);
            cache.set(s.url, await fetchText(s.url));
          }
          const text = section(cache.get(s.url)!, s.from, s.until);
          for (const c of validateCodes(db, 'US', extractCodes(text, false, { headings: true }))) all.set(c.code, c);
        }
        if (all.size === 0) throw new Error('no tariff numbers found in the source');
        saveCodeList(db, l.id, [...all.values()], { replace: true, source: l.sources.map((s) => s.url).join(' + ') });
        log(`${l.label}: ${all.size} codes`);
        results.push({ id: l.id, label: l.label, codes: all.size });
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
