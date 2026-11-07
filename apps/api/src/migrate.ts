import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const migration = await readFile(fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url)), 'utf8');
  await pool.query(migration);
  process.stdout.write('HUNTZONE schema 001 applied.\n');
} finally {
  await pool.end();
}
