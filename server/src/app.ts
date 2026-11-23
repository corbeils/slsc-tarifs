import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import type { DB } from './db.js';
import { digits, getMeta } from './db.js';
import { listCountries } from './countries.js';
import { getRules, loadRules, readRuleFile, RULE_FILES, type RuleKey, writeRuleFile } from './rules.js';
import { calculate, currentFx } from './engine/index.js';
import type { CalcInput } from './engine/types.js';
import { importUsFile, importUsOnline } from './importers/us-hts.js';
import { importCaFile, importCaUrl } from './importers/ca-tariff.js';
import { extractCodes, fetchText, importAdcvdCsv, importFx, importPgaCsv, saveCodeList, setFxManual } from './importers/misc.js';
import { runBatch } from './batch.js';
import { clearListCache } from './engine/common.js';

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

  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.adminToken) return reply.code(403).send({ error: 'Admin désactivé : définir la variable ADMIN_TOKEN.' });
    const h = (req.headers['x-admin-token'] as string) ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (h !== config.adminToken) return reply.code(401).send({ error: 'Jeton admin invalide' });
  };

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/meta', async () => {
    const count = (j: string) => (db.prepare('SELECT COUNT(*) n FROM lines WHERE j = ?').get(j) as { n: number }).n;
    const lists = db.prepare('SELECT measure_id, COUNT(*) n, MAX(added_at) at FROM code_lists GROUP BY measure_id').all();
    return {
      us: { ...(getMeta(db, 'import:US') ?? {}), lines: count('US') },
      ca: { ...(getMeta(db, 'import:CA') ?? {}), lines: count('CA') },
      pga: getMeta(db, 'import:PGA'),
      fx: currentFx(db),
      rulesLoadedAt: getRules().loadedAt,
      codeLists: lists,
      adminEnabled: !!config.adminToken,
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
    if (!line) return reply.code(404).send({ error: 'introuvable' });
    const children = db
      .prepare('SELECT code, display, description, general, is_leaf FROM lines WHERE j = ? AND code LIKE ? AND code != ? ORDER BY code LIMIT 200')
      .all(j, c + '%', c);
    return { line, children };
  });

  app.post('/api/calc', async (req, reply) => {
    const input = req.body as CalcInput;
    if (!input?.code || !input.direction) return reply.code(400).send({ error: 'code et direction requis' });
    return calculate(db, getRules(), { ...input, value: Number(input.value) || 0 });
  });

  app.post('/api/batch', async (req, reply) => {
    const parts = req.parts();
    let file: { buf: Buffer; name: string } | null = null;
    const fields: Record<string, string> = {};
    for await (const p of parts) {
      if (p.type === 'file') file = { buf: await p.toBuffer(), name: p.filename };
      else fields[p.fieldname] = String(p.value);
    }
    if (!file) return reply.code(400).send({ error: 'Fichier manquant' });
    const r = await runBatch(db, getRules(), file.buf, file.name, {
      direction: fields.direction === 'US-CA' ? 'US-CA' : 'CA-US',
      origin: (fields.origin || 'CA').toUpperCase(),
      currency: fields.currency === 'USD' ? 'USD' : 'CAD',
      preferential: fields.preferential === 'true',
      province: fields.province,
      mode: (fields.mode as CalcInput['mode']) || undefined,
    });
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="simulation-${Date.now()}.xlsx"`)
      .header('X-Rows', String(r.rows))
      .header('X-Errors', String(r.errors));
    return reply.send(r.buffer);
  });

  // Résumé public des mesures (page « Mesures en vigueur »)
  app.get('/api/measures', async () => {
    const R = getRules();
    const lists = Object.fromEntries(
      (db.prepare('SELECT measure_id, COUNT(*) n FROM code_lists GROUP BY measure_id').all() as { measure_id: string; n: number }[]).map((r) => [
        r.measure_id,
        r.n,
      ]),
    );
    const ch99 = db.prepare('SELECT COUNT(*) n FROM ch99').get() as { n: number };
    return {
      us: {
        programs: R.us.programs.map((p) => ({ id: p.id, name: p.name, family: p.family, prefixes: p.prefixes, status: p.status, note: p.note, url: p.url, options: p.options })),
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

    a.get('/api/admin/check', async () => ({ ok: true }));

    a.post('/api/admin/import/us', async () => {
      const job = startJob('import-us', (log) => importUsOnline(db, log));
      return { job: job.id };
    });
    a.post('/api/admin/import/us-file', async (req, reply) => {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: 'Fichier manquant' });
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
      if (!f) return reply.code(400).send({ error: 'Fichier manquant' });
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
    a.post('/api/admin/import/fx', async () => importFx(db));
    a.post('/api/admin/fx', async (req) => setFxManual(db, Number((req.body as { rate: number }).rate)));

    a.get('/api/admin/jobs/:id', async (req, reply) => {
      const j = jobs.get((req.params as { id: string }).id);
      return j ?? reply.code(404).send({ error: 'tâche inconnue' });
    });

    a.get('/api/admin/codes/:id', async (req) =>
      db.prepare('SELECT code, rate, source, added_at FROM code_lists WHERE measure_id = ? ORDER BY code').all((req.params as { id: string }).id),
    );
    a.post('/api/admin/codes', async (req, reply) => {
      const b = req.body as { measureId: string; text?: string; url?: string; replace?: boolean; withRates?: boolean; rate?: number | null };
      if (!b.measureId) return reply.code(400).send({ error: 'measureId requis' });
      const text = b.url ? await fetchText(b.url) : b.text ?? '';
      const codes = extractCodes(text, !!b.withRates);
      if (!codes.length) return reply.code(400).send({ error: 'Aucun numéro tarifaire détecté' });
      return { ...saveCodeList(db, b.measureId, codes, { replace: b.replace, source: b.url ?? 'collé', rate: b.rate ?? null }), sample: codes.slice(0, 10) };
    });
    a.delete('/api/admin/codes/:id', async (req) => {
      db.prepare('DELETE FROM code_lists WHERE measure_id = ?').run((req.params as { id: string }).id);
      clearListCache();
      return { ok: true };
    });

    a.post('/api/admin/import/pga', async (req, reply) => {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: 'Fichier manquant' });
      return importPgaCsv(db, (await f.toBuffer()).toString('utf8'));
    });
    a.post('/api/admin/import/adcvd', async (req, reply) => {
      const f = await req.file();
      if (!f) return reply.code(400).send({ error: 'Fichier manquant' });
      return importAdcvdCsv(db, (await f.toBuffer()).toString('utf8'));
    });

    a.get('/api/admin/rules/:key', async (req, reply) => {
      const k = (req.params as { key: string }).key as RuleKey;
      if (!(k in RULE_FILES)) return reply.code(404).send({ error: 'fichier inconnu' });
      return { key: k, file: RULE_FILES[k].file, text: readRuleFile(k) };
    });
    a.put('/api/admin/rules/:key', async (req, reply) => {
      const k = (req.params as { key: string }).key as RuleKey;
      if (!(k in RULE_FILES)) return reply.code(404).send({ error: 'fichier inconnu' });
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
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'introuvable' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
