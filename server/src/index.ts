import cron from 'node-cron';
import { config } from './config.js';
import { openDb } from './db.js';
import { loadRules } from './rules.js';
import { buildApp, startJob } from './app.js';
import { ensureSeed } from './seed.js';
import { importUsOnline } from './importers/us-hts.js';
import { syncCbsa } from './importers/cbsa-sync.js';
import { importFx } from './importers/misc.js';

const db = openDb();
loadRules();
await ensureSeed(db);
const app = await buildApp(db);

function schedule(expr: string, name: string, fn: () => Promise<unknown>) {
  if (!expr) return;
  if (!cron.validate(expr)) {
    app.log.warn(`Planification invalide pour ${name} : ${expr}`);
    return;
  }
  cron.schedule(expr, () => {
    startJob(name, async (log) => {
      log(`Démarrage planifié ${name}`);
      const r = await fn();
      app.log.info({ r }, `${name} terminé`);
      return r;
    });
  });
  app.log.info(`Planifié : ${name} (${expr})`);
}

schedule(config.cronUs, 'import-us', () => importUsOnline(db));
schedule(config.cronFx, 'import-fx', () => importFx(db));
schedule(config.cronCa, 'sync-cbsa', () => syncCbsa(db));

await app.listen({ port: config.port, host: config.host });
