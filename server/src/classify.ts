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
  | { type: 'result'; summary: string; candidates: Candidate[]; warnings?: string[]; model?: string };

export type Provider = 'anthropic' | 'openai' | 'qwen' | 'kimi' | 'deepseek' | 'gemini';
interface ProviderDef {
  label: string;
  baseUrl: string;
  model: string;
  models: string[];
  env: string;
  vision: boolean;
  /** OpenAI-compatible tool_choice value that forces a tool call ('auto' when 'required' is not supported). */
  toolChoice: 'required' | 'auto';
}
/** Model names are suggestions: each provider renames its models often, the field stays editable in Admin. */
export const PROVIDERS: Record<Provider, ProviderDef> = {
  anthropic: { label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], env: 'ANTHROPIC_API_KEY', vision: true, toolChoice: 'required' },
  openai: { label: 'OpenAI (ChatGPT)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'], env: 'OPENAI_API_KEY', vision: true, toolChoice: 'required' },
  qwen: { label: 'Qwen (Alibaba Cloud DashScope)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', models: ['qwen-vl-max', 'qwen-max', 'qwen-plus'], env: 'DASHSCOPE_API_KEY', vision: true, toolChoice: 'auto' },
  kimi: { label: 'Kimi (Moonshot AI)', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2-0905-preview', models: ['kimi-k2-0905-preview', 'moonshot-v1-32k-vision-preview', 'kimi-latest'], env: 'MOONSHOT_API_KEY', vision: false, toolChoice: 'auto' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], env: 'DEEPSEEK_API_KEY', vision: false, toolChoice: 'auto' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], env: 'GEMINI_API_KEY', vision: true, toolChoice: 'auto' },
};
const isProvider = (p: unknown): p is Provider => typeof p === 'string' && p in PROVIDERS;

interface StoredAi {
  provider?: Provider;
  providers?: Partial<Record<Provider, { key?: string; model?: string; baseUrl?: string; vision?: boolean }>>;
  /** v1 (Anthropic only) */
  key?: string;
  model?: string;
}
function stored(db: DB): StoredAi {
  const m = getMeta<StoredAi>(db, 'ai:config') ?? {};
  if (m.key && !m.providers) m.providers = { anthropic: { key: m.key, model: m.model } };
  return m;
}
export function aiConfig(db: DB, p?: Provider) {
  const m = stored(db);
  const provider: Provider = p ?? (isProvider(m.provider) ? m.provider : isProvider(process.env.AI_PROVIDER) ? process.env.AI_PROVIDER : 'anthropic');
  const def = PROVIDERS[provider];
  const own = m.providers?.[provider] ?? {};
  return {
    provider,
    key: own.key || process.env[def.env] || '',
    model: own.model || (provider === 'anthropic' ? process.env.ANTHROPIC_MODEL : undefined) || def.model,
    baseUrl: (own.baseUrl || (provider === 'anthropic' ? process.env.ANTHROPIC_BASE_URL : undefined) || def.baseUrl).replace(/\/+$/, ''),
    vision: own.vision ?? def.vision,
    fromEnv: !own.key && !!process.env[def.env],
  };
}
export function setAiConfig(db: DB, v: { provider?: string; key?: string; model?: string; baseUrl?: string; vision?: boolean; active?: boolean }) {
  const m = stored(db);
  const provider: Provider = isProvider(v.provider) ? v.provider : isProvider(m.provider) ? m.provider : 'anthropic';
  const cur = m.providers?.[provider] ?? {};
  const next = {
    key: v.key === undefined ? cur.key : v.key.trim(),
    model: v.model === undefined ? cur.model : v.model.trim(),
    baseUrl: v.baseUrl === undefined ? cur.baseUrl : v.baseUrl.trim(),
    vision: v.vision === undefined ? cur.vision : v.vision,
  };
  setMeta(db, 'ai:config', { provider: v.active === false ? m.provider : provider, providers: { ...(m.providers ?? {}), [provider]: next } });
  return publicAiConfig(db);
}
export function publicAiConfig(db: DB) {
  const active = aiConfig(db).provider;
  return {
    active,
    providers: (Object.keys(PROVIDERS) as Provider[]).map((p) => {
      const c = aiConfig(db, p);
      return {
        id: p,
        label: PROVIDERS[p].label,
        configured: !!c.key,
        keyHint: c.key ? `${c.key.slice(0, 6)}…${c.key.slice(-4)}` : '',
        model: c.model,
        models: PROVIDERS[p].models,
        baseUrl: c.baseUrl,
        defaultBaseUrl: PROVIDERS[p].baseUrl,
        vision: c.vision,
        fromEnv: c.fromEnv,
        env: PROVIDERS[p].env,
      };
    }),
  };
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

type Step = { calls: { id: string; name: string; input: Record<string, unknown> }[]; text: string };
type Ai = ReturnType<typeof aiConfig>;

/** Overloaded / rate-limited answers are retried (provider spikes are usually short). */
const RETRY = new Set([429, 500, 502, 503, 504, 529]);
export const retryDelays = [1500, 4000, 9000];

async function post(url: string, headers: Record<string, string>, body: unknown, label: string) {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      if (attempt < retryDelays.length) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        continue;
      }
      throw Object.assign(new Error(`${label}: network error (${(e as Error).message})`), { status: 502 });
    }
    if (res.ok) return res.json();
    const txt = await res.text();
    if (RETRY.has(res.status) && attempt < retryDelays.length) {
      const ra = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, ra > 0 && ra <= 20 ? ra * 1000 : retryDelays[attempt]));
      continue;
    }
    const busy = RETRY.has(res.status);
    throw Object.assign(
      new Error(
        busy
          ? `${label} is overloaded or rate-limited (HTTP ${res.status}) after ${retryDelays.length + 1} attempts. Try again in a few minutes, or pick another model / provider in Admin.`
          : `${label} API ${res.status}: ${txt.slice(0, 300)}`,
      ),
      { status: 502 },
    );
  }
}

