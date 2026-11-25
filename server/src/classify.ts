/**
 * HS classification assistant (signed-in users): a description and/or photos → the tariff
 * line of the chosen country. Uses the Anthropic Messages API with tools that search the
 * tariffs stored in this database, so every proposed code exists in the imported tariff.
 */
import type { DB } from './db.js';
import { digits, getMeta, setMeta } from './db.js';

export type ClassJ = 'US' | 'CA' | 'EU';
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  images?: { media_type: string; data: string }[];
}
export interface Candidate {
  code: string;
  display?: string;
  description?: string;
  path?: string;
  confidence: number;
  reasoning: string;
  rate?: string | null;
  valid: boolean;
}
export type ClassifyResult =
  | { type: 'questions'; questions: string[]; note?: string }
  | { type: 'result'; summary: string; candidates: Candidate[]; warnings?: string[] };

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];

export function aiConfig(db: DB): { key: string; model: string } {
  const m = getMeta<{ key?: string; model?: string }>(db, 'ai:config') ?? {};
  return { key: m.key || process.env.ANTHROPIC_API_KEY || '', model: m.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL };
}
export function setAiConfig(db: DB, v: { key?: string; model?: string }) {
  const cur = getMeta<{ key?: string; model?: string }>(db, 'ai:config') ?? {};
  const next = { key: v.key === undefined ? cur.key : v.key.trim(), model: v.model || cur.model || DEFAULT_MODEL };
  setMeta(db, 'ai:config', next);
  return publicAiConfig(db);
}
export function publicAiConfig(db: DB) {
  const c = aiConfig(db);
  return { configured: !!c.key, keyHint: c.key ? `${c.key.slice(0, 7)}…${c.key.slice(-4)}` : '', model: c.model, models: MODELS, fromEnv: !getMeta<{ key?: string }>(db, 'ai:config')?.key && !!process.env.ANTHROPIC_API_KEY };
}

const NAMES: Record<ClassJ, string> = {
  US: 'Harmonized Tariff Schedule of the United States (HTSUS), 10-digit statistical reporting numbers',
  CA: 'Customs Tariff of Canada, 10-digit classification numbers (8-digit tariff item + 2-digit statistical suffix)',
  EU: 'EU Combined Nomenclature / TARIC, 10-digit TARIC codes',
};

const SYSTEM = (j: ClassJ, lang: string) => `You are a senior licensed customs broker and tariff classification specialist.
Classify the goods the user describes (text and/or photos) in the ${NAMES[j]}.

Method:
- Apply the General Rules of Interpretation (GRI 1 to 6) in order, the Section and Chapter notes and, when useful, the HS Explanatory Notes.
- Identify what the article is, its function, material, state, and how it is presented. For machines, think about principal function (Section XVI note 3, note 5), parts (Section XVI note 2) and composite machines.
- Use the tools to search the tariff that is loaded in this system. Only propose codes returned by the tools: never invent a code. Drill down with list_lines until you reach a declarable (leaf) line.
- If information that changes the classification is missing (material, function, power source, use, dimensions, assembled or not, etc.), call ask_questions with at most 4 short, precise questions — only questions whose answer changes the code. Do not ask questions when the classification is already clear.
- When done, call final_answer with 1 to 3 candidate leaf codes, the most likely first, with a confidence (0-100) and a short justification citing the GRI / notes applied.
- Write the questions, summary and justifications in ${lang === 'fr' ? 'French' : 'English'}. Tariff descriptions stay as written in the tariff.
- This is guidance, not a binding ruling.`;

const TOOLS = [
  {
    name: 'search_tariff',
    description: 'Full-text search of the tariff descriptions (English keywords). Returns up to 25 lines with code, description, hierarchy path and whether the line is declarable (leaf).',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'English keywords, e.g. "forging press" or "hydraulic cylinder"' } }, required: ['query'] },
  },
  {
    name: 'list_lines',
    description: 'Lists the lines under a code prefix (chapter "84", heading "8462", subheading "846211", etc.) with descriptions, indentation and leaf flag. Use it to read a heading and drill down.',
    input_schema: { type: 'object', properties: { prefix: { type: 'string', description: '2 to 8 digits' } }, required: ['prefix'] },
  },
  {
    name: 'ask_questions',
    description: 'Ask the user the questions needed to finish the classification (max 4). Ends the turn.',
    input_schema: {
      type: 'object',
      properties: { questions: { type: 'array', items: { type: 'string' }, maxItems: 4 }, note: { type: 'string', description: 'Optional: what is already established' } },
      required: ['questions'],
    },
  },
  {
    name: 'final_answer',
    description: 'Give the classification. Ends the turn.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Short description of the goods as classified' },
        candidates: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: { code: { type: 'string' }, confidence: { type: 'number' }, reasoning: { type: 'string' } },
            required: ['code', 'confidence', 'reasoning'],
          },
        },
        warnings: { type: 'array', items: { type: 'string' }, description: 'e.g. possible AD/CVD, licence, ruling recommended' },
      },
      required: ['summary', 'candidates'],
    },
  },
];

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; [k: string]: unknown };

