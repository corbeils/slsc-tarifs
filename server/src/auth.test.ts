import { describe, expect, it } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { createUser, deleteUser, login, migrateAuth, sessionUser, setPrefs, setRole } from './auth.js';

const fresh = () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')), 't.sqlite'));
  migrateAuth(db);
  return db;
};

describe('user groups', () => {
  it('creates USER accounts, keeps an admin and stores preferences', () => {
    const db = fresh();
    createUser(db, 'jdoe', 'secret12', true, 'user');
    const s = login(db, 'jdoe', 'secret12');
    expect(s.role).toBe('user');
    const u = sessionUser(db, s.token)!;
    setPrefs(db, u.id, { lang: 'fr', currency: 'EUR', theme: 'dark', junk: 'x' });
    expect(sessionUser(db, s.token)!.prefs).toEqual({ lang: 'fr', currency: 'EUR', theme: 'dark' });
    const a = sessionUser(db, login(db, 'CORBEILS', 'admin').token)!;
    expect(a.role).toBe('admin');
    expect(() => setRole(db, 'CORBEILS', 'user', a.id)).toThrow();
    expect(() => deleteUser(db, 'CORBEILS', u.id)).toThrow();
    setRole(db, 'jdoe', 'admin', a.id);
    expect(sessionUser(db, s.token)!.role).toBe('admin');
  });
});