/** One conversation driver per API family; both expose the same "step" (tool calls + text). */
function anthropicDriver(ai: Ai, system: string, turns: ChatTurn[]) {
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = turns.map((t) => ({
    role: t.role,
    content: [
      ...(t.images ?? []).slice(0, 4).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
      { type: 'text', text: t.text || '(see photos)' },
    ],
  }));
  let last: Block[] = [];
  return {
    async step(): Promise<Step> {
      const out = (await post(`${ai.baseUrl}/v1/messages`, { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01' }, { model: ai.model, max_tokens: 2048, system, tools: TOOLS, tool_choice: { type: 'any' }, messages }, 'Anthropic')) as {
        content: Block[];
      };
      last = out.content;
      return {
        calls: out.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, input: b.input ?? {} })),
        text: out.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      };
    },
    results(r: { id: string; content: string }[]) {
      messages.push({ role: 'assistant', content: last });
      messages.push({ role: 'user', content: r.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: x.content })) });
    },
  };
}

function openaiDriver(ai: Ai, system: string, turns: ChatTurn[]) {
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: system },
    ...turns.map((t) =>
      t.role === 'user' && t.images?.length && ai.vision
        ? {
            role: 'user',
            content: [{ type: 'text', text: t.text || '(see photos)' }, ...t.images.slice(0, 4).map((im) => ({ type: 'image_url', image_url: { url: `data:${im.media_type};base64,${im.data}` } }))],
          }
        : { role: t.role, content: t.text || '(see photos)' },
    ),
  ];
  const tools = TOOLS.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.input_schema } }));
  let last: Record<string, unknown> = {};
  return {
    async step(): Promise<Step> {
      const body: Record<string, unknown> = { model: ai.model, messages, tools, tool_choice: PROVIDERS[ai.provider].toolChoice };
      body[ai.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = 4096;
      const out = (await post(`${ai.baseUrl}/chat/completions`, { authorization: `Bearer ${ai.key}` }, body, PROVIDERS[ai.provider].label)) as {
        choices: { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; [k: string]: unknown } }[];
      };
      const msg = out.choices?.[0]?.message ?? {};
      last = { role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) };
      return {
        calls: (msg.tool_calls ?? []).map((c) => {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(c.function.arguments || '{}');
          } catch {
            /* malformed arguments: empty input */
          }
          return { id: c.id, name: c.function.name, input };
        }),
        text: msg.content ?? '',
      };
    },
    results(r: { id: string; content: string }[]) {
      messages.push(last);
      for (const x of r) messages.push({ role: 'tool', tool_call_id: x.id, content: x.content });
    },
  };
}

export async function classify(db: DB, j: ClassJ, turns: ChatTurn[], lang: string): Promise<ClassifyResult> {
  const ai = aiConfig(db);
  if (!ai.key) throw Object.assign(new Error('AI classification is not configured: add an API key in Admin.'), { status: 400 });
  const count = (db.prepare('SELECT COUNT(*) n FROM lines WHERE j = ?').get(j) as { n: number }).n;
  if (count < 50) throw Object.assign(new Error(`The ${j} tariff is not imported yet.`), { status: 400 });
  const hasImages = turns.some((t) => t.images?.length);
  const noVision = hasImages && !ai.vision;
  const system = SYSTEM(j, lang) + (noVision ? '\nNote: the user attached photos but this model cannot see images; rely on the text and ask about what the photos would show.' : '');
  const drv = ai.provider === 'anthropic' ? anthropicDriver(ai, system, turns) : openaiDriver(ai, system, turns);
  const warnVision = noVision ? [`${PROVIDERS[ai.provider].label} (${ai.model}): photos ignored (model without image input).`] : [];

  for (let step = 0; step < 12; step++) {
    const out = await drv.step();
    const fin = out.calls.find((c) => c.name === 'final_answer');
    if (fin) {
      const i = fin.input as { summary: string; candidates: { code: string; confidence: number; reasoning: string }[]; warnings?: string[] };
      return { type: 'result', summary: i.summary ?? '', candidates: (i.candidates ?? []).map((c) => enrich(db, j, c)), warnings: [...warnVision, ...(i.warnings ?? [])], model: `${PROVIDERS[ai.provider].label} · ${ai.model}` } as ClassifyResult;
    }
    const ask = out.calls.find((c) => c.name === 'ask_questions');
    if (ask) {
      const i = ask.input as { questions: string[]; note?: string };
      return { type: 'questions', questions: i.questions ?? [], note: [i.note, ...warnVision].filter(Boolean).join(' ') || undefined };
    }
    if (!out.calls.length) return { type: 'questions', questions: [out.text || 'Please describe the goods in more detail.'], note: warnVision[0] };
    drv.results(out.calls.map((c) => ({ id: c.id, content: runTool(db, j, c.name, c.input) })));
  }
  throw Object.assign(new Error('The classification did not converge; add details and try again.'), { status: 502 });
}
