import cron from 'node-cron';
import { config } from './config.js';
import { openDb } from './db.js';
import { loadRules } from './rules.js';
import { buildApp, startJob } from './app.js';
import { ensureSeed } from './seed.js';
import { importUsOnline } from './importers/us-hts.js';
import { syncCbsa } from './importers/cbsa-sync.js';
import { syncOfficialLists } from './importers/official-lists.js';
import { getRules } from './rules.js';
import { importFx } from './importers/misc.js';
import { syncTaricUrls } from './importers/taric.js';
import { syncNews } from './importers/news.js';
import { getMeta } from './db.js';

const db = openDb();
loadRules();
await ensureSeed(db);
const app = await buildApp(db);

// A failed background task must never bring the site down
process.on('unhandledRejection', (e) => app.log.error({ err: e }, 'unhandledRejection'));

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
// First start: fill the exchange-rate history for the Fiscal tab
if (!db.prepare('SELECT 1 FROM fx_history LIMIT 1').get()) importFx(db).catch((e) => app.log.warn({ err: e }, 'FX history import failed'));
schedule(config.cronCa, 'sync-cbsa', () => syncCbsa(db));
schedule(config.cronLists, 'sync-lists', () => syncOfficialLists(db, getRules()));
schedule(config.cronNews, 'sync-news', () => syncNews(db, getRules().news));
// First start: fill the news feed
if (!db.prepare('SELECT 1 FROM news LIMIT 1').get()) syncNews(db, getRules().news).catch((e) => app.log.warn({ err: e }, 'News sync failed'));
schedule(config.cronEu, 'sync-taric', async () => {
  const urls = getMeta<string[]>(db, 'taric:urls') ?? [];
  return urls.length ? syncTaricUrls(db, urls) : 'no TARIC URL saved';
});

await app.listen({ port: config.port, host: config.host });
