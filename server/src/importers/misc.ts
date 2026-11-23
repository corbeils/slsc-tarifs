import type { DB } from '../db.js';
import { digits, setMeta } from '../db.js';
import { config } from '../config.js';
import { clearListCache } from '../engine/common.js';
import ExcelJS from 'exceljs';
import { getDocumentProxy } from 'unpdf';
import { parseCsv } from './ca-tariff.js';

/** Converts an uploaded CSV / TSV / TXT / XLSX file into delimited text (one row per line). */
export async function fileToText(buf: Buffer, filename: string): Promise<string> {
  if (/\.pdf$/i.test(filename)) return pdfToText(buf);
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const lines: string[] = [];
    for (const ws of wb.worksheets)
      ws.eachRow({ includeEmpty: false }, (r) =>
        lines.push(
          (r.values as unknown[])
            .slice(1)
            .map((v) => {
              if (v && typeof v === 'object') {
                const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
                return o.richText ? o.richText.map((x) => x.text).join('') : String(o.text ?? o.result ?? '');
              }
              return v === null || v === undefined ? '' : String(v);
            })
            .map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
            .join(','),
        ),
      );
    return lines.join('\n');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function detectDelim(text: string): string {
  const first = text.split(/\r?\n/)[0] ?? '';
  const counts = { ',': first.split(',').length, ';': first.split(';').length, '\t': first.split('\t').length };
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as string;
}

// ---------------------------------------------------------------------------
// Listes de codes (annexes de décrets, proclamations, avis des douanes…)
// ---------------------------------------------------------------------------

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(tr|p|li|div|h\d|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' \t ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8209;|&#x2011;/g, '-')
    .replace(/[  ]+/g, ' ');
}

export interface ExtractedCode {
  code: string;
  rate: number | null;
}

/**
 * Extracts every tariff number from pasted text, a web page or a PDF.
 * Formats: 7208.10.00 | 7208.10.00.10 | 8207.20.0070 | 7208.10 | 72081000 | 7208100010
 * and, with `headings`, 4-digit headings at the start of a line ("7206  Iron and nonalloy steel…").
 * Chapter 99 numbers are ignored. With `withRates`, the first percentage on the same line is kept.
 */
export function extractCodes(text: string, withRates = false, opts: { headings?: boolean } = {}): ExtractedCode[] {
  const out = new Map<string, number | null>();
  const re = /(?<![\d.])(\d{4}\.\d{2}\.\d{2}\.\d{2}|\d{4}\.\d{2}\.\d{4}|\d{4}\.\d{2}\.\d{2}|\d{4}\.\d{2}|\d{10}|\d{8})(?![\d])/g;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/‑/g, '-');
    const codes: string[] = [];
    for (const m of line.matchAll(re)) codes.push(digits(m[1]));
    if (opts.headings) {
      const h = line.match(/^\s*(\d{4})(?=\s|$)(?!\s*[-–]\s*\d)/);
      if (h && Number(h[1]) >= 101 && Number(h[1]) <= 9799) codes.push(h[1]);
    }
    if (!codes.length) continue;
    let rate: number | null = null;
    if (withRates) {
      const r = line.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
      if (r) rate = Number(r[1].replace(',', '.'));
    }
    for (const c of codes) if (!c.startsWith('99') && !out.has(c)) out.set(c, rate);
  }
  return [...out.entries()].map(([code, rate]) => ({ code, rate }));
}

/** Keeps only codes that exist in the imported tariff (filters page numbers, years, etc.). */
export function validateCodes(db: DB, j: 'US' | 'CA', codes: ExtractedCode[]): ExtractedCode[] {
  const n = (db.prepare('SELECT COUNT(*) n FROM lines WHERE j = ?').get(j) as { n: number }).n;
  if (n < 1000) return codes; // demo data only: cannot validate
  const q = db.prepare('SELECT 1 FROM lines WHERE j = ? AND code LIKE ? LIMIT 1');
  return codes.filter((c) => q.get(j, c.code + '%') || q.get(j, c.code.slice(0, 8) + '%'));
}

/** Text between two markers (case-insensitive, whitespace-tolerant). */
export function section(text: string, from?: string, until?: string): string {
  const rx = (m: string) => new RegExp(m.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
  let t = text;
  if (from) {
    const m = t.match(rx(from));
    if (!m || m.index === undefined) throw new Error(`Marker not found: ${from}`);
    t = t.slice(m.index + m[0].length);
  }
  if (until) {
    const m = t.match(rx(until));
    if (m && m.index !== undefined) t = t.slice(0, m.index);
  }
  return t;
}

/** PDF → text, one line per visual line. */
export async function pdfToText(buf: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const lines: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let cur = '';
    let lastY: number | null = null;
    for (const it of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = it.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2 && cur.trim()) {
        lines.push(cur);
        cur = '';
      }
      cur += (cur && !cur.endsWith(' ') ? ' ' : '') + it.str;
      lastY = y;
      if (it.hasEOL) {
        lines.push(cur);
        cur = '';
        lastY = null;
      }
    }
    if (cur.trim()) lines.push(cur);
  }
  return lines.join('\n');
}

