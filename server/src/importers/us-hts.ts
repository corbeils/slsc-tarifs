import fs from 'node:fs';
import type { DB } from '../db.js';
import { digits, setMeta } from '../db.js';
import { config } from '../config.js';
import { detectCountries } from '../countries.js';
import { extractChapter99Refs, parseCh99Additional, parseUsSpecial } from '../engine/rates.js';
import { clearListCache } from '../engine/common.js';

/** Enregistrement tel que renvoyé par hts.usitc.gov/reststop (exportList / search). */
export interface UsitcRecord {
  htsno: string;
  statisticalSuffix?: string;
  description: string;
  indent: string | number;
  footnotes?: { columns?: string[]; marker?: string; value: string; type?: string }[];
  units?: string[] | null;
  general?: string | null;
  special?: string | null;
  other?: string | null;
  quotaQuantity?: string | null;
  additionalDuties?: string | null;
}

const CHAPTERS = Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0')).filter((c) => c !== '77');

async function fetchJson(url: string, tries = 3): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'slsc-tarifs/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

export async function fetchUsitc(
  onProgress?: (msg: string) => void,
  chapters = CHAPTERS,
): Promise<UsitcRecord[]> {
  const all: UsitcRecord[] = [];
  for (const cc of chapters) {
    const url = `${config.usitcBase}/exportList?from=${cc}01&to=${cc}99&format=JSON&styles=false`;
    const data = (await fetchJson(url)) as UsitcRecord[];
    if (!Array.isArray(data)) throw new Error(`Réponse inattendue pour le chapitre ${cc}`);
    all.push(...data);
    onProgress?.(`Chapitre ${cc} : ${data.length} lignes`);
  }
  return all;
}

const clean = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Importe (remplace) le tarif américain. Gère :
 *  - la hiérarchie par indentation (chemin de description)
 *  - l'héritage des taux de la ligne 8 chiffres vers les lignes statistiques 10 chiffres
 *  - l'héritage des renvois au ch. 99 (notes de bas de page) des niveaux supérieurs
 *  - le registre des rubriques 9903 (taux additionnel analysé dans la colonne « General »)
 */
