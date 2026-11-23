import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeDuty, parseCaPreferential, parseCh99Additional, parseRate, parseUsSpecial } from './rates.js';
import { countriesFromHeading } from '../importers/us-hts.js';
import { extractCodes, htmlToText, saveCodeList } from '../importers/misc.js';
import { openDb, type DB } from '../db.js';
import { loadRules, type Rules } from '../rules.js';
import { calculate } from './index.js';
import { ensureSeed } from '../seed.js';
import { importUsRecords } from '../importers/us-hts.js';

describe('parseRate', () => {
  it('Free / pourcentage / spécifique / composé', () => {
    expect(parseRate('Free').free).toBe(true);
    expect(parseRate('4.4%').adValorem).toBe(4.4);
    const s = parseRate('2.2¢/kg');
    expect(s.specific[0]).toMatchObject({ amount: 0.022, per: 'kg', kind: 'add' });
    const c = parseRate('6.4¢/kg + 2.8%');
    expect(c.adValorem).toBe(2.8);
    expect(c.specific[0].amount).toBeCloseTo(0.064);
    expect(parseRate('$2.27/pf. liter').specific[0].per).toBe('pf.liter');
  });
  it('« but not less than » (tarif canadien hors engagement)', () => {
    const r = parseRate('245.5% but not less than $4.52/kg');
    expect(r.adValorem).toBe(245.5);
    expect(r.specific[0]).toMatchObject({ amount: 4.52, per: 'kg', kind: 'min' });
    // 1000 kg à 1 000 $ : 245,5 % = 2 455 $ < minimum 4 520 $
    expect(computeDuty(r, 1000, { kg: 1000 }).amount).toBe(4520);
    expect(computeDuty(r, 10000, { kg: 1000 }).amount).toBe(24550);
  });
  it('signale les taux non interprétables', () => {
    expect(parseRate('A duty upon the value of such repairs or alterations').complex).toBe(true);
    expect(parseRate('0%').free).toBe(true);
  });
});

describe('colonnes préférentielles', () => {
  it('colonne Special HTSUS', () => {
    const m = parseUsSpecial('Free (A+,AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,S,SG) 3.4% (JP)');
    expect(m.S).toBe('Free');
    expect(m.JP).toBe('3.4%');
  });
  it('tarifs préférentiels canadiens', () => {
    const m = parseCaPreferential('UST, MXT, CIAT: Free GPT: 6% CPTPT: 1.1%');
    expect(m).toMatchObject({ UST: 'Free', MXT: 'Free', CIAT: 'Free', GPT: '6%', CPTPT: '1.1%' });
  });
});

describe('chapitre 99', () => {
  it('taux additionnel et exemption', () => {
    expect(parseCh99Additional('The duty provided in the applicable subheading + 25%')).toEqual({ addPct: 25, kind: 'duty' });
    expect(parseCh99Additional('The duty provided in the applicable subheading')).toEqual({ addPct: 0, kind: 'exemption' });
  });
  it('détection des pays', () => {
    expect(countriesFromHeading('Except as provided in headings 9903.05.85 to 9903.05.93, articles the product of Canada, as provided for in U.S. note 52').countries).toEqual(['CA']);
    const r = countriesFromHeading('Section 232 Steel: articles of steel, except products of the United Kingdom');
    expect(r.except).toEqual(['GB']);
  });
});

describe('Finance Canada list (rate in last cell)', () => {
  it('reads the rate per row, ignores numbers in descriptions', () => {
    const html = '<table><tr><th>Tariff item</th><th>HS</th><th>Description</th><th>Tariff rate</th></tr>' +
      '<tr><td>0402.10.10</td><td>Milk</td><td>fat content not exceeding 1.5%</td><td>50</td></tr>' +
      '<tr><td>5705.00.00</td><td>Carpets</td><td>Other</td><td>25%</td></tr>' +
      '<tr><td>8467.21.00</td><td>Tools</td><td>Drills</td><td>15</td></tr></table><p>Updated 2026</p>';
    expect(extractCodes(htmlToText(html), false, { lastCellRate: true })).toEqual([
      { code: '04021010', rate: 50 },
      { code: '57050000', rate: 25 },
      { code: '84672100', rate: 15 },
    ]);
  });
});

