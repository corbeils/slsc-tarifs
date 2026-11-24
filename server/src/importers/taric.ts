/**
 * EU TARIC importer — Excel extractions published monthly by DG TAXUD
 * ("TARIC and Quota data & information" on CIRCABC):
 *   - Nomenclature EN.xlsx                 → lines (j = 'EU')
 *   - Duties Import 01-99.xlsx             → eu_measures (all import measures by origin)
 *   - Geographical area composition.xlsx   → eu_geo (country groups: GSP, EEA, CAMER…)
 *   - Measure exclusions.xlsx              → eu_excl (countries excluded from group measures)
 *   - Additional codes descriptions.xlsx   → eu_addcodes (company codes of AD/CVD measures)
 * The kind of each file is detected from its header row; columns are located by header name,
 * with the documented column order as fallback.
 */
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import type { DB } from '../db.js';
import { digits, setMeta } from '../db.js';

export type TaricKind = 'nomenclature' | 'measures' | 'geo' | 'exclusions' | 'addcodes';
export interface TaricFile {
  name: string;
  buf: Buffer;
}
export interface TaricResult {
  file: string;
  kind: TaricKind | 'unknown';
  rows: number;
  note?: string;
}

const KIND_LABEL: Record<TaricKind, string> = {
  nomenclature: 'Nomenclature',
  measures: 'Import measures (duties)',
  geo: 'Geographical area composition',
  exclusions: 'Measure exclusions',
  addcodes: 'Additional codes',
};

/** Rows of every worksheet of an .xlsx, streamed (the duties file has several hundred thousand rows). */
async function* xlsxRows(buf: Buffer): AsyncGenerator<unknown[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buf), {
    sharedStrings: 'cache',
    worksheets: 'emit',
    hyperlinks: 'ignore',
    styles: 'ignore',
    entries: 'emit',
  });
  for await (const ws of reader) {
    for await (const row of ws as AsyncIterable<ExcelJS.Row>) {
      const vals = (row.values as unknown[]).slice(1).map((v) => {
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
          return o.richText ? o.richText.map((x) => x.text).join('') : o.text ?? o.result ?? '';
        }
        return v;
      });
      yield vals;
    }
  }
}

function csvRows(text: string): unknown[][] {
  const t = text.replace(/^﻿/, '');
  const delim = (t.split('\n')[0].match(/;/g)?.length ?? 0) > (t.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  return t
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '')));
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** Excel serial, Date, dd-mm-yyyy, dd/mm/yyyy or yyyy-mm-dd → yyyy-mm-dd ('' when empty). */
export function taricDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** Goods code cell → 10 digits (+ suffix when the cell holds "8462110010 80"). */
function goods(v: unknown): { code: string; suffix: string } {
  const s = str(v);
  const parts = s.split(/\s+/);
  let d = digits(parts[0]);
  let suffix = parts[1] ? digits(parts[1]) : '';
  if (!suffix && d.length === 12) {
    suffix = d.slice(10);
    d = d.slice(0, 10);
  }
  return { code: d.padEnd(10, '0').slice(0, 10), suffix };
}

export function detectKind(header: string[], name = ''): TaricKind | null {
  const h = header.join(' | ').toLowerCase();
  const n = name.toLowerCase();
  if (/exclu/.test(h) || /exclu/.test(n)) return 'exclusions';
  if (/member/.test(h) || /composition/.test(n)) return 'geo';
  if (/indent|hier/.test(h) || /nomenclature/.test(n)) return 'nomenclature';
  if (/duty|measure type/.test(h) || /dut(y|ies)/.test(n)) return 'measures';
  if (/additional code/.test(h) || /additional code|add_code/.test(n)) return 'addcodes';
  return null;
}

const find = (header: string[], re: RegExp, not?: RegExp) => header.findIndex((x) => re.test(x) && !(not && not.test(x)));

