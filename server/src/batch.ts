import ExcelJS from 'exceljs';
import type { DB } from './db.js';
import type { Rules } from './rules.js';
import { calculate } from './engine/index.js';
import type { CalcInput, Direction } from './engine/types.js';
import { parseCsv } from './importers/ca-tariff.js';
import { t, withLang, type Lang } from './i18n/index.js';

/** Excel template for the batch simulation (data sheet + instructions + country codes). */
export async function buildTemplate(countries: { code: string; en: string; fr?: string }[], l: Lang = 'en'): Promise<Buffer> {
  const T = (x: string) => withLang(l, () => t(x));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SLSC TARIFF SIMULATOR';
  const ws = wb.addWorksheet(T('Parts'), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: T('Item'), key: 'item', width: 8 },
    { header: T('Description'), key: 'desc', width: 34 },
    { header: 'HTS', key: 'hts', width: 16 },
    { header: T('Origin'), key: 'origin', width: 9 },
    { header: T('Value'), key: 'value', width: 14 },
    { header: T('Currency'), key: 'cur', width: 10 },
    { header: T('Qty'), key: 'qty', width: 9 },
    { header: 'USMCA', key: 'pref', width: 9 },
    { header: T('US content %'), key: 'us', width: 13 },
    { header: T('Freight (EU)'), key: 'fr', width: 13 },
    { header: T('Insurance (EU)'), key: 'ins', width: 14 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12263F' } };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  ['C', 'D', 'E'].forEach((c) => (ws.getCell(`${c}1`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF08A3C' } }));
  ws.getColumn('value').numFmt = '#,##0.00';
  ws.getColumn('hts').numFmt = '@';
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`C${r}`).numFmt = '@';
    ws.getCell(`D${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`'${T('Countries')}'!$A$2:$A$${countries.length + 1}`], showErrorMessage: true, errorTitle: T('Origin'), error: T('Use a 2-letter ISO code (see the Countries sheet).') };
    ws.getCell(`F${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"USD,CAD,EUR"'] };
    ws.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [l === 'fr' ? '"oui,non"' : '"yes,no"'] };
    ws.getCell(`I${r}`).dataValidation = { type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, 100], showErrorMessage: true, error: T('Percentage between 0 and 100') };
  }
  ws.autoFilter = 'A1:K1';

  const help = wb.addWorksheet(T('Instructions'));
  help.columns = [{ width: 20 }, { width: 90 }];
  const lines: [string, string][] = [
    ['SLSC TARIFF SIMULATOR', T('Batch simulation template')],
    ['', ''],
    [T('How to use'), T('Fill the "Parts" sheet (one line per part), then upload the file in Batch simulator. You get the same file back with duties, measures, AD/CVD, licences and warnings.')],
    ['', T('Orange columns are required: HTS, Origin and Value. USMCA: yes to claim the preference (empty = not claimed).')],
    ['', ''],
    [T('Item / Description'), T('Free text, copied to the result.')],
    ['HTS', T('INBOUND USA: HTSUS code (10 digits recommended, e.g. 8462.11.00.35). INBOUND CANADA: Canadian tariff item (e.g. 8462.11.00).')],
    [T('Origin'), T('Country of origin, 2-letter ISO code (CA, US, MX, CN, DE…). See the Countries sheet.')],
    [T('Value'), T('Customs value of the line.')],
    [T('Currency'), T('USD, CAD or EUR. Empty = USD for INBOUND USA, CAD for INBOUND CANADA, EUR for INBOUND EU.')],
    [T('Qty'), T('Quantity (kg or units) — used only for specific rates (¢/kg, $/unit).')],
    ['USMCA', T('yes / no — claim USMCA (INBOUND USA) or CUSMA (INBOUND CANADA) preferential treatment.')],
    [T('US content %'), T('U.S. content as % of value — for Section 232 programs calculated on non-U.S. content (USMCA vehicles, Annex I-C).')],
    [T('Freight (EU) / Insurance (EU)'), T('INBOUND EU only: international freight and insurance to the EU border, added to the value (CIF customs value).')],
    ['', ''],
    [T('Notice'), T('For informational purposes only, offer without warranty. Tariff rates change frequently.')],
  ];
  lines.forEach((l) => help.addRow(l));
  help.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF12263F' } };
  help.getColumn(1).font = { bold: true };
  help.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const cs = wb.addWorksheet(T('Countries'));
  cs.columns = [
    { header: 'Code', width: 8 },
    { header: T('Country'), width: 50 },
  ];
  countries.forEach((c) => cs.addRow([c.code, l === 'fr' ? c.fr ?? c.en : c.en]));
  cs.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Tariff number from a spreadsheet cell. Excel turns codes typed in a General cell into numbers:
 * 8483.40 → 8483.4 (trailing zero lost), 0402.10 → 402.1 (leading zero lost), 0402100000 → 402100000.
 */
