import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import type { DB } from './db.js';
import { digits, getMeta, setMeta } from './db.js';
import { listCountries } from './countries.js';
import { asLang, localizeRules } from './i18n/index.js';
import { getRules, loadRules, readRuleFile, RULE_FILES, type RuleKey, writeRuleFile } from './rules.js';
import { calculate, currentFx } from './engine/index.js';
import type { CalcInput } from './engine/types.js';
import { importUsFile, importUsOnline } from './importers/us-hts.js';
import { importCaFile, importCaUrl } from './importers/ca-tariff.js';
import { extractCodes, fetchText, fileToText, section, validateCodes, importAdcvdCsv, importFx, importPgaCsv, saveCodeList, setFxManual } from './importers/misc.js';
import { buildTemplate, runBatch } from './batch.js';
import { syncCbsa } from './importers/cbsa-sync.js';
import { syncOfficialLists } from './importers/official-lists.js';
import { importTaric, syncTaricUrls, type TaricFile } from './importers/taric.js';
import { classify, publicAiConfig, setAiConfig, type ChatTurn, type ClassJ } from './classify.js';
import { clearListCache } from './engine/common.js';
import { asRole, changePassword, createUser, deleteUser, listUsers, login, logout, renameUser, resetPassword, sessionUser, setPrefs, setRole } from './auth.js';

type Job = { id: string; kind: string; status: 'running' | 'done' | 'error'; log: string[]; result?: unknown; error?: string; started: string };
const jobs = new Map<string, Job>();

export function startJob(kind: string, fn: (log: (m: string) => void) => Promise<unknown>): Job {
  const job: Job = { id: Math.random().toString(36).slice(2, 10), kind, status: 'running', log: [], started: new Date().toISOString() };
  jobs.set(job.id, job);
  fn((m) => job.log.push(m))
    .then((r) => {
      job.status = 'done';
      job.result = r;
    })
    .catch((e: Error) => {
      job.status = 'error';
      job.error = e.message;
    });
  return job;
}

