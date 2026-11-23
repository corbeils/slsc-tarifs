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
  const n = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n;
  if (n === 0) createUser(db, DEFAULT_USER, DEFAULT_PASSWORD, true);
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function createUser(db: DB, username: string, password: string, mustChange = false) {
  const u = username.trim();
  if (!/^[A-Za-z0-9._@-]{2,40}$/.test(u)) throw new Error('Invalid username (2–40 characters: letters, digits, . _ - @)');
  if (password.length < 4) throw new Error('Password too short (min. 4 characters)');
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.toLowerCase())) throw new Error('This user already exists');
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (id, username, salt, hash, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    u.toLowerCase(),
    u,
    salt,
    hash,
    mustChange ? 1 : 0,
    new Date().toISOString(),
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
  return { token, username: u.username, mustChange: !!u.must_change };
}

export function sessionUser(db: DB, token: string) {
  if (!token) return null;
  const r = db
    .prepare('SELECT u.id, u.username, u.must_change FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
    .get(token, new Date().toISOString()) as { id: string; username: string; must_change: number } | undefined;
  return r ? { id: r.id, username: r.username, mustChange: !!r.must_change } : null;
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

export function resetPassword(db: DB, username: string, next: string) {
  if (next.length < 4) throw new Error('Password too short (min. 4 characters)');
  const { salt, hash } = hashPassword(next);
  const r = db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = 1 WHERE id = ?').run(salt, hash, username.toLowerCase());
  if (!r.changes) throw new Error('Unknown user');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(username.toLowerCase());
}

export function listUsers(db: DB) {
  return db.prepare('SELECT username, must_change AS mustChange, created_at AS createdAt FROM users ORDER BY username').all();
}

export function deleteUser(db: DB, username: string, selfId: string) {
  const id = username.toLowerCase();
  if (id === selfId) throw new Error('You cannot delete your own account');
  const n = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n;
  if (n <= 1) throw new Error('At least one administrator must remain');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
