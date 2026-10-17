// Starts a local PostgreSQL server with no Docker and no installer, using the `embedded-postgres` package.
// Works on Windows, macOS and Linux. Data lives in ./.pgdata and survives restarts.
//
//   npm run db:embedded      (leave this terminal open; Ctrl+C stops the database)
//
// Then in another terminal: npm run setup
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PG_PORT || 5433);
// PG_DATA_DIR lets you keep the data elsewhere (needed when running as root inside a container).
const databaseDir = process.env.PG_DATA_DIR ? resolve(process.env.PG_DATA_DIR) : resolve(root, '.pgdata');

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'askdb',
  password: 'askdb',
  port,
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error('[postgres]', String(e).trim()),
});

if (!existsSync(resolve(databaseDir, 'PG_VERSION'))) {
  console.log('First run: creating database cluster in', databaseDir);
  await pg.initialise();
}
await pg.start();

for (const name of ['askdb_app', 'askdb_warehouse']) {
  try {
    await pg.createDatabase(name);
    console.log('created database', name);
  } catch (e) {
    if (!/already exists/i.test(String(e))) throw e;
  }
}

console.log(`\nPostgreSQL is running on localhost:${port}  (user askdb / password askdb)`);
console.log('Next: open a second terminal and run  npm run setup\n');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping PostgreSQL...');
  try { await pg.stop(); } catch (e) { console.error(e); }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
