import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, sqlClient } from '../core/db';

// Resolved from the working directory (apps/api) so it also works from the bundled dist/.
const folder = path.resolve(process.env.MIGRATIONS_DIR ?? 'drizzle');

export async function runMigrations() {
  await migrate(db, { migrationsFolder: folder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runMigrations();
  console.log('Migrations applied');
  await sqlClient.end();
}