export function cellToCode(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    const [int, frac = ''] = String(v).split('.');
    const i = int.length % 2 ? '0' + int : int; // headings and full codes have an even number of digits
    if (!frac) return i;
    const head = i.padStart(4, '0');
    return `${head}.${frac.length % 2 ? frac + '0' : frac}`;
  }
  return String(v).trim();
}

/**
 * Mode lot : un fichier XLSX/CSV (liste de pièces) en entrée, le même fichier enrichi en sortie.
 * Colonnes reconnues : code HTS/HS, origine, valeur, quantité, devise, préférence (oui/non), contenu US %.
 */
export async function runBatch(
  db: DB,
  rules: Rules,
  buf: Buffer,
  filename: string,
  defaults: { direction: Direction; origin: string; currency: 'USD' | 'CAD' | 'EUR'; preferential: boolean; province?: string; memberState?: string; mode?: CalcInput['mode'] },
  l: Lang = 'en',
): Promise<{ buffer: Buffer; rows: number; errors: number; errorList: { row: number; code: string; error: string }[] }> {
  const T = (x: string) => withLang(l, () => t(x));
  let rows: unknown[][];
  let rowNums: number[] = [];
  if (/\.(csv|txt)$/i.test(filename)) {
    const t = buf.toString('utf8').replace(/^﻿/, '');
    rows = parseCsv(t, t.split(';').length > t.split(',').length ? ';' : ',');
    rowNums = rows.map((_, i) => i + 1);
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      rowNums.push(r.number);
      rows.push(
        (r.values as unknown[]).slice(1).map((v) => {
          if (v && typeof v === 'object') {
            const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
            return o.richText ? o.richText.map((x) => x.text).join('') : o.text ?? o.result ?? '';
          }
          return v;
        }),
      );
    });
  }
  const hdrIdx = rows.findIndex((r) => r.some((c) => /hts|hs\b|tarif|code/i.test(String(c ?? ''))));
  if (hdrIdx < 0) throw new Error('No code column found (HTS / HS / Tariff)');
  const hdr = rows[hdrIdx].map((c) => String(c ?? '').trim());
  const find = (re: RegExp) => hdr.findIndex((h) => re.test(h));
  const ci = find(/hts|hs\b|hs code|tarif|tariff|code/i);
  const oi = find(/origin|origine|pays|coo|country/i);
  const vi = find(/valeur|value|prix|price|montant|amount|total/i);
  const qi = find(/qt[ée]|qty|quant/i);
  const di = find(/devise|currency|curr/i);
  const pi = find(/usmca|cusma|aceum|pr[ée]f/i);
  const ui = find(/contenu.*(us|é\.-u)|us content/i);
  const fi = find(/freight|fret/i);
  const ii = find(/insurance|assurance/i);
  if (vi < 0) throw new Error('No value column found (Value / Price / Amount)');

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet(T('Simulation'));
  const added = [
    T('Tariff — description'),
    T('Base rate'),
    T('Base duty'),
    T('Additional duties'),
    T('Measures detail'),
    'AD/CVD',
    T('Fees'),
    T('Taxes'),
    T('Total duties+fees+taxes'),
    T('Effective duty rate (%)'),
    T('Currency'),
    T('Prohibitions'),
    T('Licences / permits'),
    T('Warnings'),
  ];
  ws.addRow([...hdr, ...added]);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  let n = 0;
  let errors = 0;
  const errorList: { row: number; code: string; error: string }[] = [];
  let idx = hdrIdx;
  for (const r of rows.slice(hdrIdx + 1)) {
    const rowNo = rowNums[++idx] ?? idx + 1;
    const code = cellToCode(r[ci]);
    if (!code) continue;
    n++;
    const num = (v: unknown) => Number(String(v ?? '').replace(/[\s$]/g, '').replace(',', '.'));
    const prefCell = pi >= 0 ? String(r[pi] ?? '').trim().toLowerCase() : '';
    const input: CalcInput = {
      direction: defaults.direction,
      code,
      origin: (oi >= 0 && String(r[oi] ?? '').trim().toUpperCase().slice(0, 2)) || defaults.origin,
      value: num(r[vi]) || 0,
      currency: ((di >= 0 && String(r[di] ?? '').trim().toUpperCase()) || defaults.currency) as 'USD' | 'CAD',
      preferential: pi >= 0 ? /^(o|y|oui|yes|1|x|true|vrai)/.test(prefCell) : defaults.preferential,
      usContentPct: ui >= 0 ? num(r[ui]) || undefined : undefined,
      province: defaults.province,
      memberState: defaults.memberState,
      freight: fi >= 0 ? num(r[fi]) || 0 : 0,
      insurance: ii >= 0 ? num(r[ii]) || 0 : 0,
      mode: defaults.mode,
      quantities: qi >= 0 && num(r[qi]) ? { kg: num(r[qi]), 'no.': num(r[qi]) } : undefined,
    };
    const res = calculate(db, rules, input, l);
    if (!res.ok) {
      errors++;
      const row = ws.addRow([...hdr.map((_, i) => r[i] ?? ''), `${T('ERROR')}: ${res.error}`]);
      row.getCell(hdr.length + 1).font = { bold: true, color: { argb: 'FFC0392B' } };
      if (errorList.length < 20) errorList.push({ row: rowNo, code, error: res.error ?? '' });
      continue;
    }
    const base = res.lines.find((l) => l.kind === 'base');
    const adds = res.lines.filter((l) => l.kind === 'additional' && l.amount > 0);
    ws.addRow([
      ...hdr.map((_, i) => r[i] ?? ''),
      `${res.line?.display} — ${res.line?.description}`,
      base?.rateText ?? '',
      base?.amount ?? 0,
      adds.reduce((a, l) => a + l.amount, 0),
      adds.map((l) => `${l.label}${l.ch99 ? ' ' + l.ch99 : ''} ${l.ratePct ?? ''}%`).join(' ; '),
      res.flags.adcvd.length ? res.flags.adcvd.map((f) => f.title).join(' ; ') : '',
      res.totals.fees,
      res.totals.taxes,
      res.totals.total,
      res.totals.dutyPct,
      res.currency,
      res.flags.bans.map((f) => f.title).join(' ; '),
      res.flags.licences.filter((f) => f.level !== 'info').map((f) => `${f.agency}: ${f.title}`).join(' ; '),
      res.flags.warnings.map((f) => f.title).join(' ; '),
    ]);
  }
  ws.columns.forEach((c) => (c.width = 18));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const firstNew = hdr.length + 1;
  for (const off of [2, 3, 6, 7, 8]) ws.getColumn(firstNew + off).numFmt = '#,##0.00';
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: hdr.length + added.length } };
  const buffer = Buffer.from(await out.xlsx.writeBuffer());
  return { buffer, rows: n, errors, errorList };
}
