// Customs news feed: official sources (rules/news.yaml) checked on a schedule and stored in the `news` table.
import crypto from 'node:crypto';
import type { DB } from '../db.js';
import { setMeta } from '../db.js';
import type { NewsRules, NewsSource } from '../rules.js';

export interface NewsItem {
  title: string;
  url: string;
  date: string; // YYYY-MM-DD
  summary: string;
  docType?: string;
}

export interface NewsSyncResult {
  id: string;
  source: string;
  ok: boolean;
  found: number;
  kept: number;
  added: number;
  error?: string;
}

const UA = 'Mozilla/5.0 (compatible; slsc-tariff-simulator news reader)';

async function fetchRaw(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', icirc: 'î', ucirc: 'û', Eacute: 'É' };
export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? m);
}
const strip = (s: string) => decode(decode(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Any date string → YYYY-MM-DD (empty if unreadable). */
export function isoDate(s: string): string {
  const t = s.trim();
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(t);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** RSS 2.0 (<item>) or Atom (<entry>). */
export function parseFeed(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const tag = (b: string, names: string[]) => {
    for (const n of names) {
      const m = b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
      if (m) return m[1];
    }
    return '';
  };
  for (const b of blocks) {
    const title = strip(tag(b, ['title']));
    let url = strip(tag(b, ['link']));
    if (!url) url = (b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ?? b.match(/<link[^>]*href=["']([^"']+)["']/i) ?? [])[1] ?? '';
    if (!url) url = strip(tag(b, ['guid', 'id']));
    url = decode(url).trim();
    const date = isoDate(strip(tag(b, ['pubDate', 'dc:date', 'published', 'updated'])));
    const summary = strip(tag(b, ['description', 'summary', 'content'])).slice(0, 600);
    if (title && /^https?:\/\//.test(url)) out.push({ title, url, date, summary });
  }
  return out;
}

/** Federal Register API (documents.json). */
export function parseFederalRegister(json: string): NewsItem[] {
  const j = JSON.parse(json) as { results?: { title: string; html_url: string; publication_date: string; abstract?: string | null; type?: string }[] };
  return (j.results ?? [])
    .filter((r) => r.title && r.html_url)
    .map((r) => ({ title: r.title, url: r.html_url, date: isoDate(r.publication_date ?? ''), summary: (r.abstract ?? '').slice(0, 600), docType: r.type ?? '' }));
}

/** CBSA Customs Notices list: one row per notice, link cnYY-NN-eng/fra.html, date YYYY-MM-DD in the same row. */
export function parseCbsa(html: string, base: string): NewsItem[] {
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  const rows = html.match(/<tr[\s>][\s\S]*?<\/tr>/gi);
  const chunks = rows?.length ? rows : html.split(/(?=<a\s[^>]*href=["'][^"']*cn\d{2}-\d+)/i);
  for (const row of chunks) {
    const a = row.match(/<a\s[^>]*href=["']([^"']*cn\d{2}-\d+[a-z]?-(?:eng|fra)\.html)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = new URL(decode(a[1]), base).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const cells = (row.match(/<td[\s>][\s\S]*?<\/td>/gi) ?? []).map(strip);
    const text = strip(row);
    const date = (text.match(/\d{4}-\d{2}-\d{2}/g) ?? []).at(-1) ?? '';
    // Title: the longest cell (the number cell only holds "26-28"), otherwise the link text
    const title = (cells.length ? cells.reduce((x, y) => (y.length > x.length ? y : x), '') : strip(a[2])) || strip(a[2]);
    const revised = /revised|révisé/i.test(text) ? (/fra\.html/.test(url) ? 'Révisé' : 'Revised') : '';
    out.push({ title: title.replace(/^(Revised|Révisé)\s*/i, ''), url, date, summary: '', docType: revised });
  }
  return out;
}

const keep = (s: NewsSource, it: NewsItem) => {
  if (!s.keywords?.length) return true;
  const hay = `${it.title} ${it.summary}`.toLowerCase();
  return s.keywords.some((k) => hay.includes(k.toLowerCase()));
};

const newsId = (sourceId: string, url: string) => crypto.createHash('sha1').update(`${sourceId}|${url}`).digest('hex').slice(0, 20);

export function saveNews(db: DB, s: NewsSource, items: NewsItem[], now = new Date().toISOString()): number {
  const ins = db.prepare(
    `INSERT INTO news (id, source_id, jurisdiction, lang, grp, title, url, date, summary, doc_type, first_seen)
     VALUES (@id, @source_id, @jurisdiction, @lang, @grp, @title, @url, @date, @summary, @doc_type, @first_seen)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, date = excluded.date, summary = excluded.summary, doc_type = excluded.doc_type`,
  );
  const exists = db.prepare('SELECT 1 FROM news WHERE id = ?');
  let added = 0;
  db.transaction(() => {
    for (const it of items) {
      const id = newsId(s.id, it.url);
      if (!exists.get(id)) added++;
      ins.run({
        id,
        source_id: s.id,
        jurisdiction: s.jurisdiction,
        lang: s.lang ?? '',
        grp: s.group ?? s.id,
        title: it.title.slice(0, 500),
        url: it.url,
        date: it.date || now.slice(0, 10),
        summary: it.summary,
        doc_type: it.docType ?? '',
        first_seen: now,
      });
    }
  })();
  return added;
}

export async function syncNews(db: DB, rules: NewsRules, fetcher: (url: string) => Promise<string> = fetchRaw): Promise<NewsSyncResult[]> {
  const results: NewsSyncResult[] = [];
  for (const s of rules.sources) {
    try {
      const raw = await fetcher(s.url);
      const items = s.kind === 'federalregister' ? parseFederalRegister(raw) : s.kind === 'cbsa' ? parseCbsa(raw, s.url) : parseFeed(raw);
      if (!items.length) throw new Error('No item found (page format changed or access blocked)');
      const kept = items.filter((it) => keep(s, it));
      const added = saveNews(db, s, kept);
      results.push({ id: s.id, source: s.source, ok: true, found: items.length, kept: kept.length, added });
    } catch (e) {
      results.push({ id: s.id, source: s.source, ok: false, found: 0, kept: 0, added: 0, error: (e as Error).message });
    }
  }
  const cutoff = new Date(Date.now() - rules.keepDays * 86400000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM news WHERE date < ?').run(cutoff);
  // Items of sources removed from news.yaml
  const ids = rules.sources.map((s) => s.id);
  if (ids.length) db.prepare(`DELETE FROM news WHERE source_id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
  setMeta(db, 'news:sync', { at: new Date().toISOString(), results });
  return results;
}

export interface NewsRow {
  id: string;
  source_id: string;
  jurisdiction: 'US' | 'CA' | 'EU';
  lang: string;
  grp: string;
  title: string;
  url: string;
  date: string;
  summary: string;
  doc_type: string;
  first_seen: string;
}

/** Items for one reader: when a source exists in English and French, only the reader's language is kept. */
export function listNews(db: DB, rules: NewsRules, o: { lang: 'en' | 'fr'; j?: string; q?: string; limit?: number }) {
  const bilingual = new Set(rules.sources.filter((s) => s.group && rules.sources.some((x) => x.group === s.group && x.lang && x.lang !== s.lang)).map((s) => s.group!));
  const where: string[] = [];
  const args: unknown[] = [];
  if (o.j && ['US', 'CA', 'EU'].includes(o.j)) {
    where.push('jurisdiction = ?');
    args.push(o.j);
  }
  if (o.q) {
    where.push('(title LIKE ? OR summary LIKE ?)');
    args.push(`%${o.q}%`, `%${o.q}%`);
  }
  const rows = db
    .prepare(`SELECT * FROM news ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, first_seen DESC LIMIT ?`)
    .all(...args, Math.min(o.limit ?? 150, 500) * 2) as NewsRow[];
  const names = new Map(rules.sources.map((s) => [s.id, s.source]));
  return rows
    .filter((r) => !bilingual.has(r.grp) || !r.lang || r.lang === o.lang)
    .slice(0, Math.min(o.limit ?? 150, 500))
    .map((r) => ({ ...r, source: names.get(r.source_id) ?? r.source_id }));
}
