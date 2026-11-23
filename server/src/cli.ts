/**
 * Ligne de commande :
 *   npm run cli -- import-us            (télécharge le HTSUS complet depuis l'USITC)
 *   npm run cli -- import-us-file f.json
 *   npm run cli -- import-ca fichier.xlsx|.csv
 *   npm run cli -- import-ca-url https://…
 *   npm run cli -- import-fx
 *   npm run cli -- codes <MESURE_ID> fichier.txt [--replace] [--rates]
 *   npm run cli -- calc CA-US 8462.11.00 CA 250000 [--pref]
 */
import fs from 'node:fs';
import { openDb } from './db.js';
import { loadRules } from './rules.js';
import { importUsFile, importUsOnline } from './importers/us-hts.js';
import { importCaFile, importCaUrl } from './importers/ca-tariff.js';
import { extractCodes, importFx, saveCodeList } from './importers/misc.js';
import { calculate } from './engine/index.js';
import { ensureSeed } from './seed.js';

const [cmd, ...args] = process.argv.slice(2);
const db = openDb();
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));

switch (cmd) {
  case 'import-us':
    console.log(await importUsOnline(db, console.log));
    break;
  case 'import-us-file':
    console.log(importUsFile(db, pos[0]));
    break;
  case 'import-ca':
    console.log(await importCaFile(db, pos[0]));
    break;
  case 'import-ca-url':
    console.log(await importCaUrl(db, pos[0]));
    break;
  case 'import-fx':
    console.log(await importFx(db));
    break;
  case 'seed':
    await ensureSeed(db);
    break;
  case 'codes': {
    const codes = extractCodes(fs.readFileSync(pos[1], 'utf8'), flags.has('--rates'));
    console.log(saveCodeList(db, pos[0], codes, { replace: flags.has('--replace'), source: pos[1] }));
    break;
  }
  case 'calc': {
    const rules = loadRules();
    const [direction, code, origin, value] = pos;
    const r = calculate(db, rules, {
      direction: direction as 'CA-US' | 'US-CA',
      code,
      origin,
      value: Number(value),
      currency: direction === 'CA-US' ? 'USD' : 'CAD',
      preferential: flags.has('--pref'),
    });
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
}