export function importUsRecords(db: DB, records: UsitcRecord[], source: string) {
  const stack: string[] = [];
  type Rated = { code: string; general: string; special: string; other: string };
  const rated = new Map<string, Rated>();
  const refsBy = new Map<string, { g: string[]; o: string[]; notes: string[] }>();
  const out: {
    code: string;
    display: string;
    indent: number;
    description: string;
    path: string;
    units: string | null;
    general: string;
    special: string;
    other: string;
    pref: string;
    refs: string;
    refsOther: string;
    notes: string;
    rateFrom: string | null;
  }[] = [];
  const ch99: { code: string; display: string; description: string; general: string }[] = [];

  for (const r of records) {
    const indent = Number(r.indent ?? 0) || 0;
    const desc = clean(r.description);
    stack.length = indent;
    const pathStr = stack.filter(Boolean).join(' › ');
    stack[indent] = desc;
    const display = clean(r.htsno);
    if (!display) continue;
    const code = digits(display);
    if (!code) continue;

    const g = clean(r.general);
    const s = clean(r.special);
    const o = clean(r.other);

    // Renvois : propres + hérités des ancêtres
    const own = { g: [] as string[], o: [] as string[], notes: [] as string[] };
    for (const f of r.footnotes ?? []) {
      const v = clean(f.value);
      if (!v) continue;
      own.notes.push(v);
      const refs = extractChapter99Refs(v);
      const cols = f.columns ?? ['general'];
      if (cols.includes('other')) own.o.push(...refs);
      if (cols.includes('general') || cols.includes('special') || cols.length === 0) own.g.push(...refs);
    }
    if (r.additionalDuties) own.g.push(...extractChapter99Refs(clean(r.additionalDuties)));
    const inherited = { g: [] as string[], o: [] as string[], notes: [] as string[] };
    for (const len of [4, 6, 8]) {
      if (code.length <= len) continue;
      const anc = refsBy.get(code.slice(0, len));
      if (anc) {
        inherited.g.push(...anc.g);
        inherited.o.push(...anc.o);
        inherited.notes.push(...anc.notes);
      }
    }
    const merged = {
      g: [...new Set([...inherited.g, ...own.g])],
      o: [...new Set([...inherited.o, ...own.o])],
      notes: [...new Set([...inherited.notes, ...own.notes])],
    };
    refsBy.set(code, merged);

    // Taux : propres ou hérités (ligne 8 chiffres -> 10 chiffres)
    let rate: Rated | undefined;
    if (g || s || o) {
      rate = { code, general: g, special: s, other: o };
      rated.set(code, rate);
    } else {
      for (const len of [8, 6, 4]) {
        if (code.length > len && rated.get(code.slice(0, len))) {
          rate = rated.get(code.slice(0, len));
          break;
        }
      }
    }
    const pref = rate ? parseUsSpecial(rate.special) : {};
    out.push({
      code,
      display,
      indent,
      description: desc,
      path: pathStr,
      units: r.units && r.units.length ? r.units.join(', ') : null,
      general: rate?.general ?? '',
      special: rate?.special ?? '',
      other: rate?.other ?? '',
      pref: JSON.stringify(pref),
      refs: merged.g.join(','),
      refsOther: merged.o.join(','),
      notes: merged.notes.join(' | '),
      rateFrom: rate?.code ?? null,
    });
    if (code.startsWith('9903') && code.length >= 8) ch99.push({ code: display.slice(0, 10), display, description: desc, general: g });
  }

  // Feuilles : une ligne est terminale si aucune autre ne la prolonge
  const codes = out.map((x) => x.code).sort();
  const leaf = new Set<string>();
  for (let i = 0; i < codes.length; i++) if (!(codes[i + 1] && codes[i + 1].startsWith(codes[i]))) leaf.add(codes[i]);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lines WHERE j = 'US'").run();
    db.prepare("DELETE FROM lines_fts WHERE j = 'US'").run();
    db.prepare('DELETE FROM ch99').run();
    const ins = db.prepare(`INSERT OR REPLACE INTO lines
      (j, code, display, indent, description, path, units, general, special, other, pref_json, refs, refs_other, notes, rate_from, is_leaf, source)
      VALUES ('US', @code, @display, @indent, @description, @path, @units, @general, @special, @other, @pref, @refs, @refsOther, @notes, @rateFrom, @leaf, @source)`);
    const fts = db.prepare("INSERT INTO lines_fts (j, code, display, description, path) VALUES ('US', ?, ?, ?, ?)");
    for (const x of out) {
      ins.run({ ...x, leaf: leaf.has(x.code) ? 1 : 0, source });
      fts.run(x.code, x.display, x.description, x.path);
    }
    const insC = db.prepare(
      'INSERT OR REPLACE INTO ch99 (code, display, description, general, add_pct, kind, countries, except_countries) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of ch99) {
      const { addPct, kind } = parseCh99Additional(c.general);
      const { countries, except } = countriesFromHeading(c.description);
      insC.run(c.code, c.display, c.description, c.general, addPct, kind, JSON.stringify(countries), JSON.stringify(except));
    }
  });
  tx();
  clearListCache();
  setMeta(db, 'import:US', { at: new Date().toISOString(), source, count: out.length, ch99: ch99.length });
  return { lines: out.length, ch99: ch99.length };
}

/**
 * Détecte les pays visés par une rubrique du ch. 99 :
 * "...articles the product of Canada..." / "...except products of the United Kingdom..."
 */
export function countriesFromHeading(desc: string): { countries: string[]; except: string[] } {
  const d = desc.replace(/\s+/g, ' ');
  const except: string[] = [];
  const exceptRe = /except(?:ing)?\s+(?:for\s+)?(?:goods|articles|products)?\s*(?:that are\s+)?(?:the\s+)?products?\s+of\s+([^;.:]+)/gi;
  let rest = d;
  for (const m of d.matchAll(exceptRe)) {
    except.push(...detectCountries(m[1]));
    rest = rest.replace(m[0], ' ');
  }
  const countries: string[] = [];
  const re = /(?:product|products|goods|articles)\s+of\s+([^;.:]+)/gi;
  for (const m of rest.matchAll(re)) {
    // éviter "products of heading 9903..." ou "products of chapter 72"
    if (/^(heading|chapter|subheading|the united states-mexico)/i.test(m[1].trim())) continue;
    countries.push(...detectCountries(m[1].split(/,?\s+(?:that|which|as provided|entered|classified|provided)\b/i)[0]));
  }
  return { countries: [...new Set(countries)], except: [...new Set(except)] };
}

export function importUsFile(db: DB, file: string, source = 'fichier USITC') {
  const records = JSON.parse(fs.readFileSync(file, 'utf8')) as UsitcRecord[];
  return importUsRecords(db, records, source);
}

export async function importUsOnline(db: DB, onProgress?: (m: string) => void) {
  const records = await fetchUsitc(onProgress);
  return importUsRecords(db, records, `USITC REST (${new Date().toISOString().slice(0, 10)})`);
}
