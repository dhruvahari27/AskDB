import type { SchemaCatalog, TableInfo } from './catalog';

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'by', 'and', 'or', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'how', 'many', 'much', 'me', 'show', 'give', 'list', 'with', 'per', 'each', 'our', 'we', 'my', 'all', 'from', 'that', 'this', 'last', 'top', 'best']);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, ' ')
    .split(/[\s_]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/**
 * Pick the tables worth putting in the prompt. With a handful of tables everything fits, so everything is sent.
 * With a large schema (hundreds of tables) this scores tables by IDF-weighted word overlap with the question,
 * then pulls in tables directly linked by foreign keys so joins stay possible.
 * (Embedding search can replace `score` without touching the callers.)
 */
export function selectTables(question: string, catalog: SchemaCatalog, maxTables = 10): TableInfo[] {
  if (catalog.tables.length <= maxTables) return catalog.tables;

  const docs = catalog.tables.map((t) => ({
    t,
    words: new Set(tokens([t.name, t.description, ...t.columns.flatMap((c) => [c.name, c.description])].join(' '))),
  }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.words) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  const q = tokens(question);

  const scored = docs
    .map((d) => ({ t: d.t, score: q.reduce((s, w) => s + (d.words.has(w) ? Math.log(1 + n / (df.get(w) ?? 1)) : 0), 0) }))
    .sort((a, b) => b.score - a.score);

  const chosen = new Map<string, TableInfo>();
  const budget = Math.max(3, Math.floor(maxTables / 2));
  for (const s of scored.slice(0, budget)) if (s.score > 0) chosen.set(s.t.name, s.t);
  if (chosen.size === 0) for (const s of scored.slice(0, 3)) chosen.set(s.t.name, s.t);

  const byName = new Map(catalog.tables.map((t) => [t.name, t]));
  for (const t of [...chosen.values()]) {
    for (const c of t.columns) {
      if (c.fk && chosen.size < maxTables) {
        const ref = byName.get(c.fk.table);
        if (ref) chosen.set(ref.name, ref);
      }
    }
    for (const other of catalog.tables) {
      if (chosen.size >= maxTables) break;
      if (other.columns.some((c) => c.fk?.table === t.name)) chosen.set(other.name, other);
    }
  }
  return [...chosen.values()];
}

/** Text form of the schema the LLM reads. PII columns are left out entirely: the model never learns they exist. */
export function renderSchema(tables: TableInfo[]): string {
  return tables
    .map((t) => {
      const head = `TABLE ${t.name}${t.rowEstimate > 0 ? ` (~${t.rowEstimate} rows)` : ''}${t.description ? ` - ${t.description}` : ''}`;
      const cols = t.columns
        .filter((c) => !c.pii)
        .map((c) => {
          const flags = [c.isPk ? 'PK' : '', c.fk ? `FK -> ${c.fk.table}.${c.fk.column}` : ''].filter(Boolean).join(', ');
          return `  ${c.name} ${c.type}${flags ? ` [${flags}]` : ''}${c.description ? ` - ${c.description}` : ''}`;
        })
        .join('\n');
      return `${head}\n${cols}`;
    })
    .join('\n\n');
}
