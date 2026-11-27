import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src -> racine du projet (ou server/dist -> racine)
const root = path.resolve(here, '..', '..');

export const config = {
  root,
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ?? path.join(root, 'data'),
  rulesDir: process.env.RULES_DIR ?? path.join(root, 'rules'),
  seedDir: process.env.SEED_DIR ?? path.join(root, 'seed'),
  webDist: process.env.WEB_DIST ?? path.join(root, 'web', 'dist'),
  adminToken: process.env.ADMIN_TOKEN ?? '',
  /** Planification des imports (format cron). Vide = désactivé. */
  cronUs: process.env.CRON_US ?? '30 3 * * 1',
  cronFx: process.env.CRON_FX ?? '15 17 * * 1-5',
  /** Weekly re-import of official annex lists (Section 232 proclamation PDFs). */
  cronLists: process.env.CRON_LISTS ?? '15 4 * * 1',
  /** Customs news feed (official sources): every 6 hours. */
  cronNews: process.env.CRON_NEWS ?? '20 */6 * * *',
  /** Daily CBSA check: the file is downloaded/imported only when it changed. */
  cronCa: process.env.CRON_CA ?? '45 6 * * *',
  /** URL du fichier tarif CBSA (XLSX/CSV) pour import automatique, optionnel. */
  caTariffUrl: process.env.CA_TARIFF_URL ?? '',
  usitcBase: process.env.USITC_BASE ?? 'https://hts.usitc.gov/reststop',
  cbsaBase: process.env.CBSA_BASE ?? 'https://www.cbsa-asfc.gc.ca',
  fxUrl:
    process.env.FX_URL ??
    'https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXEURCAD/json?recent=1',
  /** Daily history for the Fiscal tab (backfilled on the first import). */
  fxHistoryUrl: 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXEURCAD/json?recent=260',
  /** Monthly TARIC re-import from the URLs saved in Admin (2nd of the month). */
  cronEu: process.env.CRON_EU ?? '30 5 2 * *',
};