describe('code extraction (annex PDFs)', () => {
  it('headings, 10-digit without last dot, ignores Chapter 99', () => {
    const c = extractCodes('7206 Iron and nonalloy steel\n8207.20.0070 Dies\n9903.82.02 heading\nPage 12', false, { headings: true }).map((x) => x.code);
    expect(c).toEqual(['7206', '8207200070']);
  });
});

describe('extraction de codes', () => {
  it('formats mixtes avec taux', () => {
    const c = extractCodes('7208.10.00 Hot-rolled 50%\n8418.10.00 Refrigerators 25 %\n0406909900 cheese', true);
    expect(c).toEqual([
      { code: '72081000', rate: 50 },
      { code: '84181000', rate: 25 },
      { code: '0406909900', rate: null },
    ]);
  });
});

describe('scénarios (données de démonstration)', () => {
  let db: DB;
  let rules: Rules;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarifs-'));
    db = openDb(path.join(dir, 't.sqlite'));
    rules = loadRules(path.resolve(__dirname, '../../../rules'));
    process.env.SEED_DIR ??= path.resolve(__dirname, '../../../seed');
    await ensureSeed(db, () => {});
  });

  it('CA→US : presse ACEUM — aucun droit, 301 et MPF exemptées', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '8462110035', origin: 'CA', value: 250000, currency: 'USD', preferential: true });
    expect(r.totals.total).toBe(0);
    expect(r.lines.find((l) => l.key === 'US-301-FL')?.ch99).toBe('9903.05.93');
  });
  it('CA→US : sans ACEUM — NPF 4,4 % + 301 10 % + MPF plafonnée', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '8462110035', origin: 'CA', value: 250000, currency: 'USD' });
    expect(r.totals.duties).toBe(36000);
    expect(r.totals.fees).toBe(670.86);
  });
  it('CA→US : dérivé acier Annexe III plafonné à 15 % au total', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '7308909500', origin: 'CA', value: 100000, currency: 'USD', preferential: true, options: { annexIII: true } });
    expect(r.totals.duties).toBe(15000);
  });
  it('CA→US : teneur en métal < 15 % — 232 exemptée', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '7326908688', origin: 'CA', value: 10000, currency: 'USD', preferential: true, metalWeightPct: 10 });
    expect(r.lines.find((l) => l.key === 'US-232-METALS')?.amount).toBe(0);
  });
  it('CA→US : bois — 232 10 % + AD/CVD tous les autres 24,75 %', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '4407110092', origin: 'CA', value: 10000, currency: 'USD', preferential: true, includeAdcvd: true });
    expect(r.totals.duties).toBe(1000);
    expect(r.totals.adcvd).toBe(2475);
  });
  it('CA→US : véhicule ACEUM — 232 sur le contenu non US, 338 en sus', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '87038000', origin: 'CA', value: 60000, currency: 'USD', preferential: true, usContentPct: 40 });
    expect(r.lines.find((l) => l.key === 'US-232-AUTO')?.amount).toBe(9000);
    expect(r.lines.find((l) => l.key === 'US-338-CA')?.amount).toBe(30000);
  });
  it('CA→US : produit laitier — 338 exempté si 232 (liste laitière seulement)', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '04061008', origin: 'CA', value: 1000, currency: 'USD', preferential: true });
    expect(r.lines.find((l) => l.key === 'US-338-CA')?.amount).toBe(500);
  });
  it('CA→US : motocyclette — interdiction', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '87115000', origin: 'CA', value: 1000, currency: 'USD' });
    expect(r.flags.bans.length).toBeGreaterThan(0);
  });
  it('UE→US : 301 plafonnée « net de NPF » à 10 %', () => {
    const r = calculate(db, rules, { direction: 'CA-US', code: '8483405010', origin: 'DE', value: 20000, currency: 'USD' });
    expect(r.totals.dutyPct).toBe(10);
  });
  it('US→CA : acier américain — surtaxe 50 % malgré CUSMA, TPS sur base majorée', () => {
    const r = calculate(db, rules, { direction: 'US-CA', code: '72085100', origin: 'US', value: 100000, currency: 'CAD', preferential: true });
    expect(r.totals.duties).toBe(50000);
    expect(r.totals.taxes).toBe(7500);
  });
  it('US→CA : véhicule CUSMA — surtaxe sur le contenu non canadien/mexicain, TVH Ontario', () => {
    const r = calculate(db, rules, { direction: 'US-CA', code: '87038000', origin: 'US', value: 60000, currency: 'CAD', preferential: true, caMxContentPct: 30, province: 'ON' });
    expect(r.totals.duties).toBe(10500);
    expect(r.lines.find((l) => l.key === 'hst')?.ratePct).toBe(13);
  });
  it('CN→CA : acier hors contingent — non cumulatif avec la surtaxe Chine', () => {
    const r = calculate(db, rules, { direction: 'US-CA', code: '72085100', origin: 'CN', value: 100000, currency: 'CAD', options: { overQuota: true } });
    expect(r.totals.duties).toBe(50000);
    expect(r.lines.find((l) => l.key === 'CA-CN-SA')?.notCumulated).toBe(true);
  });
  it('US→CA : liste importée — la liste officielle remplace les préfixes indicatifs', () => {
    saveCodeList(db, 'CA-US-SURTAX', [{ code: '84181000', rate: 25 }, { code: '72101100', rate: 50 }], { replace: true });
    const r = calculate(db, rules, { direction: 'US-CA', code: '84181000', origin: 'US', value: 1000, currency: 'CAD', preferential: true });
    expect(r.lines.find((l) => l.key === 'CA-US-SURTAX')?.amount).toBe(250);
    const r2 = calculate(db, rules, { direction: 'US-CA', code: '72085100', origin: 'US', value: 1000, currency: 'CAD', preferential: true });
    expect(r2.lines.find((l) => l.key === 'CA-US-SURTAX')).toBeUndefined();
  });
  it('conversion de devise USD → CAD', () => {
    const r = calculate(db, rules, { direction: 'US-CA', code: '39231090', origin: 'DE', value: 1000, currency: 'USD', fxUsdCad: 1.4 });
    expect(r.value).toBe(1400);
    expect(r.lines[0].amount).toBe(91);
  });
});

