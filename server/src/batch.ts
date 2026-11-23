import ExcelJS from 'exceljs';
import type { DB } from './db.js';
import type { Rules } from './rules.js';
import { calculate } from './engine/index.js';
import type { CalcInput, Direction } from './engine/types.js';
import { parseCsv } from './importers/ca-tariff.js';

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
  if (hdrIdx < 0) throw new Error('Aucune colonne de code (HTS / HS / Tarif) trouvée');
  const hdr = rows[hdrIdx].map((c) => String(c ?? '').trim());
  const find = (re: RegExp) => hdr.findIndex((h) => re.test(h));
  const ci = find(/hts|hs\b|hs code|tarif|tariff|code/i);
  const oi = find(/origin|origine|pays|coo|country/i);
  const vi = find(/valeur|value|prix|price|montant|amount|total/i);
  const qi = find(/qt[ée]|qty|quant/i);
  const di = find(/devise|currency|curr/i);
  const pi = find(/usmca|cusma|aceum|pr[ée]f/i);
  const ui = find(/contenu.*(us|é\.-u)|us content/i);
  if (vi < 0) throw new Error('Aucune colonne de valeur trouvée (Valeur / Value / Prix / Montant)');

  const out = new ExcelJS.Workbook();
  const ws = out.addWorksheet('Simulation');
  const added = [
    'Tarif — description',
    'Taux de base',
    'Droit de base',
    'Droits additionnels',
    'Détail des mesures',
    'AD/CVD',
    'Frais',
    'Taxes',
    'Total droits+frais+taxes',
    'Taux effectif droits (%)',
    'Devise',
    'Interdictions',
    'Licences / permis',
    'Alertes',
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
  const buffer = Buffer.from(await out.xlsx.writeBuffer());
  return { buffer, rows: n, errors };
}
