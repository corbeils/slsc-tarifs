import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { config } from './config.js';
import { importUsFile } from './importers/us-hts.js';
import { importCaFile } from './importers/ca-tariff.js';

/** Charge les données de démonstration si aucune donnée n'existe pour une juridiction. */
export async function ensureSeed(db: DB, log: (m: string) => void = console.log) {
  const count = (j: string) => (db.prepare('SELECT COUNT(*) n FROM lines WHERE j = ?').get(j) as { n: number }).n;
  if (count('US') === 0) {
    const f = path.join(config.seedDir, 'us-demo.json');
    if (fs.existsSync(f)) {
      const r = importUsFile(db, f, 'seed-demo');
      log(`[seed] demo U.S. tariff: ${r.lines} lines`);
    }
  }
  if (count('CA') === 0) {
    const f = path.join(config.seedDir, 'ca-demo.csv');
    if (fs.existsSync(f)) {
      const r = await importCaFile(db, f, 'seed-demo');
      log(`[seed] demo Canadian tariff: ${r.lines} lines`);
    }
  }
}