describe('Section 232 / 301 / 338 by annex lists (real USITC data has no Chapter 99 footnotes)', () => {
  let db: DB;
  let rules: Rules;
  const rec = (htsno: string, general = '', special = '') => ({ htsno, description: htsno, indent: '1', general, special, other: '', footnotes: [] });
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarifs-real-'));
    db = openDb(path.join(dir, 't.sqlite'));
    rules = loadRules(path.resolve(__dirname, '../../../rules'));
    importUsRecords(
      db,
      [
        rec('7326.90.86', '2.9%', 'Free (A,AU,S,SG)'),
        rec('7326.90.86.88'),
        rec('7208.51.00', 'Free'),
        rec('7208.51.00.30'),
        rec('8462.11.00', '4.4%', 'Free (A,AU,S,SG)'),
        rec('8462.11.00.35'),
        rec('8703.80.00', '2.5%', 'Free (A+,S)'),
      ] as never,
      'test',
    );
  });
  const calc = (code: string, origin: string, extra: object = {}) =>
    calculate(db, rules, { direction: 'CA-US', code, origin, value: 10000, currency: 'USD', ...extra });

  it('steel derivative: 232 Annex I-B by indicative prefix', () => {
    const l = calc('7326908688', 'CA', { preferential: true }).lines.find((x) => x.key === 'US-232-METALS');
    expect(l?.amount).toBe(2500);
    expect(l?.status).toBe('to verify');
    expect(l?.note).toContain('indicative prefix');
  });
  it('steel plate: Annex I-A 50%, 301 exempt through 9903.05.90 when USMCA not claimed', () => {
    const r = calc('7208510030', 'CA');
    expect(r.lines.find((x) => x.key === 'US-232-METALS')?.amount).toBe(5000);
    expect(r.lines.find((x) => x.key === 'US-301-FL')?.ch99).toBe('9903.05.90');
  });
  it('official list replaces prefixes; Annex III list applies the 15% combined cap', () => {
    saveCodeList(db, 'US-232-ANNEX-IB', [{ code: '72085100', rate: null }], { replace: true });
    expect(calc('7326908688', 'CA', { preferential: true }).lines.find((x) => x.key === 'US-232-METALS')).toBeUndefined();
    saveCodeList(db, 'US-232-ANNEX-III', [{ code: '84621100', rate: null }], { replace: true });
    const r = calc('8462110035', 'CA');
    const l = r.lines.find((x) => x.key === 'US-232-METALS');
    expect(l?.ratePct).toBeCloseTo(10.6);
    expect(r.totals.dutyPct).toBe(15);
  });
  it('autos: vehicle prefix 25% on non-U.S. content; 338 motor list once imported', () => {
    saveCodeList(db, 'US-338-MOTOR', [{ code: '87038000', rate: null }], { replace: true });
    const r = calc('87038000', 'CA', { preferential: true, usContentPct: 50 });
    expect(r.lines.find((x) => x.key === 'US-232-AUTO')?.amount).toBe(1250);
    expect(r.lines.find((x) => x.key === 'US-338-CA')?.amount).toBe(5000);
  });
  it('aluminum smelt/cast unknown → 200%, cancels Annex III cap; steel unknown disables U.S.-metal option', () => {
    const r = calc('8462110035', 'CA', { options: { aluminumUnknown: true } });
    expect(r.lines.find((x) => x.key === 'US-232-METALS')?.amount).toBe(20000);
    expect(r.flags.warnings.some((w) => w.title.startsWith('Aluminum'))).toBe(true);
    const s1 = calc('7208510030', 'CA', { options: { usMelt85: true } }).lines.find((x) => x.key === 'US-232-METALS')?.amount;
    const s2 = calc('7208510030', 'CA', { options: { usMelt85: true, steelUnknown: true } }).lines.find((x) => x.key === 'US-232-METALS')?.amount;
    expect(s1).toBe(1000);
    expect(s2).toBe(5000);
  });
  it('301 China: list import with rate', () => {
    saveCodeList(db, 'US-301-CN-L3', [{ code: '7326908688', rate: null }], { replace: true });
    const r = calc('7326908688', 'CN');
    expect(r.lines.find((x) => x.key === 'US-301-CN')?.amount).toBe(2500);
  });
});

