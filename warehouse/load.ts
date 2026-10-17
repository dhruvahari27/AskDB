import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client } from 'pg';
import { parse } from 'csv-parse/sync';
import { LOAD_ORDER, TABLE_COLUMNS, generateDataset, type Dataset, type Row } from './seed';

const CHUNK = 800;

export async function bulkInsert(client: Client, table: string, columns: string[], rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const values = chunk
      .map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`)
      .join(',');
    await client.query(`INSERT INTO analytics.${table} (${columns.join(',')}) VALUES ${values}`, params);
  }
}

export async function loadDataset(client: Client, data: Dataset): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of LOAD_ORDER) {
    await bulkInsert(client, table, TABLE_COLUMNS[table], data[table]);
    counts[table] = data[table].length;
  }
  return counts;
}

/** Kaggle file name -> [table, column renames]. The Kaggle files misspell "length" as "lenght". */
const CSV_FILES: Record<keyof Dataset, { file: string; rename?: Record<string, string> }> = {
  customers: { file: 'olist_customers_dataset.csv' },
  sellers: { file: 'olist_sellers_dataset.csv' },
  product_category_name_translation: { file: 'product_category_name_translation.csv' },
  products: {
    file: 'olist_products_dataset.csv',
    rename: { product_name_lenght: 'product_name_length', product_description_lenght: 'product_description_length' },
  },
  orders: { file: 'olist_orders_dataset.csv' },
  order_items: { file: 'olist_order_items_dataset.csv' },
  order_payments: { file: 'olist_order_payments_dataset.csv' },
  order_reviews: { file: 'olist_order_reviews_dataset.csv' },
};

export function csvDirHasOlist(dir: string): boolean {
  return Object.values(CSV_FILES).every((f) => existsSync(resolve(dir, f.file)));
}

/** Read the real Olist CSVs into the same in-memory shape the synthetic generator produces. */
export function readOlistCsvs(dir: string): Dataset {
  const data = {} as Dataset;
  for (const table of LOAD_ORDER) {
    const { file, rename = {} } = CSV_FILES[table];
    const records = parse(readFileSync(resolve(dir, file)), { columns: (h: string[]) => h.map((c) => rename[c] ?? c), skip_empty_lines: true, bom: true }) as Record<string, string>[];
    const cols = TABLE_COLUMNS[table];
    data[table] = records.map((r) => cols.map((c) => (r[c] === undefined || r[c] === '' ? null : r[c]!)));
  }
  // The real files contain a few duplicate review ids / orphan rows; keep only what the foreign keys allow.
  const orderIds = new Set(data.orders.map((r) => r[0]));
  data.order_reviews = data.order_reviews.filter((r) => orderIds.has(r[1]));
  const productIds = new Set(data.products.map((r) => r[0]));
  const sellerIds = new Set(data.sellers.map((r) => r[0]));
  data.order_items = data.order_items.filter((r) => productIds.has(r[2]) && sellerIds.has(r[3]));
  // Category names missing from the translation file would break the foreign key.
  const cats = new Set(data.product_category_name_translation.map((r) => r[0]));
  data.products = data.products.map((r) => (r[1] && !cats.has(r[1]) ? [r[0]!, null, ...r.slice(2)] : r));
  return data;
}

export function loadDatasetFromDirOrSeed(dir: string): { data: Dataset; source: 'olist-csv' | 'synthetic' } {
  if (csvDirHasOlist(dir)) return { data: readOlistCsvs(dir), source: 'olist-csv' };
  return { data: generateDataset(), source: 'synthetic' };
}
