import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { isoDate, listNews, parseCbsa, parseFederalRegister, parseFeed, syncNews } from './news.js';
import type { NewsRules } from '../rules.js';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>OJ L</title>
<item><title><![CDATA[Commission Implementing Regulation (EU) 2026/2300 imposing a definitive anti-dumping duty on steel wire]]></title>
<link>https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202602300</link><pubDate>Wed, 25 Nov 2026 10:00:00 +0100</pubDate>
<description>&lt;p&gt;Anti-dumping &amp;amp; more&lt;/p&gt;</description></item>
<item><title>Council Decision on fisheries</title><link>https://eur-lex.europa.eu/x2</link><pubDate>Tue, 24 Nov 2026 10:00:00 +0100</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><subtitle>News</subtitle>
<entry><title>Canada modifies tariff relief measures</title><id>urn:1</id><updated>2026-11-09T10:00:00-05:00</updated>
<link href="https://www.canada.ca/en/department-finance/news/2026/11/relief.html"/><summary>Surtax remission extended.</summary></entry>
<entry><title>Biographical notes</title><updated>2026-11-08T10:00:00-05:00</updated><link href="https://www.canada.ca/bio.html"/><summary>x</summary></entry>
</feed>`;

const FR = JSON.stringify({
  count: 1,
  results: [
    { title: 'Notice of Proposed Action: Structural Excess Capacity', type: 'Notice', abstract: 'USTR proposes tariffs.', html_url: 'https://www.federalregister.gov/documents/2026/11/27/2026-1/x', publication_date: '2026-11-27' },
  ],
});

const CBSA = `<table><thead><tr><th>Number</th><th>Title</th><th>Regulatory Impact</th><th>Updated</th></tr></thead><tbody>
<tr><td><a href="https://www.cbsa-asfc.gc.ca/publications/cn-ad/cn26-28-eng.html">26-28</a></td><td>Customs Notice 26-28: Courier Low Value Shipment Program Moratorium</td><td>No</td><td>2026-11-25</td></tr>
<tr><td><a href="cn26-23-eng.html">26-23</a></td><td>Customs Notice 26-23: United States Surtax Order (2026)</td><td>No</td><td><strong>Revised</strong> 2026-10-23</td></tr>
</tbody></table>`;

describe('news parsers', () => {
  it('RSS 2.0 with CDATA and entities', () => {
    const r = parseFeed(RSS);
    expect(r).toHaveLength(2);
    expect(r[0].title).toMatch(/^Commission Implementing Regulation/);
    expect(r[0].date).toBe('2026-11-25');
    expect(r[0].summary).toBe('Anti-dumping & more');
  });
  it('Atom with link href', () => {
    const r = parseFeed(ATOM);
    expect(r[0]).toMatchObject({ title: 'Canada modifies tariff relief measures', url: 'https://www.canada.ca/en/department-finance/news/2026/11/relief.html', date: '2026-11-09' });
  });
  it('Federal Register JSON', () => {
    expect(parseFederalRegister(FR)[0]).toMatchObject({ date: '2026-11-27', docType: 'Notice' });
  });
  it('CBSA notices table (absolute and relative links, revised)', () => {
    const r = parseCbsa(CBSA, 'https://www.cbsa-asfc.gc.ca/publications/cn-ad/menu-eng.html');
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'Customs Notice 26-28: Courier Low Value Shipment Program Moratorium', date: '2026-11-25' });
    expect(r[1].url).toBe('https://www.cbsa-asfc.gc.ca/publications/cn-ad/cn26-23-eng.html');
    expect(r[1].docType).toBe('Revised');
  });
  it('dates', () => {
    expect(isoDate('Wed, 18 Nov 2026 09:00:00 -0500')).toBe('2026-11-18');
    expect(isoDate('nonsense')).toBe('');
  });
});

describe('news sync', () => {
  it('keywords, bilingual sources, errors per source', async () => {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'news-')), 't.sqlite'));
    const rules: NewsRules = {
      keepDays: 4000,
      sources: [
        { id: 'eu', source: 'OJ', jurisdiction: 'EU', kind: 'feed', url: 'rss', keywords: ['anti-dumping'] },
        { id: 'ca-en', source: 'Finance', jurisdiction: 'CA', kind: 'feed', url: 'atom-en', lang: 'en', group: 'fin' },
        { id: 'ca-fr', source: 'Finances', jurisdiction: 'CA', kind: 'feed', url: 'atom-fr', lang: 'fr', group: 'fin' },
        { id: 'us', source: 'USTR', jurisdiction: 'US', kind: 'federalregister', url: 'fr' },
        { id: 'down', source: 'Down', jurisdiction: 'US', kind: 'feed', url: 'down' },
      ],
    };
    const fetcher = async (u: string) => {
      if (u === 'down') throw new Error('HTTP 403');
      return u === 'rss' ? RSS : u === 'fr' ? FR : ATOM.replace(/canada\.ca\//g, `canada.ca/${u}/`);
    };
    const res = await syncNews(db, rules, fetcher);
    expect(res.find((r) => r.id === 'eu')).toMatchObject({ ok: true, found: 2, kept: 1, added: 1 });
    expect(res.find((r) => r.id === 'down')).toMatchObject({ ok: false, error: 'HTTP 403' });
    const again = await syncNews(db, rules, fetcher);
    expect(again.find((r) => r.id === 'eu')!.added).toBe(0);
    const en = listNews(db, rules, { lang: 'en' });
    expect(en.some((x) => x.source_id === 'ca-fr')).toBe(false);
    expect(en.some((x) => x.source_id === 'ca-en')).toBe(true);
    expect(listNews(db, rules, { lang: 'fr', j: 'CA' }).every((x) => x.source_id === 'ca-fr')).toBe(true);
    expect(listNews(db, rules, { lang: 'en', j: 'US' })).toHaveLength(1);
    expect(listNews(db, rules, { lang: 'en', q: 'dumping' })).toHaveLength(1);
  });
});