import { extractCodesWithStreamRates } from '../importers/misc.js';
describe('Finance Canada list — markup-independent stream reader', () => {
  const expected = [
    { code: '04021010', rate: 50 },
    { code: '04021020', rate: 50 },
    { code: '57050000', rate: 25 },
    { code: '84672100', rate: 15 },
  ];
  it('table rows', () => {
    const html = '<table><tr><td>0402.10.10</td><td>Milk and cream.</td><td>fat not exceeding 1.5%: Within access commitment</td><td>50%</td></tr><tr><td>0402.10.20</td><td>Milk.</td><td>Over access commitment</td><td>50%</td></tr><tr><td>5705.00.00</td><td>Carpets, of heading 57.05</td><td>Other</td><td>25</td></tr><tr><td>8467.21.00</td><td>Tools</td><td>Drills, 2 speeds</td><td>15 %</td></tr></table><p>Date modified: 2026-10-09</p>';
    expect(extractCodesWithStreamRates(htmlToText(html))).toEqual(expected);
  });
  it('flattened text / divs / bullets', () => {
    const t = '• 0402.10.10 Milk and cream. - fat not exceeding 1.5%: Within access commitment 50% • 0402.10.20 Milk. Over access commitment 50% 5705.00.00 Carpets Other 25 8467.21.00 Tools Drills, 2 speeds 15 Date modified: 2026-10-09';
    expect(extractCodesWithStreamRates(t)).toEqual(expected);
  });
});
