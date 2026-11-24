import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { migrateAuth } from './auth.js';

export type DB = Database.Database;

export interface LineRow {
  j: 'US' | 'CA' | 'EU';
  code: string; // chiffres seulement
  display: string; // avec points
  indent: number;
  description: string;
  path: string;
  units: string | null;
  general: string | null; // US: colonne 1 générale / CA: NPF (MFN)
  special: string | null; // US: colonne spéciale / CA: tarifs préférentiels (texte brut)
  other: string | null; // US: colonne 2 / CA: tarif général
  pref_json: string | null; // CA: {UST: "Free", ...} / US: {S: "Free", ...}
  refs: string | null; // renvois ch.99 (colonne générale), séparés par des virgules
  refs_other: string | null; // renvois ch.99 (colonne 2)
  notes: string | null; // texte des notes de bas de page
  rate_from: string | null; // code de la ligne d'où proviennent les taux (héritage)
  is_leaf: number;
  source: string;
}

export interface Ch99Row {
  code: string;
  display: string;
  description: string;
  general: string;
  add_pct: number | null;
  kind: 'duty' | 'exemption' | 'other';
  countries: string | null; // ISO2 détectés (JSON)
  except_countries: string | null;
}

export function openDb(file = path.join(config.dataDir, 'tarifs.sqlite')): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  migrateAuth(db);
  return db;
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lines (
      j TEXT NOT NULL,
      code TEXT NOT NULL,
      display TEXT NOT NULL,
      indent INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      units TEXT,
      general TEXT,
      special TEXT,
      other TEXT,
      pref_json TEXT,
      refs TEXT,
      refs_other TEXT,
      notes TEXT,
      rate_from TEXT,
      is_leaf INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (j, code)
    );
    CREATE INDEX IF NOT EXISTS idx_lines_code ON lines(code);
    CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(
      j UNINDEXED, code UNINDEXED, display, description, path,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS ch99 (
      code TEXT PRIMARY KEY,
      display TEXT NOT NULL,
      description TEXT NOT NULL,
      general TEXT,
      add_pct REAL,
      kind TEXT NOT NULL,
      countries TEXT,
      except_countries TEXT
    );
    CREATE TABLE IF NOT EXISTS code_lists (
      measure_id TEXT NOT NULL,
      code TEXT NOT NULL,
      rate REAL,
      source TEXT,
      added_at TEXT NOT NULL,
      PRIMARY KEY (measure_id, code)
    );
    CREATE TABLE IF NOT EXISTS pga_flags (
      code TEXT NOT NULL,
      flag TEXT NOT NULL,
      PRIMARY KEY (code, flag)
    );
    CREATE TABLE IF NOT EXISTS adcvd_import (
      j TEXT NOT NULL,
      case_no TEXT NOT NULL,
      product TEXT,
      country TEXT,
      prefixes TEXT,
      ad_rate REAL,
      cvd_rate REAL,
      note TEXT,
      url TEXT,
      PRIMARY KEY (j, case_no, country)
    );
    CREATE TABLE IF NOT EXISTS eu_measures (
      code TEXT NOT NULL,
      add_code TEXT NOT NULL DEFAULT '',
      order_no TEXT NOT NULL DEFAULT '',
      start TEXT NOT NULL DEFAULT '',
      end TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL,
      origin_desc TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      type_desc TEXT NOT NULL DEFAULT '',
      duty TEXT NOT NULL DEFAULT '',
      legal TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_eu_measures_code ON eu_measures(code);
    CREATE INDEX IF NOT EXISTS idx_eu_measures_type ON eu_measures(type);
    CREATE TABLE IF NOT EXISTS eu_geo (
      grp TEXT NOT NULL,
      member TEXT NOT NULL,
      start TEXT NOT NULL DEFAULT '',
      end TEXT NOT NULL DEFAULT '',
      grp_desc TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_eu_geo_member ON eu_geo(member);
    CREATE TABLE IF NOT EXISTS eu_excl (
      code TEXT NOT NULL,
      type TEXT NOT NULL,
      grp TEXT NOT NULL,
      excluded TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eu_excl_code ON eu_excl(code);
    CREATE TABLE IF NOT EXISTS eu_addcodes (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export function setMeta(db: DB, key: string, value: unknown) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export function getMeta<T = unknown>(db: DB, key: string): T | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : null;
}

export const digits = (s: string) => (s ?? '').replace(/[^0-9]/g, '');

/** Formate un code numérique en notation à points (8462110010 -> 8462.11.00.10). */
export function formatCode(d: string): string {
  const c = digits(d);
  if (c.length <= 4) return c;
  const parts = [c.slice(0, 4), c.slice(4, 6), c.slice(6, 8), c.slice(8, 10)].filter(Boolean);
  return parts.join('.');
}
