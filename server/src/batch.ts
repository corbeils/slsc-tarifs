import ExcelJS from 'exceljs';
import type { DB } from './db.js';
import type { Rules } from './rules.js';
import { calculate } from './engine/index.js';
import type { CalcInput, Direction } from './engine/types.js';
import { parseCsv } from './importers/ca-tariff.js';

/** Excel template for the batch simulation (data sheet + instructions + country codes). */
export async function buildTemplate(countries: { code: string; en: string }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SLSC TARIFF SIMULATOR';
  const ws = wb.addWorksheet('Parts', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Item', key: 'item', width: 8 },
    { header: 'Description', key: 'desc', width: 34 },
    { header: 'HTS', key: 'hts', width: 16 },
    { header: 'Origin', key: 'origin', width: 9 },
    { header: 'Value', key: 'value', width: 14 },
    { header: 'Currency', key: 'cur', width: 10 },
    { header: 'Qty', key: 'qty', width: 9 },
    { header: 'USMCA', key: 'pref', width: 9 },
    { header: 'US content %', key: 'us', width: 13 },
  ];
  const rows = [
    [1, 'Closed die forging press', '8462.11.00.35', 'CA', 250000, 'USD', 1, 'yes', ''],
    [2, 'Gear box', '8483.40.50.10', 'CA', 12000, 'USD', 4, 'yes', ''],
    [3, 'Machined steel part', '7326.90.86.88', 'CN', 3500, 'USD', 120, 'no', ''],
    [4, 'Electric control panel', '8537.10.91.70', 'MX', 18000, 'USD', 2, 'yes', 40],
  ];
  rows.forEach((r) => ws.addRow(r));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12263F' } };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  ['C', 'D', 'E', 'H'].forEach((c) => (ws.getCell(`${c}1`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF08A3C' } }));
  ws.getColumn('value').numFmt = '#,##0.00';
  ws.getColumn('hts').numFmt = '@';
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`C${r}`).numFmt = '@';
    ws.getCell(`D${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['Countries!$A$2:$A$' + (countries.length + 1)], showErrorMessage: true, errorTitle: 'Origin', error: 'Use a 2-letter ISO code (see the Countries sheet).' };
    ws.getCell(`F${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"USD,CAD"'] };
    ws.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"yes,no"'] };
    ws.getCell(`I${r}`).dataValidation = { type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, 100], showErrorMessage: true, error: 'Percentage between 0 and 100' };
  }
  ws.autoFilter = 'A1:I1';

  const help = wb.addWorksheet('Instructions');
  help.columns = [{ width: 20 }, { width: 90 }];
  const lines: [string, string][] = [
    ['SLSC TARIFF SIMULATOR', 'Batch simulation template'],
    ['', ''],
    ['How to use', 'Fill the "Parts" sheet (one line per part), then upload the file in Excel batch. You get the same file back with duties, measures, AD/CVD, licences and warnings.'],
    ['', 'Orange columns are required: HTS, Origin (or the default origin chosen on the page), Value, USMCA (or the default).'],
    ['', ''],
    ['Item / Description', 'Free text, copied to the result.'],
    ['HTS', 'INBOUND USA: HTSUS code (10 digits recommended, e.g. 8462.11.00.35). INBOUND CANADA: Canadian tariff item (e.g. 8462.11.00).'],
    ['Origin', 'Country of origin, 2-letter ISO code (CA, US, MX, CN, DE…). See the Countries sheet.'],
    ['Value', 'Customs value of the line.'],
    ['Currency', 'USD or CAD. Empty = default currency chosen on the page.'],
    ['Qty', 'Quantity (kg or units) — used only for specific rates (¢/kg, $/unit).'],
    ['USMCA', 'yes / no — claim USMCA (INBOUND USA) or CUSMA (INBOUND CANADA) preferential treatment.'],
    ['US content %', 'U.S. content as % of value — for Section 232 programs calculated on non-U.S. content (USMCA vehicles, Annex I-C).'],
    ['', ''],
    ['Notice', 'For informational purposes only, offer without warranty. Tariff rates change frequently.'],
  ];
  lines.forEach((l) => help.addRow(l));
  help.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF12263F' } };
  help.getColumn(1).font = { bold: true };
  help.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const cs = wb.addWorksheet('Countries');
  cs.columns = [
    { header: 'Code', width: 8 },
    { header: 'Country', width: 50 },
  ];
  countries.forEach((c) => cs.addRow([c.code, c.en]));
  cs.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
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
  defaults: { direction: Direction; origin: string; currency: 'USD' | 'CAD'; preferential: boolean; province?: string; mode?: CalcInput['mode'] },
): Promise<{ buffer: Buffer; rows: number; errors: number }> {
  let rows: unknown[][];
  if (/\.(csv|txt)$/i.test(filename)) {
    const t = buf.toString('utf8').replace(/^﻿/, '');
    rows = parseCsv(t, t.split(';').length > t.split(',').length ? ';' : ',');
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    rows = [];
    ws.eachRow({ includeEmpty: false }, (r) =>
      rows.push(
        (r.values as unknown[]).slice(1).map((v) => {
          if (v && typeof v === 'object') {
            const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
            return o.richText ? o.richText.map((x) => x.text).join('') : o.text ?? o.result ?? '';
          }
          return v;
        }),
      ),
    );
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
  if (vi < 0) throw new Error('No value column found (Value / Price / Amount)');

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet('Simulation');
  const added = [
    'Tariff — description',
    'Base rate',
    'Base duty',
    'Additional duties',
    'Measures detail',
    'AD/CVD',
    'Fees',
    'Taxes',
    'Total duties+fees+taxes',
    'Effective duty rate (%)',
    'Currency',
    'Prohibitions',
    'Licences / permits',
    'Warnings',
  ];
  ws.addRow([...hdr, ...added]);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  let n = 0;
  let errors = 0;
  for (const r of rows.slice(hdrIdx + 1)) {
    const code = String(r[ci] ?? '').trim();
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
      mode: defaults.mode,
      quantities: qi >= 0 && num(r[qi]) ? { kg: num(r[qi]), 'no.': num(r[qi]) } : undefined,
    };
    const res = calculate(db, rules, input);
    if (!res.ok) {
      errors++;
      ws.addRow([...hdr.map((_, i) => r[i] ?? ''), res.error]);
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
  return { buffer, rows: n, errors };
}
