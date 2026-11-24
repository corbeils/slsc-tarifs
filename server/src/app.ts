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
import { clearListCache } from './engine/common.js';
import { changePassword, createUser, deleteUser, listUsers, login, logout, resetPassword, sessionUser } from './auth.js';

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
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 20 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

  const bearer = (req: FastifyRequest) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = bearer(req);
    // ADMIN_TOKEN (optional) still works for scripts / API calls
    if (config.adminToken && (t === config.adminToken || req.headers['x-admin-token'] === config.adminToken)) {
      (req as FastifyRequest & { user?: unknown }).user = { id: '_token', username: 'API token', mustChange: false };
      return;
    }
    const u = sessionUser(db, t);
    if (!u) return reply.code(401).send({ error: 'Please sign in' });
    (req as FastifyRequest & { user?: unknown }).user = u;
  };
  const userOf = (req: FastifyRequest) => (req as FastifyRequest & { user: { id: string; username: string; mustChange: boolean } }).user;

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

  app.get('/api/search', async (req) => {
    const q = (req.query as { j?: string; q?: string; limit?: string }) ?? {};
    const j = q.j === 'CA' ? 'CA' : 'US';
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
      .header('Content-Disposition', 'attachment; filename="slsc-tariff-batch-template.xlsx"');
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
      direction: fields.direction === 'US-CA' ? 'US-CA' : 'CA-US',
      origin: (fields.origin || 'CA').toUpperCase(),
      currency: fields.currency === 'USD' ? 'USD' : 'CAD',
      preferential: fields.preferential === 'true',
      province: fields.province,
      mode: (fields.mode as CalcInput['mode']) || undefined,
    }, asLang(fields.lang));
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="simulation-${Date.now()}.xlsx"`)
      .header('X-Rows', String(r.rows))
      .header('X-Errors', String(r.errors));
    return reply.send(r.buffer);
  });

  // Résumé public des mesures (page « Mesures en vigueur »)
  app.get('/api/measures', async (req) => {
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

  // ----------------------------- ADMIN -----------------------------
  app.register(async (a) => {
    a.addHook('preHandler', admin);

    a.get('/api/admin/me', async (req) => userOf(req));
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
      const b = req.body as { username: string; password: string };
      try {
        createUser(db, b.username ?? '', b.password ?? '', true);
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
    a.post('/api/admin/site-version', async (req, reply) => {
      const b = (req.body ?? {}) as { version?: string; beta?: boolean };
      const version = String(b.version ?? '').trim().toUpperCase();
      if (!/^\d+\.\d+\.\d+(R\d+)?$/.test(version))
        return reply.code(400).send({ error: 'Invalid version: use 3 numbers, optionally followed by a revision (e.g. 1.3.0 or 1.1.4R2)' });
      const v = { version, beta: b.beta !== false, at: new Date().toISOString() };
      setMeta(db, 'site:version', v);
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