function runTool(db: DB, j: ClassJ, name: string, input: Record<string, unknown>): string {
  if (name === 'search_tariff') {
    const fts = String(input.query ?? '')
      .replace(/["*()]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w}"*`)
      .join(' ');
    if (!fts) return '[]';
    const rows = db
      .prepare(
        `SELECT l.display, l.description, l.path, l.is_leaf leaf FROM lines_fts f JOIN lines l ON l.j = f.j AND l.code = f.code
         WHERE lines_fts MATCH ? AND f.j = ? AND l.code NOT LIKE '99%' ORDER BY l.is_leaf DESC, rank LIMIT 25`,
      )
      .all(fts, j);
    return JSON.stringify(rows);
  }
  if (name === 'list_lines') {
    const p = digits(String(input.prefix ?? '')).slice(0, 8);
    if (p.length < 2) return 'prefix must have 2 to 8 digits';
    const rows = db.prepare(`SELECT display, description, indent, is_leaf leaf, general rate FROM lines WHERE j = ? AND code LIKE ? ORDER BY code LIMIT 150`).all(j, p + '%');
    return rows.length ? JSON.stringify(rows) : `no line starts with ${p}`;
  }
  return 'unknown tool';
}

function enrich(db: DB, j: ClassJ, c: { code: string; confidence: number; reasoning: string }): Candidate {
  const d = digits(c.code);
  const row = (db.prepare('SELECT code, display, description, path, is_leaf, general FROM lines WHERE j = ? AND code = ?').get(j, d) ??
    db.prepare('SELECT code, display, description, path, is_leaf, general FROM lines WHERE j = ? AND code LIKE ? AND is_leaf = 1 ORDER BY code LIMIT 1').get(j, d + '%')) as
    | { code: string; display: string; description: string; path: string; is_leaf: number; general: string | null }
    | undefined;
  let rate = row?.general ?? null;
  if (j === 'EU' && row) {
    const cc = [2, 4, 6, 8, 10].map((n) => row.code.slice(0, n).padEnd(10, '0'));
    rate = (db.prepare(`SELECT duty FROM eu_measures WHERE type = '103' AND origin = '1011' AND code IN (?,?,?,?,?) ORDER BY length(rtrim(code, '0')) DESC LIMIT 1`).get(...cc) as { duty: string } | undefined)?.duty ?? null;
  }
  return {
    code: row?.code ?? d,
    display: row?.display ?? c.code,
    description: row?.description,
    path: row?.path,
    confidence: Math.max(0, Math.min(100, Math.round(c.confidence))),
    reasoning: c.reasoning,
    rate,
    valid: !!row,
  };
}

export async function classify(db: DB, j: ClassJ, turns: ChatTurn[], lang: string): Promise<ClassifyResult> {
  const { key, model } = aiConfig(db);
  if (!key) throw Object.assign(new Error('AI classification is not configured: add an Anthropic API key in Admin.'), { status: 400 });
  const count = (db.prepare('SELECT COUNT(*) n FROM lines WHERE j = ?').get(j) as { n: number }).n;
  if (count < 50) throw Object.assign(new Error(`The ${j} tariff is not imported yet.`), { status: 400 });

  const messages: { role: 'user' | 'assistant'; content: unknown }[] = turns.map((t) => ({
    role: t.role,
    content: [
      ...(t.images ?? []).slice(0, 4).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
      { type: 'text', text: t.text || '(see photos)' },
    ],
  }));

  for (let step = 0; step < 10; step++) {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2048, system: SYSTEM(j, lang), tools: TOOLS, tool_choice: { type: 'any' }, messages }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw Object.assign(new Error(`Anthropic API ${res.status}: ${txt.slice(0, 300)}`), { status: 502 });
    }
    const out = (await res.json()) as { content: Block[]; stop_reason: string };
    const uses = out.content.filter((b) => b.type === 'tool_use');
    const fin = uses.find((b) => b.name === 'final_answer');
    if (fin) {
      const i = fin.input as { summary: string; candidates: { code: string; confidence: number; reasoning: string }[]; warnings?: string[] };
      return { type: 'result', summary: i.summary, candidates: (i.candidates ?? []).map((c) => enrich(db, j, c)), warnings: i.warnings };
    }
    const ask = uses.find((b) => b.name === 'ask_questions');
    if (ask) {
      const i = ask.input as { questions: string[]; note?: string };
      return { type: 'questions', questions: i.questions ?? [], note: i.note };
    }
    if (!uses.length) {
      const text = out.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { type: 'questions', questions: [text || 'Please describe the goods in more detail.'] };
    }
    messages.push({ role: 'assistant', content: out.content });
    messages.push({
      role: 'user',
      content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: runTool(db, j, u.name!, u.input ?? {}) })),
    });
  }
  throw Object.assign(new Error('The classification did not converge; add details and try again.'), { status: 502 });
}
