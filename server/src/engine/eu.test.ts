import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db.js';
import { loadRules, type Rules } from '../rules.js';
import { calculate } from './index.js';
import { parseEuDuty } from './eu.js';
import { importTaric } from '../importers/taric.js';

async function xlsx(header: string[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(header);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('parseEuDuty', () => {
  it('ad valorem, specific, MAX and conditions', () => {
    expect(parseEuDuty('12.000 %').adValorem).toBe(12);
    const m = parseEuDuty('6.700 % MAX 35.150 EUR DTN');
    expect(m.adValorem).toBe(6.7);
    expect(m.specific[0]).toMatchObject({ per: 'kg', kind: 'max' });
    expect(m.specific[0].amount).toBeCloseTo(0.3515);
    expect(parseEuDuty('0.000 % + 3.800 EUR DTN').specific[0].kind).toBe('add');
    expect(parseEuDuty('Cond: A cert: D-008 (01):0.000 % ; A (08):28.400 %').complex).toBe(true);
  });
});

describe('INBOUND EU (TARIC)', () => {
  let db: DB;
  let rules: Rules;
  beforeAll(async () => {
    db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eu-')), 't.sqlite'));
    rules = loadRules(path.resolve(__dirname, '../../../rules'));
    const nomen = await xlsx(
      ['Goods code', 'Product line suffix', 'Start date', 'End date', 'Language', 'Hier. Pos.', 'Indent', 'Description', 'Descr. start date'],
      [
        ['8462000000', '80', '01-01-2024', '', 'EN', 4, 0, 'Machine tools for working metal by forging', '01-01-2024'],
        ['8462110000', '10', '01-01-2024', '', 'EN', 6, 1, '- Hot forming machines', '01-01-2024'],
        ['8462110010', '80', '01-01-2024', '', 'EN', 10, 2, '- - Closed die forging machines', '01-01-2024'],
        ['8462110090', '80', '01-01-2024', '', 'EN', 10, 2, '- - Other', '01-01-2024'],
      ],
    );
    const duties = await xlsx(
      ['Goods code', 'Additional code', 'Order No.', 'Start date', 'End date', 'Red. Ind.', 'Origin', 'Measure type', 'Legal base', 'Duty', 'Origin code', 'Meas. type code'],
      [
        ['8462000000', '', '', '01-01-2024', '', '', 'ERGA OMNES', 'Third country duty', 'R2658/87', '2.700 %', '1011', '103'],
        ['8462110000', '', '', '01-01-2024', '', '', 'Canada', 'Tariff preference', 'D0038/17', '0.000 %', 'CA', '142'],
        ['8462110000', '', '', '01-01-2024', '', '', 'GSP - General arrangements', 'Tariff preference', 'R0978/12', '0.000 %', '2020', '142'],
        ['8462110010', 'C999', '', '01-01-2025', '', '', 'China', 'Definitive anti-dumping duty', 'R2025/0001', '35.000 %', 'CN', '552'],
        ['8462110010', 'C123', '', '01-01-2025', '', '', 'China', 'Definitive anti-dumping duty', 'R2025/0001', '20.000 %', 'CN', '552'],
        ['8462000000', '', '', '01-01-2025', '', '', 'United States of America', 'Additional duties', 'R2025/0002', '25.000 %', 'US', '695'],
        ['8462110000', '', '094001', '01-01-2025', '', '', 'Canada', 'Preferential tariff quota', 'D0038/17', '0.000 %', 'CA', '143'],
        ['8462000000', '', '', '01-01-2025', '', '', 'ERGA OMNES', 'Import control', 'R2025/0003', '', '1011', '710'],
        ['8462000000', '', '', '01-01-2020', '31-12-2020', '', 'ERGA OMNES', 'Third country duty', 'old', '9.000 %', '1011', '103'],
      ],
    );
    const geo = await xlsx(
      ['Group code', 'Group start date', 'Language', 'Group acronym', 'Group description', 'Member code', 'Member country code', 'Member description', 'Membership start', 'Membership end', 'Group end date'],
      [
        ['2020', '01-01-2014', 'EN', 'SPGA', 'GSP - General arrangements', '1', 'IN', 'India', '01-01-2014', '', ''],
        ['2020', '01-01-2014', 'EN', 'SPGA', 'GSP - General arrangements', '2', 'BD', 'Bangladesh', '01-01-2014', '', ''],
      ],
    );
    const res = await importTaric(db, [
      { name: 'Nomenclature EN.xlsx', buf: nomen },
      { name: 'Duties Import 01-99.xlsx', buf: duties },
      { name: 'Geographical area composition.xlsx', buf: geo },
    ]);
    expect(res.map((r) => r.kind)).toEqual(['nomenclature', 'measures', 'geo']);
  });

  const calc = (o: Record<string, unknown>) =>
    calculate(db, rules, { direction: 'IN-EU', code: '8462110010', origin: 'CA', value: 10000, currency: 'EUR', memberState: 'FR', ...o } as never);

  it('third-country duty on the CIF value and French VAT', () => {
    const r = calc({ freight: 500 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(10500);
    const base = r.lines.find((l) => l.key === 'base')!;
    expect(base.rateText).toBe('2.700 %');
    expect(base.amount).toBe(283.5);
    const vat = r.lines.find((l) => l.key === 'vat')!;
    expect(vat.ratePct).toBe(20);
    expect(vat.amount).toBe(2156.7);
    expect(r.flags.licences.some((f) => /Import control/.test(f.title))).toBe(true);
  });

  it('lists the agreements of the line; CETA claimed → 0 %', () => {
    const r0 = calc({});
    expect(r0.agreements.find((a) => a.code === 'CA')).toMatchObject({ applicable: 'yes', short: 'CETA' });
    expect(r0.agreements.find((a) => a.code === '2020')?.applicable).toBe('no');
    expect(r0.preferential.claimed).toBe(false);
    const r = calc({ preferential: true, agreement: 'CA' });
    expect(r.lines.find((l) => l.key === 'base')!.amount).toBe(0);
  });

  it('GSP preference applies to a member of the group (India)', () => {
    const r = calc({ origin: 'IN' });
    expect(r.agreements.find((a) => a.code === '2020')?.applicable).toBe('yes');
  });

  it('tariff quota offered as an option', () => {
    const r = calc({});
    expect(r.options.some((o) => o.key === 'quota:094001')).toBe(true);
  });

  it('anti-dumping: flagged, "all other companies" rate when included', () => {
    const r = calc({ origin: 'CN', includeAdcvd: true });
    expect(r.flags.adcvd.length).toBe(1);
    expect(r.lines.find((l) => l.kind === 'adcvd')!.amount).toBe(3500);
    const r2 = calc({ origin: 'CN', includeAdcvd: true, adcvdCompany: 'C123' });
    expect(r2.lines.find((l) => l.kind === 'adcvd')!.amount).toBe(2000);
  });

  it('additional duties by origin (countermeasures on U.S. goods)', () => {
    const r = calc({ origin: 'US' });
    expect(r.lines.find((l) => l.program === '695')!.amount).toBe(2500);
    expect(calc({}).lines.some((l) => l.program === '695')).toBe(false);
  });

  it('nomenclature: path and leaf', () => {
    const l = db.prepare("SELECT * FROM lines WHERE j = 'EU' AND code = '8462110010'").get() as { is_leaf: number; path: string };
    expect(l.is_leaf).toBe(1);
    expect(l.path).toContain('Hot forming machines');
  });
});
