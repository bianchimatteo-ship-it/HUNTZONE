import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';
import { pool } from './db.js';

export async function applyMigrations(database: pg.Pool) {
  const folder = process.env.HUNTZONE_MIGRATIONS_DIR ?? 'apps/api/migrations';
  const directory = resolve(process.cwd(), folder);
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
  await database.query(`CREATE TABLE IF NOT EXISTS huntzone_schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of names) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const applied = await client.query('SELECT 1 FROM huntzone_schema_migrations WHERE name=$1', [name]);
      if (applied.rowCount) { await client.query('COMMIT'); continue; }
      await client.query(await readFile(resolve(directory, name), 'utf8'));
      await client.query('INSERT INTO huntzone_schema_migrations(name) VALUES($1)', [name]);
      await client.query('COMMIT');
      process.stdout.write(`HUNTZONE migration ${name} applied.\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!pool) throw new Error('DATABASE_URL is required.');
  try { await applyMigrations(pool); }
  finally { await pool.end(); }
}
