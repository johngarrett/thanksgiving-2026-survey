import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SignupForm, Option } from '../shared/types';
import { initialSections } from './seed';

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), title TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, title TEXT NOT NULL, display_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS options (id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE, label TEXT NOT NULL, display_order INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (option_id TEXT PRIMARY KEY REFERENCES options(id) ON DELETE CASCADE, guest_name TEXT NOT NULL, recipe_url TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `);
  db.transaction(() => {
    const columns = db.query('PRAGMA table_info(sections)').all() as { name: string }[];
    if (columns.some(column => column.name === 'customPlaceholder')) return;
    db.exec("ALTER TABLE sections ADD COLUMN customPlaceholder TEXT NOT NULL DEFAULT 'What will u cook?'");
    db.exec("UPDATE sections SET customPlaceholder = 'What will u do?' WHERE id = (SELECT id FROM sections ORDER BY display_order, id LIMIT 1 OFFSET 1)");
  })();
  db.transaction(() => {
    if (db.query('SELECT id FROM settings').get()) return;
    db.query('INSERT INTO settings VALUES (1, ?)').run('Thanksgiving');
    initialSections.forEach((section, i) => {
      const id = crypto.randomUUID();
      db.query('INSERT INTO sections (id, title, display_order, customPlaceholder) VALUES (?, ?, ?, ?)').run(id, section.title, i, i === 1 ? 'What will u do?' : 'What will u cook?');
      section.options.forEach((label, j) => db.query('INSERT INTO options VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), id, label, j));
    });
  })();
  return db;
}

// Keep the existing recipe_url column so saved notes survive the field rename.
export function readForm(db: Database): SignupForm {
  return db.transaction(() => ({
    title: (db.query('SELECT title FROM settings WHERE id = 1').get() as { title: string }).title,
    sections: (db.query('SELECT id, title, customPlaceholder FROM sections ORDER BY display_order, id').all() as { id: string; title: string; customPlaceholder: string }[]).map(section => ({
      ...section,
      options: db.query(`SELECT o.id, o.label, c.guest_name AS claimedBy, c.recipe_url AS notes
        FROM options o LEFT JOIN claims c ON c.option_id = o.id
        WHERE o.section_id = ? ORDER BY o.display_order, o.id`).all(section.id) as Option[],
    })),
  }))();
}
