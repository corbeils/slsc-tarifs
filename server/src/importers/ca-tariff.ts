import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { DB } from '../db.js';
import { digits, formatCode, setMeta } from '../db.js';
import { parseCaPreferential } from '../engine/rates.js';
import { clearListCache } from '../engine/common.js';

/**
 * Importateur du Tarif des douanes (ASFC). Robuste aux formats :
 *  - Excel CARM (à partir du 1er déc. 2026), Excel/CSV antérieurs, export manuel
 *  - une colonne « tarifs préférentiels applicables » en texte (UST, MXT: Free …)
 *  - OU une colonne par traitement (UST, MXT, CEUT, CPTPT, …)
 * Les colonnes sont reconnues par leur en-tête (anglais ou français).
 */

const TREATMENTS = [
  'UST', 'MXT', 'MUST', 'CIAT', 'CT', 'CRT', 'IT', 'NT', 'SLT', 'PT', 'COLT', 'JT', 'PAT', 'HNT', 'KRT', 'CEUT', 'UAT',
  'CPTPT', 'UKT', 'CPUKT', 'GPT', 'LDCT', 'CCCT', 'AUT', 'NZT',
];

type Col = { idx: number; name: string };
interface Mapping {
  code?: Col;
  ss?: Col;
  desc: Col[];
  uom?: Col;
  mfn?: Col;
  general?: Col;
  pref?: Col;
  treatments: Col[];
  headerRow: number;
}

function norm(h: unknown): string {
  return String(h ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectMapping(rows: unknown[][]): Mapping | null {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const hdr = rows[r].map(norm);
    const m: Mapping = { desc: [], treatments: [], headerRow: r };
    hdr.forEach((h, idx) => {
      const l = h.toLowerCase();
      if (!h) return;
      if (!m.code && /(tariff\s*(item|no|number|code)?$|^tariff$|num[ée]ro\s*tarifaire|^code$|hs\s*code|^classification)/i.test(l)) m.code = { idx, name: h };
      else if (!m.ss && /(^ss$|stat.*suffix|suffixe|^stat)/i.test(l)) m.ss = { idx, name: h };
      else if (/(desc|libell|d[ée]signation|description)/i.test(l)) m.desc.push({ idx, name: h });
      else if (!m.uom && /(uom|unit|unit[ée])/i.test(l)) m.uom = { idx, name: h };
      else if (!m.mfn && /(mfn|npf|most.favou?red|nation la plus)/i.test(l)) m.mfn = { idx, name: h };
      else if (!m.general && /(general tariff|tarif g[ée]n[ée]ral|^gt$)/i.test(l)) m.general = { idx, name: h };
      else if (!m.pref && /(preferential|pr[ée]f[ée]rentiel)/i.test(l)) m.pref = { idx, name: h };
      else if (TREATMENTS.includes(h.toUpperCase().replace(/[^A-Z]/g, ''))) m.treatments.push({ idx, name: h.toUpperCase().replace(/[^A-Z]/g, '') });
    });
    if (m.code && (m.mfn || m.pref || m.treatments.length)) return m;
  }
  return null;
}

async function readRows(file: string): Promise<unknown[][]> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const delim = ext === '.tsv' || (text.split('\t').length > text.split(',').length && !text.includes(';')) ? '\t' : text.split(';').length > text.split(',').length ? ';' : ',';
    return parseCsv(text, delim);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  // feuille la plus volumineuse
  const ws = [...wb.worksheets].sort((a, b) => b.rowCount - a.rowCount)[0];
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as unknown[]).slice(1).map((v) => {
      if (v && typeof v === 'object') {
        const o = v as { text?: string; richText?: { text: string }[]; result?: unknown };
        if (o.richText) return o.richText.map((t) => t.text).join('');
        if (o.text) return o.text;
        if (o.result !== undefined) return o.result;
      }
      return v;
    });
    rows.push(vals);
  });
  return rows;
}

export function parseCsv(text: string, delim = ','): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

function rateCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v > 0 && v < 1 ? `${Math.round(v * 10000) / 100}%` : `${v}%`;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return `${s}%`;
  if (/^(free|en franchise)$/i.test(s)) return 'Free';
  return s;
}

export async function importCaFile(db: DB, file: string, source = path.basename(file)) {
  const rows = await readRows(file);
  const m = detectMapping(rows);
  if (!m)
    throw new Error(
      'Headers not recognized: at least a "Tariff Item" column and an "MFN" or "Preferential" column are required.',
    );
  return importCaRows(db, rows, m, source);
}

