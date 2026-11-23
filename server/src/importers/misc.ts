import type { DB } from '../db.js';
import { digits, setMeta } from '../db.js';
import { config } from '../config.js';
import { clearListCache } from '../engine/common.js';
import { parseCsv } from './ca-tariff.js';

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
 * Extrait tous les numéros tarifaires d'un texte collé (ou d'une page HTML).
 * Formats reconnus : 7208.10.00 | 7208.10.00.10 | 7208.10 | 72081000 | 7208100010.
 * Si `withRates`, le premier pourcentage trouvé sur la même ligne est associé au code.
 */
export function extractCodes(text: string, withRates = false): ExtractedCode[] {
  const out = new Map<string, number | null>();
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.replace(/‑/g, '-');
    const codes: string[] = [];
    for (const m of line.matchAll(/\b(\d{4}\.\d{2}(?:\.\d{2}){0,2})\b/g)) codes.push(digits(m[1]));
    for (const m of line.matchAll(/(?<![\d.])(\d{8}|\d{10})(?![\d.])/g)) codes.push(m[1]);
    if (!codes.length) continue;
    let rate: number | null = null;
    if (withRates) {
      const r = line.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
      if (r) rate = Number(r[1].replace(',', '.'));
    }
    for (const c of codes) if (!out.has(c)) out.set(c, rate);
  }
  return [...out.entries()].map(([code, rate]) => ({ code, rate }));
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
  const res = await fetch(url, { headers: { 'User-Agent': 'slsc-tarifs/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${url}`);
  const t = await res.text();
  return /<html|<table|<body/i.test(t) ? htmlToText(t) : t;
}

// ---------------------------------------------------------------------------
// Taux de change USD/CAD — Banque du Canada (API Valet)
// ---------------------------------------------------------------------------
export async function importFx(db: DB) {
  const res = await fetch(config.fxUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} (Banque du Canada)`);
  const j = (await res.json()) as { observations: { d: string; FXUSDCAD?: { v: string } }[] };
  const obs = j.observations?.at(-1);
  const rate = Number(obs?.FXUSDCAD?.v);
  if (!rate) throw new Error('Taux FXUSDCAD absent de la réponse');
  const v = { rate, date: obs!.d, source: 'Banque du Canada (Valet FXUSDCAD)' };
  setMeta(db, 'fx:USDCAD', v);
  return v;
}

export function setFxManual(db: DB, rate: number) {
  const v = { rate, date: new Date().toISOString().slice(0, 10), source: 'saisi dans Admin' };
  setMeta(db, 'fx:USDCAD', v);
  return v;
}

// ---------------------------------------------------------------------------
// Indicateurs PGA (CBP ACE) — CSV/XLSX « HTS ; Flag »
// ---------------------------------------------------------------------------
export function importPgaCsv(db: DB, text: string) {
  const rows = parseCsv(text.replace(/^﻿/, ''), text.includes(';') && !text.includes(',') ? ';' : ',');
  const hdr = rows[0].map((h) => h.toLowerCase());
  const ci = hdr.findIndex((h) => /hts|tariff/.test(h));
  const fi = hdr.findIndex((h) => /flag|indicator|indicateur/.test(h));
  if (ci < 0 || fi < 0) throw new Error('Colonnes attendues : HTS et Flag');
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
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n: string) => hdr.indexOf(n);
  const need = ['j', 'case', 'country', 'prefixes'];
  for (const n of need) if (col(n) < 0) throw new Error(`Colonne manquante : ${n}`);
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
