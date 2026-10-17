/**
 * One command that gets both databases ready:
 *   npm run setup                      create DBs if possible, run migrations, load the warehouse if empty
 *   npm run setup -- --reset-warehouse drop and reload the warehouse (synthetic data, or real Olist CSVs in warehouse/data/)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { getConfig, repoRoot } from '@askdb/shared';
import { loadDatasetFromDirOrSeed, loadDataset } from '../warehouse/load';

const { Client } = pg;
const cfg = getConfig();
const reset = process.argv.includes('--reset-warehouse');

async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
      console.log(`  created database ${dbName}`);
    }
  } catch (e) {
    console.log(`  (could not check/create database ${dbName}: ${(e as Error).message}; assuming it exists)`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function migrateApp(): Promise<void> {
  const client = new Client({ connectionString: cfg.APP_DATABASE_URL });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = resolve(repoRoot, 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(resolve(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  applied migration ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.end();
  }
}

async function setupWarehouse(): Promise<void> {
  const client = new Client({ connectionString: cfg.WAREHOUSE_ADMIN_URL });
  await client.connect();
  try {
    const exists = await client.query("SELECT to_regclass('analytics.orders') AS t");
    let loaded = false;
    if (exists.rows[0].t) {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM analytics.orders');
      loaded = rows[0].n > 0;
    }
    if (loaded && !reset) {
      console.log('  warehouse already loaded (use --reset-warehouse to reload)');
    } else {
      console.log('  creating warehouse schema...');
      await client.query(readFileSync(resolve(repoRoot, 'warehouse/schema.sql'), 'utf8'));
      const { data, source } = loadDatasetFromDirOrSeed(resolve(repoRoot, 'warehouse/data'));
      console.log(`  loading ${source} data...`);
      await client.query('BEGIN');
      try {
        const counts = await loadDataset(client, data);
        await client.query('COMMIT');
        console.log('  loaded:', Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' '));
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      await client.query('ANALYZE');
    }

    const ro = new URL(cfg.WAREHOUSE_READONLY_URL);
    const roPassword = decodeURIComponent(ro.password).replace(/'/g, "''");
    const roName = decodeURIComponent(ro.username);
    if (roName !== 'askdb_ro') console.log(`  note: roles.sql creates the role "askdb_ro"; your WAREHOUSE_READONLY_URL uses "${roName}"`);
    const sql = readFileSync(resolve(repoRoot, 'warehouse/roles.sql'), 'utf8').replaceAll('__RO_PASSWORD__', roPassword);
    await client.query(sql);
    const asOf = await client.query('SELECT max(order_purchase_timestamp)::date::text AS d FROM analytics.orders');
    console.log(`  read-only role ready. Data as-of date (latest order): ${asOf.rows[0].d}`);
  } finally {
    await client.end();
  }
}

console.log('AskDB setup');
console.log('1/3 databases');
await ensureDatabase(cfg.APP_DATABASE_URL);
await ensureDatabase(cfg.WAREHOUSE_ADMIN_URL);
console.log('2/3 app database migrations');
await migrateApp();
console.log('3/3 warehouse');
await setupWarehouse();
console.log('\nDone. Start the app with:  npm run dev');
