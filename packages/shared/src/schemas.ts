import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Agent modes                                                         */
/* ------------------------------------------------------------------ */

/**
 * baseline  = never asks, answers with a single best guess
 * classifier = an LLM decides whether the question is ambiguous, and asks if it thinks so
 * execution = drafts several readings, runs them, asks only if their results differ
 */
export const AgentModeSchema = z.enum(['baseline', 'classifier', 'execution']);
export type AgentMode = z.infer<typeof AgentModeSchema>;

/* ------------------------------------------------------------------ */
/* What the LLM must return (validated before anything runs)           */
/* ------------------------------------------------------------------ */

export const ReadingSchema = z.object({
  meaning: z.string().min(1).max(400),
  sql: z.string().min(1).max(6000),
  assumptions: z.array(z.string().max(300)).max(4).optional(),
});

export const DraftResponseSchema = z.object({
  ambiguous_term: z.string().max(120).nullable().optional(),
  readings: z.array(ReadingSchema).min(1).max(4),
});
export type DraftResponse = z.infer<typeof DraftResponseSchema>;

export const ClassifyResponseSchema = z.object({
  ambiguous: z.boolean(),
  ambiguous_term: z.string().max(120).nullable().optional(),
  question: z.string().max(400).nullable().optional(),
  options: z.array(z.object({ meaning: z.string().min(1).max(300) })).max(4).optional(),
});
export type ClassifyResponse = z.infer<typeof ClassifyResponseSchema>;

/* ------------------------------------------------------------------ */
/* Query results                                                       */
/* ------------------------------------------------------------------ */

export const ColumnTypeSchema = z.enum(['number', 'date', 'text', 'boolean']);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

export interface ColumnMeta {
  name: string;
  type: ColumnType;
}

export type Cell = string | number | boolean | null;

export interface TabularResult {
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
}

export interface ChartSpec {
  type: 'bar' | 'line' | 'stat' | 'none';
  /** column index used for the x axis (bar/line) */
  x?: number;
  /** column indexes plotted as series */
  y?: number[];
}

export interface Preview {
  columns: ColumnMeta[];
  rows: Cell[][];
  rowCount: number;
}

/* ------------------------------------------------------------------ */
/* Candidates and clarification                                        */
/* ------------------------------------------------------------------ */

export type CandidateStatus = 'pending' | 'ok' | 'rejected' | 'error';

export interface Candidate {
  id: string;
  meaning: string;
  sql: string;
  assumptions: string[];
  status: CandidateStatus;
  error?: string;
  rowCount?: number;
}

export interface ClarificationOption {
  id: string;
  meaning: string;
  sql?: string;
  preview?: Preview;
}

export interface Clarification {
  id: string;
  question: string;
  term?: string | null;
  options: ClarificationOption[];
  allowFreeText: boolean;
}

export interface AnswerPayload {
  sql: string;
  meaning: string;
  assumptions: string[];
  result: TabularResult;
  chart: ChartSpec;
  explanation: string;
  /** how the answer was reached, shown in the UI */
  path: 'single-reading' | 'readings-agree' | 'user-clarified' | 'user-free-text';
  /** readings that were considered but returned the same rows (shown as chips) */
  consideredReadings: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
}

/* ------------------------------------------------------------------ */
/* Streaming events (server -> browser over SSE)                        */
/* ------------------------------------------------------------------ */

export type RunStatus = 'running' | 'awaiting_clarification' | 'complete' | 'failed';

export type RunEvent =
  | { type: 'step'; node: string; label: string; status: 'start' | 'end'; ms?: number; detail?: string }
  | { type: 'candidates'; candidates: Candidate[] }
  | { type: 'assumption'; text: string }
  | { type: 'clarification_needed'; clarification: Clarification }
  | { type: 'result'; result: AnswerPayload }
  | { type: 'error'; message: string }
  | { type: 'done'; status: RunStatus; usage?: Usage; durationMs?: number };

/* ------------------------------------------------------------------ */
/* API request bodies (shared between server and browser)               */
/* ------------------------------------------------------------------ */

export const RegisterBody = z.object({
  email: z.email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(100).optional(),
});

export const LoginBody = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});

export const CreateConversationBody = z.object({
  title: z.string().min(1).max(200).optional(),
  mode: AgentModeSchema.optional(),
});

export const AskBody = z.object({
  question: z.string().trim().min(3).max(1000),
  mode: AgentModeSchema.optional(),
});

export const ClarifyBody = z
  .object({
    optionId: z.string().min(1).max(100).optional(),
    freeText: z.string().trim().min(2).max(500).optional(),
  })
  .refine((v) => Boolean(v.optionId) !== Boolean(v.freeText), {
    message: 'Provide exactly one of optionId or freeText',
  });

export const FeedbackBody = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  correctedSql: z.string().trim().min(5).max(6000).optional(),
  note: z.string().trim().max(500).optional(),
});

export const GlossaryCreateBody = z.object({
  term: z.string().trim().min(2).max(120),
  definition: z.string().trim().min(3).max(500),
  sqlSnippet: z.string().trim().max(1000).optional(),
});

export const GlossaryPatchBody = z.object({
  status: z.enum(['proposed', 'approved', 'rejected']).optional(),
  definition: z.string().trim().min(3).max(500).optional(),
  term: z.string().trim().min(2).max(120).optional(),
});
