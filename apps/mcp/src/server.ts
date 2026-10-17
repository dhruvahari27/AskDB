import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentRunner, CatalogProvider } from '@askdb/agent';
import type { Cell, Clarification, TabularResult } from '@askdb/shared';

const MAX_ROWS_IN_REPLY = 50;

function table(result: TabularResult) {
  const rows = result.rows.slice(0, MAX_ROWS_IN_REPLY);
  return {
    columns: result.columns.map((c) => c.name),
    rows,
    totalRows: result.rowCount,
    shownRows: rows.length,
    truncated: result.truncated || result.rowCount > rows.length,
  };
}

function preview(o: Clarification['options'][number]) {
  if (!o.preview) return undefined;
  return { columns: o.preview.columns.map((c) => c.name), rows: o.preview.rows.slice(0, 3) as Cell[][], totalRows: o.preview.rowCount };
}

const text = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError });

/**
 * AskDB as an MCP server. The point of exposing it this way: the CALLING agent decides what to do when the data
 * layer says "this question is ambiguous". It gets the options with real result previews and can answer for the
 * user (if the conversation settles it) or ask the user, instead of the tool silently guessing.
 */
export function createAskDbServer(deps: { runner: AgentRunner; catalog: CatalogProvider }): McpServer {
  const server = new McpServer({ name: 'askdb', version: '1.0.0' });

  const asAnswer = (runId: string, outcome: Awaited<ReturnType<AgentRunner['start']>>) => {
    if (outcome.status === 'complete') {
      const a = outcome.answer;
      return text({
        status: 'answered',
        meaning: a.meaning,
        sql: a.sql,
        assumptions: a.assumptions,
        howDecided: a.path,
        otherReadingsWithSameRows: a.consideredReadings,
        result: table(a.result),
        explanation: a.explanation,
      });
    }
    if (outcome.status === 'awaiting_clarification') {
      const c = outcome.clarification;
      return text({
        status: 'needs_clarification',
        runId,
        question: c.question,
        options: c.options.map((o) => ({ optionId: o.id, meaning: o.meaning, preview: preview(o) })),
        howToContinue: 'Call answer_clarification with this runId and either an optionId, or freeText if no option fits. Ask the user if you cannot tell which meaning they intend.',
      });
    }
    return text({ status: 'failed', error: outcome.error }, true);
  };

  server.registerTool(
    'describe_schema',
    {
      title: 'Describe the database',
      description: 'Lists the tables and columns AskDB can query (personal-data columns are hidden), plus the date the data runs through.',
      inputSchema: {},
    },
    async () => {
      const c = await deps.catalog();
      return text({
        dataThrough: c.asOf,
        tables: c.tables.map((t) => ({
          name: t.name,
          description: t.description,
          columns: t.columns.filter((col) => !col.pii).map((col) => ({ name: col.name, type: col.type, description: col.description })),
        })),
      });
    },
  );

  server.registerTool(
    'ask_database',
    {
      title: 'Ask a question about the data',
      description:
        'Answer a natural-language question with a read-only SQL query. If the question can mean different things that give DIFFERENT results, ' +
        'this returns status "needs_clarification" with the options and a preview of each; continue with answer_clarification. If all readings agree, it just answers.',
      inputSchema: { question: z.string().min(3).max(1000).describe('The question, in plain language') },
    },
    async ({ question }) => {
      const runId = randomUUID();
      const outcome = await deps.runner.start({ runId, question, mode: 'execution' });
      return asAnswer(runId, outcome);
    },
  );

  server.registerTool(
    'answer_clarification',
    {
      title: 'Answer a clarifying question',
      description: 'Resume a question that returned status "needs_clarification". Provide exactly one of optionId or freeText.',
      inputSchema: {
        runId: z.string().uuid(),
        optionId: z.string().min(1).max(100).optional(),
        freeText: z.string().min(2).max(500).optional().describe('Use only when no option matches what the user means'),
      },
    },
    async ({ runId, optionId, freeText }) => {
      if (Boolean(optionId) === Boolean(freeText)) return text({ status: 'failed', error: 'Provide exactly one of optionId or freeText.' }, true);
      const pending = await deps.runner.pendingClarification(runId).catch(() => null);
      if (!pending) return text({ status: 'failed', error: 'That runId is not waiting for an answer (unknown, finished, or the server restarted).' }, true);
      if (optionId && !pending.options.some((o) => o.id === optionId)) return text({ status: 'failed', error: 'optionId is not one of the offered options.' }, true);
      const outcome = await deps.runner.resume(runId, { optionId, freeText });
      return asAnswer(runId, outcome);
    },
  );

  return server;
}