export function importCaRows(db: DB, rows: unknown[][], m: Mapping, source: string) {
  type Out = {
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
    rateFrom: string | null;
  };
  const out = new Map<string, Out>();
  const descByCode = new Map<string, string>();
  const stack: string[] = [];
  for (let r = m.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const rawCode = norm(row[m.code!.idx]);
    let code = digits(rawCode);
    const descRaw = m.desc.map((c) => norm(row[c.idx])).filter(Boolean).join(' ');
    // indentation par tirets en tête de description ("- -Autres")
    const dash = descRaw.match(/^((?:-\s*)+)/);
    const indent = dash ? dash[1].replace(/\s/g, '').length : 0;
    const desc = descRaw.replace(/^((?:-\s*)+)/, '').trim();
    if (!code) {
      if (desc) {
        stack.length = indent;
        stack[indent] = desc;
      }
      continue;
    }
    if (m.ss) {
      const ss = digits(norm(row[m.ss.idx]));
      if (ss && code.length === 8) code = code + ss.padStart(2, '0');
    }
    if (code.length < 4) continue;
    stack.length = indent;
    const pathStr = [...stack.filter(Boolean)].join(' › ');
    stack[indent] = desc;
    descByCode.set(code, desc);

    const mfn = m.mfn ? rateCell(row[m.mfn.idx]) : '';
    const general = m.general ? rateCell(row[m.general.idx]) : '';
    const prefText = m.pref ? norm(row[m.pref.idx]) : '';
    const prefMap = parseCaPreferential(prefText);
    for (const t of m.treatments) {
      const v = rateCell(row[t.idx]);
      if (v) prefMap[t.name] = v;
    }
    const prev = out.get(code);
    // Plusieurs lignes par code (descriptions sur plusieurs rangées) : fusionner
    if (prev) {
      if (desc && !prev.description.includes(desc)) prev.description = (prev.description + ' ' + desc).trim();
      if (!prev.general && mfn) prev.general = mfn;
      const pm = JSON.parse(prev.pref || '{}');
      Object.assign(pm, prefMap);
      prev.pref = JSON.stringify(pm);
      if (prefText) prev.special = (prev.special + ' ' + prefText).trim();
      continue;
    }
    out.set(code, {
      code,
      display: formatCode(code),
      indent,
      description: desc,
      path: pathStr,
      units: m.uom ? norm(row[m.uom.idx]) || null : null,
      general: mfn,
      special: prefText,
      other: general,
      pref: JSON.stringify(prefMap),
      rateFrom: mfn || prefText ? code : null,
    });
  }
  // héritage des taux pour les suffixes statistiques et chemins des titres de positions
  const all = [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
  const byCode = new Map(all.map((x) => [x.code, x]));
  for (const x of all) {
    if (!x.general && x.pref === '{}') {
      for (const len of [8, 6, 4]) {
        const p = byCode.get(x.code.slice(0, len));
        if (x.code.length > len && p && (p.general || p.pref !== '{}')) {
          x.general = p.general;
          x.pref = p.pref;
          x.special = p.special;
          x.other = p.other;
          x.rateFrom = p.code;
          break;
        }
      }
    }
    if (!x.path) {
      const parents = [4, 6].map((l) => (x.code.length > l ? byCode.get(x.code.slice(0, l))?.description : undefined)).filter(Boolean);
      x.path = parents.join(' › ');
    }
  }
  const codes = all.map((x) => x.code);
  const leaf = new Set<string>();
  for (let i = 0; i < codes.length; i++) if (!(codes[i + 1] && codes[i + 1].startsWith(codes[i]))) leaf.add(codes[i]);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lines WHERE j = 'CA'").run();
    db.prepare("DELETE FROM lines_fts WHERE j = 'CA'").run();
    const ins = db.prepare(`INSERT OR REPLACE INTO lines
      (j, code, display, indent, description, path, units, general, special, other, pref_json, refs, refs_other, notes, rate_from, is_leaf, source)
      VALUES ('CA', @code, @display, @indent, @description, @path, @units, @general, @special, @other, @pref, '', '', '', @rateFrom, @leaf, @source)`);
    const fts = db.prepare("INSERT INTO lines_fts (j, code, display, description, path) VALUES ('CA', ?, ?, ?, ?)");
    for (const x of all) {
      ins.run({ ...x, leaf: leaf.has(x.code) ? 1 : 0, source });
      fts.run(x.code, x.display, x.description, x.path);
    }
  });
  tx();
  clearListCache();
  setMeta(db, 'import:CA', { at: new Date().toISOString(), source, count: all.length });
  return { lines: all.length, mapping: describeMapping(m) };
}

function describeMapping(m: Mapping) {
  return {
    code: m.code?.name,
    ss: m.ss?.name,
    description: m.desc.map((d) => d.name),
    uom: m.uom?.name,
    mfn: m.mfn?.name,
    general: m.general?.name,
    preferential: m.pref?.name,
    treatments: m.treatments.map((t) => t.name),
  };
}

export async function importCaUrl(db: DB, url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = /\.csv(\?|$)/i.test(url) ? '.csv' : '.xlsx';
  const tmp = path.join(process.env.TMPDIR ?? '/tmp', `ca-tariff-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, buf);
  try {
    return await importCaFile(db, tmp, url);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
