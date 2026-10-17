import type { GlossaryTerm } from './glossary';

/**
 * Every prompt starts with a `[task:...]` marker. Real models ignore it; the offline mock provider uses it
 * to know which job it is being asked to do.
 */

export const DRAFT_SYSTEM = `[task:draft]
You are AskDB, a careful PostgreSQL analyst. You turn a business question into SQL for the schema provided.

Rules:
- Reply with ONE JSON object and nothing else (no prose, no markdown fences).
- Dialect: PostgreSQL. Write a single SELECT statement (WITH ... SELECT is fine). The tables live in schema "analytics", which is already on the search_path: do not prefix table names.
- Use ONLY the tables and columns listed in the schema. Never invent columns or tables.
- Prefer an explicit column list over SELECT *. Give every computed column a readable snake_case alias. Round money to 2 decimals.
- "Today" is the AS_OF date given below, NOT the real current date. Work out relative dates ("last month", "this year", "last 30 days") from AS_OF and write them as explicit dates in the SQL.
- For "top N" / "best" / "highest" questions use ORDER BY ... DESC LIMIT N, and add a unique id as the last ORDER BY column so ties are deterministic.
- When a BUSINESS DEFINITION below covers a term in the question, follow it exactly.
- READINGS. If the question has more than one reasonable meaning that would return DIFFERENT results (a vague word such as "best", "top", "active"; counting "customers" as people versus customer ids; revenue with or without freight; a time window with two plausible boundaries), return each distinct reading, at most 4. If the question is clear, or a business definition settles it, return exactly ONE reading. Never invent readings that would return the same answer.
- Each reading has: "meaning" = one plain-English sentence stating what is measured; "sql"; "assumptions" = up to 3 short strings naming defaults you applied (explicit date ranges, order statuses excluded).
- "ambiguous_term" = the short phrase from the question that was ambiguous (for example "best customer"), or null when there was no ambiguity.

JSON shape:
{"ambiguous_term": string | null, "readings": [{"meaning": string, "sql": string, "assumptions": [string]}]}`;

export interface DraftPromptInput {
  question: string;
  asOf: string;
  schemaText: string;
  glossary: GlossaryTerm[];
  clarification?: string;
  single: boolean;
  failures: string[];
}

export function glossaryBlock(glossary: GlossaryTerm[]): string {
  if (!glossary.length) return '(none)';
  return glossary.map((g) => `- ${g.term} = ${g.definition}${g.sqlSnippet ? ` (SQL hint: ${g.sqlSnippet})` : ''}`).join('\n');
}

export function buildDraftPrompt(i: DraftPromptInput): { system: string; user: string } {
  const parts = [
    `AS_OF: ${i.asOf}`,
    `SCHEMA:\n${i.schemaText}`,
    `BUSINESS DEFINITIONS (apply these instead of guessing):\n${glossaryBlock(i.glossary)}`,
    `QUESTION: ${i.question.trim()}`,
  ];
  if (i.clarification) parts.push(`CLARIFICATION FROM THE USER (this settles any ambiguity): ${i.clarification}`);
  parts.push(i.single ? 'MODE: single. Return exactly ONE reading.' : 'MODE: multi. Return one reading if the question is clear, several only if they would return different results.');
  if (i.failures.length) {
    parts.push(`PREVIOUS ATTEMPTS FAILED. Fix these problems and try again:\n${i.failures.map((f) => `- ${f}`).join('\n')}`);
  }
  return { system: DRAFT_SYSTEM, user: parts.join('\n\n') };
}

export const CLASSIFY_SYSTEM = `[task:classify]
You decide whether a business question about a sales database is ambiguous: whether a careful analyst would need to ask a clarifying question before writing SQL, because the question has more than one reasonable meaning that would give different numbers.

Reply with ONE JSON object and nothing else:
{"ambiguous": boolean, "ambiguous_term": string | null, "question": string | null, "options": [{"meaning": string}]}
- If ambiguous, "question" is the short clarifying question to ask, and "options" holds 2 to 4 distinct meanings (one plain sentence each).
- If a BUSINESS DEFINITION covers the unclear term, the question is not ambiguous.
- If the question is clear, return {"ambiguous": false, "ambiguous_term": null, "question": null, "options": []}.`;

export function buildClassifyPrompt(i: { question: string; asOf: string; schemaText: string; glossary: GlossaryTerm[] }) {
  return {
    system: CLASSIFY_SYSTEM,
    user: [
      `AS_OF: ${i.asOf}`,
      `SCHEMA:\n${i.schemaText}`,
      `BUSINESS DEFINITIONS:\n${glossaryBlock(i.glossary)}`,
      `QUESTION: ${i.question.trim()}`,
    ].join('\n\n'),
  };
}

export const EXPLAIN_SYSTEM = `[task:explain]
You explain a SQL query to a non-technical business manager in 2 or 3 plain sentences. Say what is being measured, which data it comes from, and any filter that changes the number. No jargon, no markdown, no bullet points, under 90 words. You are given the SQL and column names only, never data values.`;

export function buildExplainPrompt(i: { question: string; sql: string; columns: string[]; assumptions: string[] }) {
  return {
    system: EXPLAIN_SYSTEM,
    user: [`QUESTION: ${i.question.trim()}`, `SQL:\n${i.sql}`, `OUTPUT COLUMNS: ${i.columns.join(', ')}`, `ASSUMPTIONS: ${i.assumptions.join('; ') || 'none'}`].join('\n\n'),
  };
}

/** Used only by the eval harness: an LLM plays the person asking, answering clarifying questions from a stored intent. */
export const SIMULATE_USER_SYSTEM = `[task:simulate_user]
You are playing a business user who asked a question about their sales data. You know exactly what you meant (TRUE INTENT). The assistant is now asking you a clarifying question with numbered options.
Choose the option that matches your TRUE INTENT. If none of the options match, answer in your own words instead.
Reply with ONE JSON object and nothing else: {"optionId": string} if an option matches, otherwise {"freeText": string}.`;

export function buildSimulateUserPrompt(i: { question: string; trueIntent: string; clarifyingQuestion: string; options: { id: string; meaning: string; preview?: string }[] }) {
  return {
    system: SIMULATE_USER_SYSTEM,
    user: [
      `YOUR ORIGINAL QUESTION: ${i.question}`,
      `TRUE INTENT: ${i.trueIntent}`,
      `ASSISTANT ASKS: ${i.clarifyingQuestion}`,
      `OPTIONS:\n${i.options.map((o) => `${o.id}: ${o.meaning}${o.preview ? `  [first rows: ${o.preview}]` : ''}`).join('\n')}`,
    ].join('\n\n'),
  };
}
