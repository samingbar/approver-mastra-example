import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Explicit admin-only schema bootstrap. Runtime workers never call this. */
export async function bootstrapDatabase(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  try {
    const schema = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
    await pool.query(schema);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) throw new Error('DATABASE_ADMIN_URL is required for admin-only database bootstrap');
  await bootstrapDatabase(connectionString);
}
