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

  it('OpenAI-compatible providers (DeepSeek): function calling, photos dropped without vision', async () => {
    setAiConfig(db, { provider: 'deepseek', key: 'sk-ds', model: 'deepseek-chat' });
    const bodies: any[] = [];
    const urls: string[] = [];
    const answers = [
      { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_tariff', arguments: '{"query":"steel"}' } }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'final_answer', arguments: JSON.stringify({ summary: 'S', candidates: [{ code: '7326908688', confidence: 70, reasoning: 'r' }] }) } }] } }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => (urls.push(u), bodies.push(JSON.parse(String(init.body))), new Response(JSON.stringify(answers.shift()), { status: 200 }))));
    const r = await classify(db, 'US', [{ role: 'user', text: 'steel part', images: [{ media_type: 'image/jpeg', data: 'AAAA' }] }], 'en');
    expect(urls[0]).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(bodies[0].messages[0].role).toBe('system');
    expect(typeof bodies[0].messages[1].content).toBe('string');
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(r.type === 'result' && r.candidates[0].valid).toBe(true);
    expect(r.type === 'result' && r.warnings?.[0]).toContain('photos ignored');
    setAiConfig(db, { provider: 'anthropic' });
  });

  it('OpenAI sends images as data URLs', async () => {
    setAiConfig(db, { provider: 'openai', key: 'sk-oa', model: 'gpt-5' });
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'q', function: { name: 'ask_questions', arguments: '{"questions":["Material?"]}' } }] } }] }), { status: 200 }))));
    const r = await classify(db, 'US', [{ role: 'user', text: 'part', images: [{ media_type: 'image/jpeg', data: 'BBBB' }] }], 'en');
    expect(bodies[0].messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,BBBB');
    expect(bodies[0].tool_choice).toBe('required');
    expect(bodies[0].max_completion_tokens).toBe(4096);
    expect(r).toMatchObject({ type: 'questions', questions: ['Material?'] });
    setAiConfig(db, { provider: 'anthropic' });
  });
});
