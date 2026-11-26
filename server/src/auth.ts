import crypto from 'node:crypto';
import type { DB } from './db.js';

/** Default account created when no user exists. The password must be changed in the Admin panel. */
export const DEFAULT_USER = 'CORBEILS';
export const DEFAULT_PASSWORD = 'admin';
const SESSION_DAYS = 30;

export function migrateAuth(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,           -- lower-case username
      username TEXT NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      must_change INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  // v2: groups (admin / user) and per-account display preferences. Existing accounts stay administrators.
  const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  if (!cols.includes('prefs')) db.exec("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'");
  // v3: last sign-in and last activity (shown in Admin → USERS)
  if (!cols.includes('last_login')) db.exec('ALTER TABLE users ADD COLUMN last_login TEXT');
  if (!cols.includes('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen TEXT');
  const n = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n;
  if (n === 0) createUser(db, DEFAULT_USER, DEFAULT_PASSWORD, true, 'admin');
}

export type Role = 'admin' | 'user';
export const asRole = (r: unknown): Role => (r === 'admin' ? 'admin' : 'user');

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function createUser(db: DB, username: string, password: string, mustChange = false, role: Role = 'user') {
  const u = username.trim();
  if (!/^[A-Za-z0-9._@-]{2,40}$/.test(u)) throw new Error('Invalid username (2–40 characters: letters, digits, . _ - @)');
  if (password.length < 4) throw new Error('Password too short (min. 4 characters)');
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.toLowerCase())) throw new Error('This user already exists');
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (id, username, salt, hash, must_change, created_at, role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    u.toLowerCase(),
    u,
    salt,
    hash,
    mustChange ? 1 : 0,
    new Date().toISOString(),
    role,
  );
}

type UserRow = { id: string; username: string; salt: string; hash: string; must_change: number; created_at: string };

export function login(db: DB, username: string, password: string) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(username ?? '').trim().toLowerCase()) as UserRow | undefined;
  if (!u) return null;
  const { hash } = hashPassword(String(password ?? ''), u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, u.id, expires);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_login = ?, last_seen = ? WHERE id = ?').run(now, now, u.id);
  return { token, username: u.username, mustChange: !!u.must_change, role: asRole((u as UserRow & { role?: string }).role) };
}

export function sessionUser(db: DB, token: string) {
  if (!token) return null;
  const r = db
    .prepare('SELECT u.id, u.username, u.must_change, u.role, u.prefs, u.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
    .get(token, new Date().toISOString()) as { id: string; username: string; must_change: number; role: string; prefs: string; last_seen: string | null } | undefined;
  if (!r) return null;
  // Last activity, written at most every 5 minutes (sessions stay open for days, so the last sign-in alone can be old)
  if (!r.last_seen || Date.now() - Date.parse(r.last_seen) > 5 * 60_000) db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), r.id);
  let prefs: Record<string, string> = {};
  try {
    prefs = JSON.parse(r.prefs || '{}');
  } catch {
    /* ignore */
  }
  return { id: r.id, username: r.username, mustChange: !!r.must_change, role: asRole(r.role), prefs };
}

/** Display preferences saved with the account (language, display currency, theme). */
export function setPrefs(db: DB, userId: string, p: Record<string, unknown>) {
  const clean: Record<string, string> = {};
  if (p.lang === 'en' || p.lang === 'fr') clean.lang = p.lang;
  if (p.currency === 'CAD' || p.currency === 'USD' || p.currency === 'EUR') clean.currency = p.currency;
  if (p.theme === 'light' || p.theme === 'dark' || p.theme === 'system') clean.theme = p.theme;
  const cur = db.prepare('SELECT prefs FROM users WHERE id = ?').get(userId) as { prefs: string } | undefined;
  const next = { ...JSON.parse(cur?.prefs || '{}'), ...clean };
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), userId);
  return next;
}

export function setRole(db: DB, username: string, role: Role, selfId: string) {
  const id = username.toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new Error('Unknown user');
  if (role !== 'admin') {
    if (id === selfId) throw new Error('You cannot remove your own administrator rights');
    const admins = (db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND id != ?").get(id) as { n: number }).n;
    if (!admins) throw new Error('At least one administrator is required');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function logout(db: DB, token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function changePassword(db: DB, userId: string, current: string, next: string) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!u) throw new Error('Unknown user');
  if (hashPassword(current, u.salt).hash !== u.hash) throw new Error('Current password is incorrect');
  if (next.length < 4) throw new Error('New password too short (min. 4 characters)');
  const { salt, hash } = hashPassword(next);
  db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 0 WHERE id = ?').run(salt, hash, userId);
}

/** Change one's own user name (password confirmation required). Sessions follow the account. */
export function renameUser(db: DB, userId: string, newName: string, password: string) {
  const name = newName.trim();
  if (!/^[\w.@-]{2,40}$/.test(name)) throw new Error('User name: 2 to 40 characters (letters, digits, . _ - @)');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!u) throw new Error('Unknown user');
  if (hashPassword(password, u.salt).hash !== u.hash) throw new Error('Password is incorrect');
  const id = name.toLowerCase();
  if (id !== userId && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new Error('This user name is already taken');
  db.transaction(() => {
    db.prepare('UPDATE users SET id = ?, username = ? WHERE id = ?').run(id, name, userId);
    db.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(id, userId);
  })();
  return { username: name };
}

export function resetPassword(db: DB, username: string, next: string) {
  if (next.length < 4) throw new Error('Password too short (min. 4 characters)');
  const { salt, hash } = hashPassword(next);
  const r = db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1 WHERE id = ?').run(salt, hash, username.toLowerCase());
  if (!r.changes) throw new Error('Unknown user');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(username.toLowerCase());
}

export function listUsers(db: DB) {
  return db.prepare('SELECT username, must_change AS mustChange, created_at AS createdAt, role, last_login AS lastLogin, last_seen AS lastSeen FROM users ORDER BY username').all();
}

export function deleteUser(db: DB, username: string, selfId: string) {
  const id = username.toLowerCase();
  if (id === selfId) throw new Error('You cannot delete your own account');
  const admins = (db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND id != ?").get(id) as { n: number }).n;
  if (!admins) throw new Error('At least one administrator must remain');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
