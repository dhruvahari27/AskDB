import type pg from 'pg';

export type GlossaryStatus = 'proposed' | 'approved' | 'rejected';

export interface GlossaryTerm {
  id: string;
  term: string;
  definition: string;
  sqlSnippet?: string | null;
  status: GlossaryStatus;
  source: string;
}

export interface GlossaryProposal {
  term: string;
  definition: string;
  sqlSnippet?: string;
  source: string;
  createdBy?: string | null;
}

export interface GlossaryStore {
  /** Approved terms that appear in the question. Only approved terms ever influence an answer. */
  approvedMatching(question: string): Promise<GlossaryTerm[]>;
  propose(p: GlossaryProposal): Promise<void>;
}

export function termMatches(question: string, term: string): boolean {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
  const t = ` ${term.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  return q.includes(t);
}

export class MemoryGlossary implements GlossaryStore {
  terms: GlossaryTerm[];
  private n = 0;
  constructor(seed: Omit<GlossaryTerm, 'id'>[] = []) {
    this.terms = seed.map((t) => ({ ...t, id: `mem-${++this.n}` }));
  }
  async approvedMatching(question: string) {
    return this.terms.filter((t) => t.status === 'approved' && termMatches(question, t.term));
  }
  async propose(p: GlossaryProposal) {
    if (this.terms.some((t) => t.term === p.term && t.definition === p.definition)) return;
    this.terms.push({ id: `mem-${++this.n}`, term: p.term, definition: p.definition, sqlSnippet: p.sqlSnippet ?? null, status: 'proposed', source: p.source });
  }
}

export class PgGlossary implements GlossaryStore {
  constructor(private pool: pg.Pool) {}

  async approvedMatching(question: string): Promise<GlossaryTerm[]> {
    const { rows } = await this.pool.query(
      `SELECT id, term, definition, sql_snippet AS "sqlSnippet", status, source FROM glossary_terms WHERE status = 'approved'`,
    );
    return (rows as GlossaryTerm[]).filter((t) => termMatches(question, t.term));
  }

  async propose(p: GlossaryProposal): Promise<void> {
    await this.pool.query(
      `INSERT INTO glossary_terms (term, definition, sql_snippet, status, source, created_by)
       VALUES ($1, $2, $3, 'proposed', $4, $5)
       ON CONFLICT (term, definition) DO NOTHING`,
      [p.term.toLowerCase(), p.definition, p.sqlSnippet ?? null, p.source, p.createdBy ?? null],
    );
  }
}