export function saveCodeList(
  db: DB,
  measureId: string,
  codes: ExtractedCode[],
  opts: { replace?: boolean; source?: string; rate?: number | null } = {},
) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    if (opts.replace) db.prepare('DELETE FROM code_lists WHERE measure_id = ?').run(measureId);
    const ins = db.prepare(
      'INSERT OR REPLACE INTO code_lists (measure_id, code, rate, source, added_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const c of codes) ins.run(measureId, c.code, opts.rate ?? c.rate, opts.source ?? '', now);
  });
  tx();
  clearListCache();
  const n = (db.prepare('SELECT COUNT(*) n FROM code_lists WHERE measure_id = ?').get(measureId) as { n: number }).n;
  return { added: codes.length, total: n };
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (slsc-tariff-simulator)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (/pdf/i.test(res.headers.get('content-type') ?? '') || /\.pdf(\?|$)/i.test(url)) return pdfToText(Buffer.from(await res.arrayBuffer()));
  const t = await res.text();
  return /<html|<table|<body/i.test(t) ? htmlToText(t) : t;
}

// ---------------------------------------------------------------------------
// Taux de change USD/CAD — Banque du Canada (API Valet)
// ---------------------------------------------------------------------------
export async function importFx(db: DB) {
  const res = await fetch(config.fxUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} (Bank of Canada)`);
  const j = (await res.json()) as { observations: { d: string; FXUSDCAD?: { v: string } }[] };
  const obs = j.observations?.at(-1);
  const rate = Number(obs?.FXUSDCAD?.v);
  if (!rate) throw new Error('FXUSDCAD rate missing from response');
  const v = { rate, date: obs!.d, source: 'Bank of Canada (Valet FXUSDCAD)' };
  setMeta(db, 'fx:USDCAD', v);
  return v;
}

export function setFxManual(db: DB, rate: number) {
  const v = { rate, date: new Date().toISOString().slice(0, 10), source: 'entered in Admin' };
  setMeta(db, 'fx:USDCAD', v);
  return v;
}

// ---------------------------------------------------------------------------
// Indicateurs PGA (CBP ACE) — CSV/XLSX « HTS ; Flag »
// ---------------------------------------------------------------------------
export function importPgaCsv(db: DB, text: string) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = parseCsv(clean, detectDelim(clean));
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const ci = hdr.findIndex((h) => /hts|tariff|code/.test(h));
  const fi = hdr.findIndex((h) => /flag|indicator|indicateur|pga/.test(h));
  if (ci < 0 || fi < 0) throw new Error(`Expected two columns "HTS" and "Flag" — found: ${rows[0].join(' | ')}`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM pga_flags').run();
    const ins = db.prepare('INSERT OR IGNORE INTO pga_flags (code, flag) VALUES (?, ?)');
    for (const r of rows.slice(1)) {
      const c = digits(r[ci] ?? '');
      for (const f of String(r[fi] ?? '').split(/[\s,;|]+/).filter(Boolean)) if (c) ins.run(c, f.trim().toUpperCase());
    }
  });
  tx();
  const n = (db.prepare('SELECT COUNT(*) n FROM pga_flags').get() as { n: number }).n;
  setMeta(db, 'import:PGA', { at: new Date().toISOString(), count: n });
  return { count: n };
}

// ---------------------------------------------------------------------------
// Dossiers AD/CVD et LMSI supplémentaires — CSV
// colonnes : j, case, product, country, prefixes (séparés par ;), ad, cvd, note, url
// ---------------------------------------------------------------------------
export function importAdcvdCsv(db: DB, text: string) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = parseCsv(clean, detectDelim(clean));
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n: string) => hdr.indexOf(n);
  const need = ['j', 'case', 'country', 'prefixes'];
  for (const n of need) if (col(n) < 0) throw new Error(`Missing column: ${n}`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM adcvd_import').run();
    const ins = db.prepare(
      'INSERT OR REPLACE INTO adcvd_import (j, case_no, product, country, prefixes, ad_rate, cvd_rate, note, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows.slice(1)) {
      if (!r[col('case')]) continue;
      const num = (n: string) => (col(n) >= 0 && r[col(n)] ? Number(String(r[col(n)]).replace(',', '.')) : null);
      ins.run(
        String(r[col('j')]).toUpperCase(),
        r[col('case')],
        col('product') >= 0 ? r[col('product')] : '',
        String(r[col('country')]).toUpperCase(),
        r[col('prefixes')],
        num('ad'),
        num('cvd'),
        col('note') >= 0 ? r[col('note')] : '',
        col('url') >= 0 ? r[col('url')] : '',
      );
    }
  });
  tx();
  return { count: (db.prepare('SELECT COUNT(*) n FROM adcvd_import').get() as { n: number }).n };
}
