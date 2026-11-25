import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from './db.js';
import { ensureSeed } from './seed.js';
import { classify, setAiConfig } from './classify.js';

describe('classification assistant (mocked API)', () => {
  let db: DB;
  beforeAll(async () => {
    db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cls-')), 't.sqlite'));
    process.env.SEED_DIR ??= path.resolve(__dirname, '../../seed');
    await ensureSeed(db, () => {});
    setAiConfig(db, { key: 'sk-ant-test', model: 'claude-sonnet-5-5' });
  });
  afterEach(() => vi.unstubAllGlobals());

  const reply = (content: unknown[]) => new Response(JSON.stringify({ content, stop_reason: 'tool_use' }), { status: 200 });

  it('runs the tool loop and returns a validated leaf code', async () => {
    const bodies: any[] = [];
    const answers = [
      reply([{ type: 'tool_use', id: 't1', name: 'list_lines', input: { prefix: '7326' } }]),
      reply([{ type: 'tool_use', id: 't2', name: 'final_answer', input: { summary: 'Steel bracket', candidates: [{ code: '7326.90.86.88', confidence: 82, reasoning: 'GRI 1, heading 7326' }] } }]),
    ];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), answers.shift()!)));
    const r = await classify(db, 'US', [{ role: 'user', text: 'machined steel bracket', images: [{ media_type: 'image/jpeg', data: 'AAAA' }] }], 'fr');
    expect(r.type).toBe('result');
    if (r.type !== 'result') return;
    expect(r.candidates[0]).toMatchObject({ code: '7326908688', valid: true, confidence: 82 });
    expect(bodies[0].messages[0].content[0].type).toBe('image');
    expect(bodies[1].messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(bodies[1].messages.at(-1).content[0].content).toContain('7326');
  });

  it('returns the questions to ask', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([{ type: 'tool_use', id: 'q', name: 'ask_questions', input: { questions: ['Quel matériau ?'] } }])));
    const r = await classify(db, 'US', [{ role: 'user', text: 'bracket' }], 'fr');
    expect(r).toEqual({ type: 'questions', questions: ['Quel matériau ?'], note: undefined });
  });

  it('flags an invented code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([{ type: 'tool_use', id: 'f', name: 'final_answer', input: { summary: 'x', candidates: [{ code: '0000.00.00.00', confidence: 50, reasoning: '?' }] } }])));
    const r = await classify(db, 'US', [{ role: 'user', text: 'x' }], 'en');
    expect(r.type === 'result' && r.candidates[0].valid).toBe(false);
  });
});
