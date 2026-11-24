import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules } from '../rules.js';
import { FR } from './fr.js';
import { TEXT_KEYS, localizeRules, t, withLang } from './index.js';

const root = join(__dirname, '..', '..', '..');

describe('i18n FR', () => {
  it('translates every descriptive text of the rules', () => {
    const R = loadRules(join(root, 'rules'));
    const missing = new Set<string>();
    const walk = (o: unknown, k?: string) => {
      if (typeof o === 'string') {
        if (k && TEXT_KEYS.has(k) && /[a-z]{3}/.test(o) && !FR[o]) missing.add(o);
      } else if (Array.isArray(o)) o.forEach((x) => walk(x, k));
      else if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) if (kk !== 'companies') walk(v, kk);
    };
    walk(R);
    expect([...missing]).toEqual([]);
    expect(localizeRules(R, 'fr').us.fees.mpf.label).toBe('Frais de traitement des marchandises (MPF)');
  });

  it('translates every t() key used in the server code', () => {
    const dir = join(root, 'server', 'src');
    const files: string[] = [];
    const scan = (d: string) =>
      readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? scan(join(d, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && files.push(join(d, e.name))));
    scan(dir);
    const missing: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\b[tT]\((?:[^'()]*?\?\s*)?'((?:[^'\\]|\\.)+)'(?:\s*:\s*'((?:[^'\\]|\\.)+)')?/g))
        for (const g of [m[1], m[2]]) if (g && !FR[g.replace(/\\'/g, "'")]) missing.push(g);
    }
    expect(missing).toEqual([]);
  });

  it('fills placeholders and falls back to English', () => {
    expect(withLang('fr', () => t('Scope: {via}', { via: 'x' }))).toBe('Portée : x');
    expect(withLang('fr', () => t('Unknown string'))).toBe('Unknown string');
    expect(t('Scope: {via}', { via: 'x' })).toBe('Scope: x');
  });
});