export async function buildApp(db: DB) {
  // keepAliveTimeout longer than the reverse proxy's upstream keep-alive, so the proxy never reuses a socket Node just closed
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 20 * 1024 * 1024, keepAliveTimeout: 120_000 });
  await app.register(multipart, { limits: { fileSize: 600 * 1024 * 1024, files: 20 } });

  const bearer = (req: FastifyRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = bearer(req);
    // ADMIN_TOKEN (optional) still works for scripts / API calls
    if (config.adminToken && (t === config.adminToken || req.headers['x-admin-token'] === config.adminToken)) {
      (req as FastifyRequest & { user?: unknown }).user = { id: '_token', username: 'API token', mustChange: false, role: 'admin', prefs: {} };
      return;
    }
    const u = sessionUser(db, t);
    if (!u) return reply.code(401).send({ error: 'Please sign in' });
    (req as FastifyRequest & { user?: unknown }).user = u;
    // USER group: own account, measures in force and HS code lookup only; the rest of /api/admin is for ADMIN
    const path = req.url.split('?')[0];
    const ownAccount = ['/api/admin/me', '/api/admin/password', '/api/admin/username', '/api/admin/prefs'].includes(path);
    if (path.startsWith('/api/admin/') && !ownAccount && u.role !== 'admin') return reply.code(403).send({ error: 'Administrators only' });
  };
  const userOf = (req: FastifyRequest) => (req as FastifyRequest & { user: { id: string; username: string; mustChange: boolean; role: 'admin' | 'user' } }).user;

  app.post('/api/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as { username?: string; password?: string };
    const r = login(db, b.username ?? '', b.password ?? '');
    if (!r) {
      await new Promise((ok) => setTimeout(ok, 600));
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    return r;
  });
  app.post('/api/auth/logout', async (req) => {
    logout(db, bearer(req));
    return { ok: true };
  });

  app.get('/api/health', async () => ({ ok: true }));

  /** Site version shown in the footer (editable in Admin). Format: 1.3.0 or 1.1.4R2 (revision of the day). */
  const DEFAULT_SITE = { version: '1.3.0', beta: true };
  const siteVersion = () => ({ ...DEFAULT_SITE, ...(getMeta<{ version: string; beta: boolean }>(db, 'site:version') ?? {}) });

  app.get('/api/meta', async () => {
    const count = (j: string) => (db.prepare('SELECT COUNT(*) n FROM lines WHERE j = ?').get(j) as { n: number }).n;
    const lists = db.prepare('SELECT measure_id, COUNT(*) n, MAX(added_at) at FROM code_lists GROUP BY measure_id').all();
    return {
      us: { ...(getMeta(db, 'import:US') ?? {}), lines: count('US') },
      ca: { ...(getMeta(db, 'import:CA') ?? {}), lines: count('CA') },
      eu: { ...(getMeta(db, 'import:EU') ?? {}), lines: count('EU') },
      taricUrls: getMeta<string[]>(db, 'taric:urls') ?? [],
      pga: getMeta(db, 'import:PGA'),
      cbsa: getMeta(db, 'cbsa:sync'),
      officialLists: getMeta(db, 'lists:sync'),
      fx: currentFx(db),
      rulesLoadedAt: getRules().loadedAt,
      codeLists: lists,
      site: siteVersion(),
    };
  });

  app.get('/api/countries', async () => listCountries());

  // Fiscal tab: exchange rates used by the simulator (Bank of Canada) + daily history
  app.get('/api/fx', async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 90, 5), 400);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare('SELECT date, series, rate FROM fx_history WHERE date >= ? ORDER BY date').all(since) as { date: string; series: string; rate: number }[];
    const byDate = new Map<string, { date: string; USDCAD?: number; EURCAD?: number }>();
    for (const r of rows) byDate.set(r.date, { ...(byDate.get(r.date) ?? { date: r.date }), [r.series]: r.rate });
    return { latest: currentFx(db), history: [...byDate.values()] };
  });

  app.get('/api/search', async (req) => {
    const q = (req.query as { j?: string; q?: string; limit?: string }) ?? {};
    const j = q.j === 'CA' ? 'CA' : q.j === 'EU' ? 'EU' : 'US';
    const term = (q.q ?? '').trim();
    const limit = Math.min(Number(q.limit ?? 25), 100);
    if (!term) return [];
    const d = digits(term);
    if (d.length >= 2 && /^[\d.\s]+$/.test(term)) {
      return db
        .prepare(
          `SELECT code, display, description, path, general, is_leaf FROM lines WHERE j = ? AND code LIKE ? AND code NOT LIKE '99%'
           ORDER BY length(code) = 10 DESC, code LIMIT ?`,
        )
        .all(j, d + '%', limit);
    }
    const fts = term
      .replace(/["*()]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w}"*`)
      .join(' ');
    if (!fts) return [];
    return db
      .prepare(
        `SELECT l.code, l.display, l.description, l.path, l.general, l.is_leaf
         FROM lines_fts f JOIN lines l ON l.j = f.j AND l.code = f.code
         WHERE lines_fts MATCH ? AND f.j = ? ORDER BY l.is_leaf DESC, rank LIMIT ?`,
      )
      .all(fts, j, limit);
  });

  app.get('/api/line', async (req, reply) => {
    const q = req.query as { j?: string; code?: string };
    const j = q.j === 'CA' ? 'CA' : 'US';
    const c = digits(q.code ?? '');
    const line = db.prepare('SELECT * FROM lines WHERE j = ? AND code = ?').get(j, c);
    if (!line) return reply.code(404).send({ error: 'not found' });
    const children = db
      .prepare('SELECT code, display, description, general, is_leaf FROM lines WHERE j = ? AND code LIKE ? AND code != ? ORDER BY code LIMIT 200')
      .all(j, c + '%', c);
    return { line, children };
  });

  app.post('/api/calc', async (req, reply) => {
    const input = req.body as CalcInput & { lang?: string };
    if (!input?.code || !input.direction) return reply.code(400).send({ error: 'code and direction required' });
    return calculate(db, getRules(), { ...input, value: Number(input.value) || 0 }, asLang(input.lang ?? (req.query as { lang?: string }).lang));
  });

  app.get('/api/batch/template', async (req, reply) => {
    const l = asLang((req.query as { lang?: string }).lang);
    const buf = await buildTemplate(listCountries(), l);
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="BATCH TARIFF SIMULATOR.xlsx"');
    return reply.send(buf);
  });

  app.post('/api/batch', async (req, reply) => {
    const parts = req.parts();
    let file: { buf: Buffer; name: string } | null = null;
    const fields: Record<string, string> = {};
    for await (const p of parts) {
      if (p.type === 'file') file = { buf: await p.toBuffer(), name: p.filename };
      else fields[p.fieldname] = String(p.value);
    }
    if (!file) return reply.code(400).send({ error: 'Missing file' });
    const r = await runBatch(db, getRules(), file.buf, file.name, {
      direction: fields.direction === 'US-CA' ? 'US-CA' : fields.direction === 'IN-EU' ? 'IN-EU' : 'CA-US',
      // No defaults on the page any more: the file's Origin / Currency columns are used; fallbacks follow the direction
      origin: (fields.origin || (fields.direction === 'US-CA' ? 'US' : 'CA')).toUpperCase(),
      currency:
        fields.currency === 'USD' || fields.currency === 'CAD' || fields.currency === 'EUR'
          ? fields.currency
          : fields.direction === 'US-CA' ? 'CAD' : fields.direction === 'IN-EU' ? 'EUR' : 'USD',
      memberState: fields.memberState,
      preferential: fields.preferential === 'true',
      province: fields.province,
      mode: (fields.mode as CalcInput['mode']) || undefined,
    }, asLang(fields.lang));
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="BATCH TARIFF SIMULATOR - ${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .header('X-Rows', String(r.rows))
      .header('X-Errors', String(r.errors))
      .header('X-Error-List', encodeURIComponent(JSON.stringify(r.errorList)));
    return reply.send(r.buffer);
  });

  // Résumé public des mesures (page « Mesures en vigueur »)
  // Measures in force: signed-in users (USER and ADMIN groups)
  app.get('/api/measures', { preHandler: admin }, async (req) => {
    const R = localizeRules(getRules(), asLang((req.query as { lang?: string }).lang));
    const lists = Object.fromEntries(
      (db.prepare('SELECT measure_id, COUNT(*) n FROM code_lists GROUP BY measure_id').all() as { measure_id: string; n: number }[]).map((r) => [
        r.measure_id,
        r.n,
      ]),
    );
    const ch99 = db.prepare('SELECT COUNT(*) n FROM ch99').get() as { n: number };
    return {
      us: {
        programs: R.us.programs.map((p) => ({ id: p.id, name: p.name, family: p.family, prefixes: p.prefixes, status: p.status, note: p.note, url: p.url, options: p.options, lists: (p.lists ?? []).map((l) => ({ ...l, listCount: lists[l.id] ?? 0 })) })),
        measures: R.us.measures.map((m) => ({ ...m, listCount: lists[m.id] ?? 0 })),
        regimes: R.us.regimes,
        fees: R.us.fees,
        ch99Count: ch99.n,
      },
      ca: { measures: R.ca.measures.map((m) => ({ ...m, listCount: lists[m.id] ?? 0 })), regimes: R.ca.regimes, taxes: R.ca.taxes },
      adcvd: R.adcvd,
      licences: R.licences,
    };
  });

  // INBOUND EU: VAT, agreements and the TARIC measures by origin (quotas, AD/CVD, additional duties)
  app.get('/api/measures/eu', { preHandler: admin }, async (req) => {
    const q = req.query as { origin?: string; lang?: string };
    const R = localizeRules(getRules(), asLang(q.lang));
    const T = R.eu.measureTypes;
    const origin = (q.origin ?? '').toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const groups = origin
      ? [origin, ...(db.prepare("SELECT grp FROM eu_geo WHERE member = ? AND (end = '' OR end >= ?)").all(origin, today) as { grp: string }[]).map((r) => r.grp), '1011']
      : [];
    const list = (types: string[], groupBy: string) => {
      if (!types?.length) return [];
      const where = [`type IN (${types.map(() => '?').join(',')})`, "(end = '' OR end >= ?)"];
      const args: unknown[] = [...types, today];
      if (groups.length) {
        where.push(`origin IN (${groups.map(() => '?').join(',')})`);
        args.push(...groups);
      }
      return db
        .prepare(
          `SELECT type, type_desc, origin, origin_desc, legal, order_no, MIN(duty) duty, MAX(duty) duty_max, COUNT(DISTINCT code) codes, MIN(code) first_code
           FROM eu_measures WHERE ${where.join(' AND ')} GROUP BY ${groupBy} ORDER BY origin, type, legal LIMIT 2000`,
        )
        .all(...args);
    };
    const origins = db.prepare("SELECT DISTINCT origin, origin_desc FROM eu_measures WHERE origin != '1011' ORDER BY origin_desc").all();
    return {
      vat: R.eu.vat,
      vatNote: R.eu.vatNote,
      agreements: R.eu.agreements,
      imported: getMeta(db, 'import:EU'),
      origins,
      antiDumping: list(T.antiDumping, 'type, legal, origin'),
      quotas: list([...(T.preferentialQuota ?? []), ...(T.quota ?? [])], 'order_no, origin'),
      additional: list(T.additional, 'type, legal, origin'),
      preferences: list(T.preference, 'origin'),
    };
  });

  // ----------------------------- ADMIN -----------------------------
  app.register(async (a) => {
    a.addHook('preHandler', admin);

    a.get('/api/admin/me', async (req) => userOf(req));
    a.post('/api/admin/prefs', async (req) => setPrefs(db, userOf(req).id, (req.body ?? {}) as Record<string, unknown>));
    a.post('/api/admin/users/:u/role', async (req, reply) => {
      try {
        setRole(db, (req.params as { u: string }).u, asRole((req.body as { role?: string })?.role), userOf(req).id);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.get('/api/admin/changelog', async () => getMeta(db, 'site:changelog') ?? []);
    a.post('/api/admin/username', async (req, reply) => {
      const b = (req.body ?? {}) as { username?: string; password?: string };
      try {
        return renameUser(db, userOf(req).id, b.username ?? '', b.password ?? '');
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    // ---- HS code lookup (signed-in users): one search across HTSUS, Canadian tariff and TARIC ----
    a.get('/api/lookup/search', async (req) => {
      const q = (req.query as { q?: string; j?: string }) ?? {};
      const term = (q.q ?? '').trim();
      const js = (q.j ?? 'US,CA,EU').split(',').filter((x) => ['US', 'CA', 'EU'].includes(x));
      if (!term) return [];
      const d = digits(term);
      const out: unknown[] = [];
      for (const j of js) {
        if (d.length >= 2 && /^[\d.\s]+$/.test(term)) {
          out.push(
            ...db
              .prepare(`SELECT ? j, code, display, description, path, is_leaf FROM lines WHERE j = ? AND code LIKE ? AND code NOT LIKE '99%' ORDER BY code LIMIT 40`)
              .all(j, j, d + '%'),
          );
          continue;
        }
        const fts = term.replace(/["*()]/g, ' ').split(/\s+/).filter((w) => w.length > 1).map((w) => `"${w}"*`).join(' ');
        if (!fts) continue;
        out.push(
          ...db
            .prepare(
              `SELECT f.j j, l.code, l.display, l.description, l.path, l.is_leaf FROM lines_fts f JOIN lines l ON l.j = f.j AND l.code = f.code
               WHERE lines_fts MATCH ? AND f.j = ? AND l.code NOT LIKE '99%' ORDER BY l.is_leaf DESC, rank LIMIT 30`,
            )
            .all(fts, j),
        );
      }
      return out;
    });
    a.post('/api/lookup/classify', async (req, reply) => {
      const b = (req.body ?? {}) as { j?: string; turns?: ChatTurn[]; lang?: string };
      const j: ClassJ = b.j === 'CA' ? 'CA' : b.j === 'EU' ? 'EU' : 'US';
      if (!b.turns?.length) return reply.code(400).send({ error: 'Describe the goods' });
      try {
        return await classify(db, j, b.turns, b.lang === 'fr' ? 'fr' : 'en');
      } catch (e) {
        const err = e as Error & { status?: number };
        return reply.code(err.status ?? 500).send({ error: err.message });
      }
    });
    a.get('/api/admin/ai', async () => publicAiConfig(db));
    a.post('/api/admin/ai', async (req) => setAiConfig(db, (req.body ?? {}) as Parameters<typeof setAiConfig>[1]));
    a.get('/api/lookup/hs/:hs6', async (req) => {
      const hs6 = digits((req.params as { hs6: string }).hs6).slice(0, 6);
      if (hs6.length < 4) return { hs6, heading: null, lines: [] };
      const today = new Date().toISOString().slice(0, 10);
      const head = db.prepare("SELECT description FROM lines WHERE code LIKE ? AND length(replace(display, '.', '')) <= 4 ORDER BY j LIMIT 1").get(hs6.slice(0, 4) + '%') as { description: string } | undefined;
      const rows = db
        .prepare(`SELECT j, code, display, description, path, is_leaf, general, special, pref_json, other FROM lines WHERE code LIKE ? AND code NOT LIKE '99%' ORDER BY j DESC, code`)
        .all(hs6 + '%') as { j: string; code: string; general: string | null; pref_json: string | null }[];
      const euDuty = db.prepare(
        `SELECT duty, code FROM eu_measures WHERE type = '103' AND origin = '1011' AND code IN (?,?,?,?,?) AND (end = '' OR end >= ?) ORDER BY length(rtrim(code, '0')) DESC LIMIT 1`,
      );
      const lines = rows.map((r) => {
        let rate: string | null = r.general;
        if (r.j === 'EU') {
          const c = r.code;
          const m = euDuty.get(c.slice(0, 2).padEnd(10, '0'), c.slice(0, 4).padEnd(10, '0'), c.slice(0, 6).padEnd(10, '0'), c.slice(0, 8).padEnd(10, '0'), c, today) as { duty: string } | undefined;
          rate = m?.duty ?? null;
        }
        let pref: Record<string, string> = {};
        try {
          pref = r.pref_json ? JSON.parse(r.pref_json) : {};
        } catch {
          /* ignore */
        }
        return { ...r, rate, ust: pref.UST ?? null, pref_json: undefined };
      });
      return { hs6, heading: head?.description ?? null, lines };
    });
    a.post('/api/admin/password', async (req, reply) => {
      const b = req.body as { current: string; next: string };
      try {
        changePassword(db, userOf(req).id, b.current ?? '', b.next ?? '');
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.get('/api/admin/users', async () => listUsers(db));
    a.post('/api/admin/users', async (req, reply) => {
      const b = req.body as { username: string; password: string; role?: string };
      try {
        createUser(db, b.username ?? '', b.password ?? '', true, asRole(b.role));
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.post('/api/admin/users/:u/reset', async (req, reply) => {
      try {
        resetPassword(db, (req.params as { u: string }).u, (req.body as { password: string }).password ?? '');
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.delete('/api/admin/users/:u', async (req, reply) => {
      try {
        deleteUser(db, (req.params as { u: string }).u, userOf(req).id);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    a.post('/api/admin/import/us', async () => {
      const job = startJob('import-us', (log) => importUsOnline(db, log));
      return { job: job.id };
    });
    a.post('/api/admin/import/us-file', async (req, reply) => {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: 'Missing file' });
      const tmp = path.join(os.tmpdir(), `usitc-${Date.now()}.json`);
      fs.writeFileSync(tmp, await f.toBuffer());
      try {
        return importUsFile(db, tmp, `fichier ${f.filename}`);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
    a.post('/api/admin/import/ca-file', async (req, reply) => {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: 'Missing file' });
      const tmp = path.join(os.tmpdir(), `ca-${Date.now()}${path.extname(f.filename) || '.xlsx'}`);
      fs.writeFileSync(tmp, await f.toBuffer());
      try {
        return await importCaFile(db, tmp, f.filename);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
    a.post('/api/admin/import/ca-url', async (req) => {
      const { url } = req.body as { url: string };
      const job = startJob('import-ca', () => importCaUrl(db, url));
      return { job: job.id };
    });
    a.post('/api/admin/sync/official-lists', async () => {
      const job = startJob('sync-lists', (log) => syncOfficialLists(db, getRules(), log));
      return { job: job.id };
    });
    a.post('/api/admin/sync/cbsa', async (req) => {
      const force = !!(req.body as { force?: boolean } | undefined)?.force;
      const job = startJob('sync-cbsa', (log) => syncCbsa(db, { force, log }));
      return { job: job.id };
    });
    a.post('/api/admin/import/fx', async () => importFx(db));

    // ---- EU TARIC ----
    a.post('/api/admin/import/taric', async (req, reply) => {
      const files: TaricFile[] = [];
      for await (const p of req.parts()) if (p.type === 'file') files.push({ name: p.filename, buf: await p.toBuffer() });
      if (!files.length) return reply.code(400).send({ error: 'Missing file' });
      const job = startJob('import-taric', (log) => importTaric(db, files, log));
      return { job: job.id };
    });
    a.post('/api/admin/taric-urls', async (req) => {
      const urls = ((req.body as { urls?: string[] })?.urls ?? []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//.test(u));
      setMeta(db, 'taric:urls', urls);
      return { ok: true, urls };
    });
    a.post('/api/admin/sync/taric', async (req, reply) => {
      const urls = getMeta<string[]>(db, 'taric:urls') ?? [];
      if (!urls.length) return reply.code(400).send({ error: 'No TARIC file URL saved' });
      const job = startJob('sync-taric', (log) => syncTaricUrls(db, urls, log));
      return { job: job.id };
    });
    a.post('/api/admin/site-version', async (req, reply) => {
      const b = (req.body ?? {}) as { version?: string; beta?: boolean };
      const version = String(b.version ?? '').trim().toUpperCase();
      if (!/^\d+\.\d+\.\d+(R\d+)?$/.test(version))
        return reply.code(400).send({ error: 'Invalid version: use 3 numbers, optionally followed by a revision (e.g. 1.3.0 or 1.1.4R2)' });
      const v = { version, beta: b.beta !== false, at: new Date().toISOString() };
      setMeta(db, 'site:version', v);
      const notes = String((req.body as { notes?: string }).notes ?? '').trim();
      const log = getMeta<{ version: string; beta: boolean; at: string; notes: string; by: string }[]>(db, 'site:changelog') ?? [];
      log.unshift({ ...v, notes, by: userOf(req).username });
      setMeta(db, 'site:changelog', log.slice(0, 200));
      return { ok: true, ...v };
    });

    a.post('/api/admin/fx', async (req) => setFxManual(db, Number((req.body as { rate: number }).rate)));

    a.get('/api/admin/jobs/:id', async (req, reply) => {
      const j = jobs.get((req.params as { id: string }).id);
      return j ?? reply.code(404).send({ error: 'unknown job' });
    });

    a.get('/api/admin/codes/:id', async (req) =>
      db.prepare('SELECT code, rate, source, added_at FROM code_lists WHERE measure_id = ? ORDER BY code').all((req.params as { id: string }).id),
    );
    a.post('/api/admin/codes', async (req, reply) => {
      let body: Record<string, unknown> = (req.body as Record<string, unknown>) ?? {};
      if (req.isMultipart()) {
        body = {};
        for await (const part of req.parts()) {
          if (part.type === 'file') body.text = await fileToText(await part.toBuffer(), part.filename);
          else body[part.fieldname] = part.value;
        }
        for (const k of ['replace', 'withRates']) body[k] = body[k] === 'true';
      }
      const b = body as { measureId: string; text?: string; url?: string; replace?: boolean; withRates?: boolean; rate?: number | null; from?: string; until?: string };
      if (!b.measureId) return reply.code(400).send({ error: 'measureId required' });
      let text = b.url ? await fetchText(b.url) : b.text ?? '';
      // Keep only the section between two markers (e.g. "Annex I-B" … "Annex I-C")
      try {
        text = section(text, b.from, b.until);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const j = b.measureId.startsWith('CA-') ? 'CA' : 'US';
      const codes = validateCodes(db, j, extractCodes(text, !!b.withRates, { headings: true }));
      if (!codes.length) return reply.code(400).send({ error: 'No tariff numbers detected' });
      return { ...saveCodeList(db, b.measureId, codes, { replace: b.replace, source: b.url ?? 'pasted', rate: b.rate ?? null }), sample: codes.slice(0, 10) };
    });
    a.delete('/api/admin/codes/:id', async (req) => {
      db.prepare('DELETE FROM code_lists WHERE measure_id = ?').run((req.params as { id: string }).id);
      clearListCache();
      return { ok: true };
    });

    a.post('/api/admin/import/pga', async (req, reply) => {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: 'Missing file' });
      try {
        return importPgaCsv(db, await fileToText(await f.toBuffer(), f.filename));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.post('/api/admin/import/adcvd', async (req, reply) => {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: 'Missing file' });
      try {
        return importAdcvdCsv(db, await fileToText(await f.toBuffer(), f.filename));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    a.get('/api/admin/rules/:key', async (req, reply) => {
      const k = (req.params as { key: string }).key as RuleKey;
      if (!(k in RULE_FILES)) return reply.code(404).send({ error: 'unknown file' });
      return { key: k, file: RULE_FILES[k].file, text: readRuleFile(k) };
    });
    a.put('/api/admin/rules/:key', async (req, reply) => {
      const k = (req.params as { key: string }).key as RuleKey;
      if (!(k in RULE_FILES)) return reply.code(404).send({ error: 'unknown file' });
      try {
        const r = writeRuleFile(k, (req.body as { text: string }).text);
        return { ok: true, loadedAt: r.loadedAt };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });
    a.post('/api/admin/reload-rules', async () => ({ loadedAt: loadRules().loadedAt }));
  });

  // ----------------------------- FRONT -----------------------------
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