/** Import any set of TARIC extraction files (kinds are detected automatically). */
export async function importTaric(db: DB, files: TaricFile[], log: (m: string) => void = () => {}): Promise<TaricResult[]> {
  const out: TaricResult[] = [];
  const cleared = new Set<TaricKind>();
  const nomen: { code: string; suffix: string; indent: number; description: string; start: string; end: string }[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const f of files) {
    const rows: AsyncIterable<unknown[]> | Iterable<unknown[]> = /\.(csv|txt)$/i.test(f.name) ? csvRows(f.buf.toString('utf8')) : xlsxRows(f.buf);
    let header: string[] | null = null;
    let kind: TaricKind | null = null;
    let n = 0;
    let col: Record<string, number> = {};
    let pending: unknown[][] = [];
    let ins: ((r: unknown[]) => void) | null = null;
    let lang = -1;
    const begin = () => {
      if (!kind) return;
      if (!cleared.has(kind)) {
        cleared.add(kind);
        if (kind === 'measures') db.prepare('DELETE FROM eu_measures').run();
        if (kind === 'geo') db.prepare('DELETE FROM eu_geo').run();
        if (kind === 'exclusions') db.prepare('DELETE FROM eu_excl').run();
        if (kind === 'addcodes') db.prepare('DELETE FROM eu_addcodes').run();
      }
    };
    const setup = (sample: unknown[][]) => {
      const H = header!.map((x) => x.toLowerCase());
      lang = find(H, /lang/);
      if (kind === 'nomenclature') {
        col = {
          goods: Math.max(0, find(H, /goods|commodity|code/, /suffix|start|end/)),
          suffix: find(H, /suffix/),
          start: find(H, /start/, /desc/),
          end: find(H, /end/),
          indent: find(H, /indent/),
          desc: find(H, /desc/, /start|date/),
        };
        if (col.indent < 0) col.indent = 6;
        if (col.desc < 0) col.desc = 7;
        ins = (r) => {
          const g = goods(r[col.goods]);
          if (!/^\d{10}$/.test(g.code)) return;
          if (lang >= 0 && str(r[lang]) && !/^en$/i.test(str(r[lang]))) return;
          const end = col.end >= 0 ? taricDate(r[col.end]) : '';
          if (end && end < today) return;
          nomen.push({
            code: g.code,
            suffix: col.suffix >= 0 ? str(r[col.suffix]) || g.suffix : g.suffix,
            indent: Number(r[col.indent]) || 0,
            description: str(r[col.desc]),
            start: col.start >= 0 ? taricDate(r[col.start]) : '',
            end,
          });
        };
      } else if (kind === 'measures') {
        // Two "origin" and two "measure type" columns: the one with short codes is the code column
        const isCode = (i: number, re: RegExp) => sample.filter((r) => re.test(str(r[i]))).length >= sample.filter((r) => str(r[i])).length * 0.8;
        const originCols = H.map((x, i) => (/origin|geograph|area/.test(x) ? i : -1)).filter((i) => i >= 0);
        const typeCols = H.map((x, i) => (/measure.?type|type/.test(x) && !/origin/.test(x) ? i : -1)).filter((i) => i >= 0);
        const oc = originCols.find((i) => isCode(i, /^[A-Z0-9]{2,4}$/)) ?? 10;
        const tc = typeCols.find((i) => isCode(i, /^[A-Z0-9]{3}$/)) ?? 11;
        col = {
          goods: Math.max(0, find(H, /goods|commodity|nomenclature/)),
          add: find(H, /additional/),
          order: find(H, /order/),
          start: find(H, /start/),
          end: find(H, /end/),
          origin: oc,
          originDesc: originCols.find((i) => i !== oc) ?? 6,
          type: tc,
          typeDesc: typeCols.find((i) => i !== tc) ?? 7,
          legal: find(H, /legal|regulation/),
          duty: find(H, /duty/),
        };
        if (col.add < 0) col.add = 1;
        if (col.order < 0) col.order = 2;
        if (col.start < 0) col.start = 3;
        if (col.end < 0) col.end = 4;
        if (col.legal < 0) col.legal = 8;
        if (col.duty < 0) col.duty = 9;
        const st = db.prepare(
          'INSERT INTO eu_measures (code, add_code, order_no, start, end, origin, origin_desc, type, type_desc, duty, legal) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        );
        ins = (r) => {
          const g = goods(r[col.goods]);
          const type = str(r[col.type]);
          const origin = str(r[col.origin]);
          if (!/^\d{10}$/.test(g.code) || !type || !origin) return;
          const end = taricDate(r[col.end]);
          if (end && end < today) return;
          st.run(g.code, str(r[col.add]), str(r[col.order]), taricDate(r[col.start]), end, origin, str(r[col.originDesc]), type, str(r[col.typeDesc]), str(r[col.duty]), str(r[col.legal]));
        };
      } else if (kind === 'geo') {
        col = {
          grp: Math.max(0, find(H, /group/, /desc|start|end|acronym/)),
          grpDesc: find(H, /group.*desc|desc/),
          member: find(H, /member.*country|country/, /desc/),
          start: find(H, /member.*start|membership.*start/),
          end: find(H, /member.*end|membership.*end/),
        };
        if (col.member < 0) col.member = 6;
        const st = db.prepare('INSERT INTO eu_geo (grp, member, start, end, grp_desc) VALUES (?,?,?,?,?)');
        ins = (r) => {
          if (lang >= 0 && str(r[lang]) && !/^en$/i.test(str(r[lang]))) return;
          const g = str(r[col.grp]);
          const m = str(r[col.member]);
          if (!g || !/^[A-Z]{2}$/.test(m)) return;
          const end = col.end >= 0 ? taricDate(r[col.end]) : '';
          if (end && end < today) return;
          st.run(g, m, col.start >= 0 ? taricDate(r[col.start]) : '', end, col.grpDesc >= 0 ? str(r[col.grpDesc]) : '');
        };
      } else if (kind === 'exclusions') {
        col = {
          goods: Math.max(0, find(H, /goods|commodity/)),
          grp: find(H, /origin|group|geograph/, /desc/),
          type: find(H, /type/, /desc/),
          excl: find(H, /exclu/, /desc/),
        };
        if (col.grp < 0) col.grp = 5;
        if (col.type < 0) col.type = 7;
        if (col.excl < 0) col.excl = 9;
        const st = db.prepare('INSERT INTO eu_excl (code, type, grp, excluded) VALUES (?,?,?,?)');
        ins = (r) => {
          const g = goods(r[col.goods]);
          const x = str(r[col.excl]);
          if (!/^\d{10}$/.test(g.code) || !x) return;
          st.run(g.code, str(r[col.type]), str(r[col.grp]), x);
        };
      } else if (kind === 'addcodes') {
        col = { code: Math.max(0, find(H, /code/, /desc|start|end/)), desc: find(H, /desc/, /start|date/) };
        if (col.desc < 0) col.desc = 2;
        const st = db.prepare('INSERT OR REPLACE INTO eu_addcodes (code, description) VALUES (?,?)');
        ins = (r) => {
          if (lang >= 0 && str(r[lang]) && !/^en$/i.test(str(r[lang]))) return;
          const c = str(r[col.code]);
          if (c) st.run(c, str(r[col.desc]));
        };
      }
    };

    const tx = db.transaction((batch: unknown[][]) => {
      for (const r of batch) ins?.(r);
    });
    let batch: unknown[][] = [];
    for await (const r of rows as AsyncIterable<unknown[]>) {
      if (!header) {
        const cells = r.map(str);
        if (cells.filter(Boolean).length < 3) continue;
        header = cells;
        kind = detectKind(header, f.name);
        if (!kind) break;
        begin();
        continue;
      }
      n++;
      if (!ins) {
        pending.push(r);
        if (pending.length < 60) continue;
        setup(pending);
        batch = pending;
        pending = [];
      } else batch.push(r);
      if (batch.length >= 5000) {
        tx(batch);
        batch = [];
      }
    }
    if (kind && !ins && pending.length) {
      setup(pending);
      batch = pending;
    }
    if (batch.length) tx(batch);
    if (!kind) {
      out.push({ file: f.name, kind: 'unknown', rows: 0, note: `File not recognized as a TARIC extraction (header: ${(header ?? []).slice(0, 6).join(' | ')})` });
      continue;
    }
    log(`${f.name}: ${KIND_LABEL[kind]} — ${n} rows`);
    out.push({ file: f.name, kind, rows: n });
  }

  if (nomen.length) saveNomenclature(db, nomen);
  const counts = {
    lines: (db.prepare("SELECT COUNT(*) n FROM lines WHERE j = 'EU'").get() as { n: number }).n,
    measures: (db.prepare('SELECT COUNT(*) n FROM eu_measures').get() as { n: number }).n,
    groups: (db.prepare('SELECT COUNT(DISTINCT grp) n FROM eu_geo').get() as { n: number }).n,
  };
  if (out.some((r) => r.kind !== 'unknown'))
    setMeta(db, 'import:EU', { at: new Date().toISOString(), source: 'TARIC (DG TAXUD extraction)', count: counts.lines, ...counts, files: out });
  return out;
}

/** Build the EU lines from the nomenclature rows (one line per code; suffix 80 = declarable level). */
function saveNomenclature(db: DB, rows: { code: string; suffix: string; indent: number; description: string }[]) {
  // Keep file order (hierarchical); compute paths from the indentation
  const stack: string[] = [];
  const out: { code: string; display: string; indent: number; description: string; path: string; leaf: boolean }[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ind = r.indent;
    stack.length = Math.max(0, ind);
    const path = stack.filter(Boolean).join(' › ');
    stack[ind] = r.description.replace(/^[-–\s]+/, '');
    const next = rows[i + 1];
    const leaf = !next || next.indent <= ind;
    const isDeclLevel = !r.suffix || r.suffix === '80';
    const prev = seen.get(r.code);
    const entry = {
      code: r.code,
      display: `${r.code.slice(0, 4)}.${r.code.slice(4, 6)}.${r.code.slice(6, 8)}.${r.code.slice(8, 10)}`,
      indent: ind,
      description: r.description.replace(/^[-–\s]+/, ''),
      path,
      leaf: leaf && isDeclLevel,
    };
    if (prev === undefined) {
      seen.set(r.code, out.length);
      out.push(entry);
    } else if (isDeclLevel) out[prev] = entry; // the "80" line wins over the grouping "10" line
  }
  db.transaction(() => {
    db.prepare("DELETE FROM lines WHERE j = 'EU'").run();
    db.prepare("DELETE FROM lines_fts WHERE j = 'EU'").run();
    const ins = db.prepare(
      `INSERT OR REPLACE INTO lines (j, code, display, indent, description, path, units, general, special, other, pref_json, refs, refs_other, notes, rate_from, is_leaf, source)
       VALUES ('EU', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, '', '', '', NULL, ?, 'TARIC')`,
    );
    const fts = db.prepare("INSERT INTO lines_fts (j, code, display, description, path) VALUES ('EU', ?, ?, ?, ?)");
    for (const x of out) {
      ins.run(x.code, x.display, x.indent, x.description, x.path, x.leaf ? 1 : 0);
      fts.run(x.code, x.display, x.description, x.path);
    }
  })();
}

/** Download the TARIC files saved in Admin and import them. */
export async function syncTaricUrls(db: DB, urls: string[], log: (m: string) => void = () => {}) {
  const files: TaricFile[] = [];
  for (const u of urls.filter(Boolean)) {
    log(`Downloading ${u}`);
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
    const name = decodeURIComponent(u.split('/').pop()?.split('?')[0] ?? 'taric.xlsx');
    files.push({ name, buf: Buffer.from(await res.arrayBuffer()) });
  }
  return importTaric(db, files, log);
}
