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
  ];
  const YES = l === 'fr' ? 'oui' : 'yes';
  const NO = l === 'fr' ? 'non' : 'no';
  const rows = [
    [1, T('Closed die forging press'), '8462.11.00.35', 'CA', 250000, 'USD', 1, YES, ''],
    [2, T('Gear box'), '8483.40.50.10', 'CA', 12000, 'USD', 4, YES, ''],
    [3, T('Machined steel part'), '7326.90.86.88', 'CN', 3500, 'USD', 120, NO, ''],
    [4, T('Electric control panel'), '8537.10.91.70', 'MX', 18000, 'USD', 2, YES, 40],
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
    ws.getCell(`D${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`'${T('Countries')}'!$A$2:$A$${countries.length + 1}`], showErrorMessage: true, errorTitle: T('Origin'), error: T('Use a 2-letter ISO code (see the Countries sheet).') };
    ws.getCell(`F${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"USD,CAD"'] };
    ws.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [l === 'fr' ? '"oui,non"' : '"yes,no"'] };
    ws.getCell(`I${r}`).dataValidation = { type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, 100], showErrorMessage: true, error: T('Percentage between 0 and 100') };
  }
  ws.autoFilter = 'A1:I1';

  const help = wb.addWorksheet(T('Instructions'));
  help.columns = [{ width: 20 }, { width: 90 }];
  const lines: [string, string][] = [
    ['SLSC TARIFF SIMULATOR', T('Batch simulation template')],
    ['', ''],
    [T('How to use'), T('Fill the "Parts" sheet (one line per part), then upload the file in Batch simulator. You get the same file back with duties, measures, AD/CVD, licences and warnings.')],
    ['', T('Orange columns are required: HTS, Origin, Value and USMCA (otherwise the "Claim USMCA" box of the page applies).')],
    ['', ''],
    [T('Item / Description'), T('Free text, copied to the result.')],
    ['HTS', T('INBOUND USA: HTSUS code (10 digits recommended, e.g. 8462.11.00.35). INBOUND CANADA: Canadian tariff item (e.g. 8462.11.00).')],
    [T('Origin'), T('Country of origin, 2-letter ISO code (CA, US, MX, CN, DE…). See the Countries sheet.')],
    [T('Value'), T('Customs value of the line.')],
    [T('Currency'), T('USD or CAD. Empty = USD for INBOUND USA, CAD for INBOUND CANADA.')],
    [T('Qty'), T('Quantity (kg or units) — used only for specific rates (¢/kg, $/unit).')],
    ['USMCA', T('yes / no — claim USMCA (INBOUND USA) or CUSMA (INBOUND CANADA) preferential treatment.')],
    [T('US content %'), T('U.S. content as % of value — for Section 232 programs calculated on non-U.S. content (USMCA vehicles, Annex I-C).')],
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
 * Mode lot : un fichier XLSX/CSV (liste de pièces) en entrée, le même fichier enrichi en sortie.
 * Colonnes reconnues : code HTS/HS, origine, valeur, quantité, devise, préférence (oui/non), contenu US %.
 */
export async function runBatch(
  db: DB,
  rules: Rules,
  buf: Buffer,
  filename: string,
  defaults: { direction: Direction; origin: string; currency: 'USD' | 'CAD'; preferential: boolean; province?: string; mode?: CalcInput['mode'] },
  l: Lang = 'en',
): Promise<{ buffer: Buffer; rows: number; errors: number }> {
  const T = (x: string) => withLang(l, () => t(x));
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
    const res = calculate(db, rules, input, l);
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
