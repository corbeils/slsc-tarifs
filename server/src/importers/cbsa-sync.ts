import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { DB } from '../db.js';
import { getMeta, setMeta } from '../db.js';
import { config } from '../config.js';
import { importCaFile } from './ca-tariff.js';

/**
 * CBSA has no Customs Tariff API. This module discovers the machine-readable
 * Customs Tariff file (CARM-generated Excel from Dec. 2026, or CSV/ZIP) on the
 * CBSA website, downloads it only when it changed, and imports it.
 */

const FILE_RE = /\.(xlsx|xls|csv|zip)(\?.*)?$/i;

export interface SyncStatus {
  at: string;
  ok: boolean;
  message: string;
  fileUrl?: string;
  pagesScanned?: number;
  candidates?: string[];
  imported?: boolean;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'slsc-tariff-simulator/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      out.add(new URL(m[1].replace(/&amp;/g, '&'), base).toString());
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

/** Ranks candidate files: English complete schedule, newest year / amendment first. */
export function scoreFile(url: string): number {
  const f = decodeURIComponent(url.split('/').pop() ?? '').toLowerCase();
  let s = 0;
  const ext = f.match(/\.(xlsx|xls|csv|zip)/)?.[1];
  s += ext === 'xlsx' ? 40 : ext === 'csv' ? 35 : ext === 'zip' ? 30 : 10;
  if (/-eng|_eng|english/.test(f)) s += 20;
  if (/-fra|_fra|french/.test(f)) s -= 30;
  if (/01-99|complete|complet|tariff|tarif|schedule/.test(f)) s += 15;
  if (/concordance|deleted|supprim/.test(f)) s -= 50;
  const year = Math.max(0, ...[...url.matchAll(/(20\d{2})/g)].map((m) => Number(m[1])));
  s += (year - 2000) * 10;
  const amend = f.match(/20\d{2}-(\d{1,2})(?:-|\.|_)/);
  if (amend) s += Number(amend[1]);
  return s;
}

export async function discover(base = config.cbsaBase): Promise<{ files: string[]; pages: number }> {
  const y = new Date().getFullYear();
  const roots = [
    `${base}/trade-commerce/tariff-tarif/menu-eng.html`,
    `${base}/trade-commerce/tariff-tarif/${y}/menu-eng.html`,
    `${base}/trade-commerce/tariff-tarif/${y + 1}/menu-eng.html`,
    `${base}/trade-commerce/tariff-tarif/${y}/html/tblmod-eng.html`,
  ];
  const seen = new Set<string>();
  const files = new Set<string>();
  let queue = roots.map((u) => ({ u, d: 0 }));
  let pages = 0;
  while (queue.length && pages < 30) {
    const { u, d } = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    let html: string;
    try {
      html = await fetchText(u);
    } catch {
      continue;
    }
    pages++;
    for (const l of extractLinks(html, u)) {
      if (!l.includes('/tariff-tarif/')) continue;
      if (FILE_RE.test(l)) files.add(l);
      else if (d < 2 && /\.html?(\?.*)?$/i.test(l) && /-eng\.html/i.test(l) && !seen.has(l)) queue.push({ u: l, d: d + 1 });
    }
  }
  return { files: [...files].sort((a, b) => scoreFile(b) - scoreFile(a)), pages };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'slsc-tariff-simulator/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Writes the tariff file to a temp path (extracting the largest xlsx/csv from a ZIP). */
function materialize(url: string, buf: Buffer): string {
  const tmp = path.join(os.tmpdir(), `cbsa-${Date.now()}`);
  if (/\.zip(\?|$)/i.test(url)) {
    const entries = Object.entries(unzipSync(new Uint8Array(buf))).filter(([n]) => /\.(xlsx|csv)$/i.test(n) && !/fra|french/i.test(n));
    if (!entries.length) throw new Error('No XLSX/CSV file inside the ZIP');
    const [name, data] = entries.sort((a, b) => b[1].length - a[1].length)[0];
    const p = tmp + path.extname(name).toLowerCase();
    fs.writeFileSync(p, data);
    return p;
  }
  const ext = url.match(/\.(xlsx|xls|csv)/i)?.[1]?.toLowerCase() ?? 'xlsx';
  const p = `${tmp}.${ext}`;
  fs.writeFileSync(p, buf);
  return p;
}

export async function syncCbsa(db: DB, opts: { force?: boolean; log?: (m: string) => void } = {}): Promise<SyncStatus> {
  const log = opts.log ?? (() => {});
  const finish = (s: Omit<SyncStatus, 'at'>) => {
    const st = { at: new Date().toISOString(), ...s };
    setMeta(db, 'cbsa:sync', st);
    return st;
  };
  try {
    let fileUrl = config.caTariffUrl;
    let pages = 0;
    let candidates: string[] = [];
    if (!fileUrl) {
      log('Scanning the CBSA Customs Tariff pages…');
      const d = await discover();
      pages = d.pages;
      candidates = d.files.slice(0, 10);
      log(`${d.pages} pages scanned, ${d.files.length} data file(s) found`);
      if (!d.files.length)
        return finish({
          ok: true,
          message:
            d.pages === 0
              ? 'CBSA website unreachable'
              : 'No Excel/CSV tariff file published yet (CBSA currently publishes PDFs only; CARM Excel files are expected from the Dec. 2026 amendment). Will retry automatically.',
          pagesScanned: pages,
          candidates,
          imported: false,
        });
      fileUrl = d.files[0];
    }
    log(`Downloading ${fileUrl}`);
    const buf = await download(fileUrl);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const prev = getMeta<{ hash: string; url: string }>(db, 'cbsa:file');
    if (!opts.force && prev?.hash === hash) {
      return finish({ ok: true, message: 'Already up to date (file unchanged)', fileUrl, pagesScanned: pages, candidates, imported: false });
    }
    const p = materialize(fileUrl, buf);
    try {
      const r = await importCaFile(db, p, `CBSA ${decodeURIComponent(fileUrl.split('/').pop() ?? '')}`);
      setMeta(db, 'cbsa:file', { hash, url: fileUrl });
      log(`Imported ${r.lines} lines`);
      return finish({ ok: true, message: `Imported ${r.lines} lines`, fileUrl, pagesScanned: pages, candidates, imported: true });
    } finally {
      fs.rmSync(p, { force: true });
    }
  } catch (e) {
    return finish({ ok: false, message: (e as Error).message });
  }
}
