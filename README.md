# AskDB

Ask a database questions in plain English. AskDB writes SQL, and it **asks you back only when the answer would actually change**.

Most text-to-SQL demos either guess silently or ask "did you mean…?" about everything. AskDB does neither:

1. The model drafts up to four readings of your question ("best customer" → by revenue? by order count?).
2. Every reading is parsed, guarded, and **executed read-only**.
3. The result sets are compared. If they are the same rows, you just get the answer. If they differ, you see each option **with a preview of its actual rows** and pick one.
4. Your pick is saved as a *proposed* glossary definition. After an admin approves it, nobody is asked that again.

The claim "asking back this way beats guessing and beats an LLM deciding when to ask" is testable, so the repo ships an evaluation harness that runs the same questions in three modes (baseline, LLM-classifier, execution-based).

## Quick start (no Docker, no API key)

Requires Node 20.11 or newer.

```bash
npm install
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
npm run db:embedded             # terminal 1: starts a local PostgreSQL on port 5433, leave it running
npm run setup                   # terminal 2: creates tables, read-only role, sample warehouse
npm run dev                     # API on :4711, web app on http://localhost:4710 (change PORT / WEB_PORT in .env if these are taken)
```

Open http://localhost:4710, create an account (the first account becomes the admin), and try **"Who is our best customer?"**.

With `LLM_PROVIDER=mock` (the default) a deterministic offline model answers a handful of sample questions, so everything is clickable with zero setup. **It is a demo stand-in, not a language model.** For free-form questions set a real provider in `.env`:

```
LLM_PROVIDER=groq        # or gemini
GROQ_API_KEY=...         # https://console.groq.com   (free tier)
GEMINI_API_KEY=...       # https://aistudio.google.com (free tier)
```

Model names change over time; if a provider returns "model not found", update `GROQ_MODEL` / `GEMINI_MODEL` in `.env`.

Production-style run (one process serves API and built UI): `npm run build && npm start`, then open http://localhost:4711. Set a real `JWT_SECRET` first; in production mode the server refuses to start with the development secret.

Docker: `JWT_SECRET=$(openssl rand -hex 32) docker compose up --build`.

## What is in the box

| Area | What it does |
| --- | --- |
| **Overview** | Questions asked, how often it asked back, latency, daily token budget, 7-day chart, recent questions |
| **Ask** | Conversations, three modes, live trace of every step over SSE (reconnects and resumes), result as table / chart / SQL / explanation, assumption chips, thumbs up/down with a "correct SQL" form |
| **Glossary** | Approve / reject / edit learned definitions (admin). Only approved terms ever influence answers |
| **Schema** | Tables, keys, row estimates, and which columns are hidden as personal data |
| **Evaluation** | Per-mode metrics and per-question failures from saved eval runs |
| **Help & first steps** | Welcome tour on first sign-in (replay from the `?` button), a "Getting started" checklist that ticks off from real activity, an in-context "Why am I being asked this?" explainer, and a Help page with tips and FAQ |
| **MCP server** | `npm run mcp`: AskDB as tools for any MCP client (see below) |

## How the pieces fit

```
apps/web      React 19 + Vite UI (own CSS, light/dark)
apps/api      Express 5 REST + SSE, JWT cookie auth, rate limit, daily token budget
apps/mcp      MCP stdio server (describe_schema, ask_database, answer_clarification)
packages/agent       LangGraph.js graph: loadContext → classify? → draft → execute → compare → ask (interrupt) → respond
packages/sql-guard   Parses SQL with PostgreSQL's own parser and walks the tree; executes read-only
packages/evals       Dataset, simulated user, execution-accuracy scorer, CLI
packages/shared      Zod schemas, config, result-normalisation rules shared by app and scorer
warehouse     Olist-shaped sample data (generated, deterministic) or your own Kaggle CSVs
```

**Clarification is a graph interrupt.** When readings disagree the graph calls `interrupt()`; the state is checkpointed in Postgres (`langgraph` schema), so a paused question survives a server restart. This is covered by a test that boots a second server instance and finishes the question.

**What "same result" means** (`packages/shared/src/normalize.ts`, used by both the product and the scorer): row order and column order are ignored, numbers compare at 2 decimals, dates compare as strings.

**Relative dates use the data's as-of date**, not today's date. The sample data ends on 2018-08-29, so "last month" means July 2018. The as-of date is shown on the Overview page.

### SQL safety, in layers

The model never gets a write path. Each layer assumes the one above it failed:

1. **Parse tree guard**: exactly one statement, a `SELECT`; no write statements even inside CTEs; no `SELECT … INTO`, no `FOR UPDATE`; table and schema allowlist; function deny-list (`pg_*`, `dblink`, `lo_*`, `set_config`, …); size-sensitive functions (`repeat`, `generate_series`, …) rejected for huge arguments; personal-data columns, `SELECT *` over tables that contain them, and whole-row references rejected. 83 attack/allow cases in `packages/sql-guard/test`.
2. **Database role** `askdb_ro`: `SELECT` only, `default_transaction_read_only`, fixed `search_path`.
3. **`BEGIN READ ONLY` + always `ROLLBACK`**, `statement_timeout`, `EXPLAIN` cost ceiling, result wrapped in `LIMIT n+1`.
4. **The model sees no personal data**: PII columns are omitted from the schema prompt, and the explanation prompt receives column names only, never row values.

## Evaluation

```bash
npm run lint:data                                   # every gold query parses, passes the guard, runs, returns rows
npm run evals -- --modes baseline,classifier,execution
npm run evals -- --split test --defaults            # held-out split, with the default approved glossary terms
```

- Metrics: execution accuracy (overall, on ambiguous, on clear), **over-asking rate** (asked on a clear question), **ambiguity recall**, average turns, p50/p95 latency, tokens per question.
- A simulated user (an LLM given the case's true intent) answers clarifying questions, so asking can actually help or hurt the score.
- The default glossary is empty so "last month" counts as ambiguous; pass `--defaults` to start from the app's defaults.
- Results are saved to `packages/evals/results/*.json` and appear on the Evaluation page.
- **The CLI refuses to run with the mock model** (its scores would mean nothing). `--smoke` runs the harness with the mock and saves nothing.
- LLM replies are cached on disk (`.cache/llm`) so reruns are cheap and reproducible.

**Be honest about the dataset.** It ships with 36 questions (16 clear, 20 ambiguous across metric / time / entity / aggregation / scope / join-path), not hundreds. That is enough to see differences between modes but not enough to publish a leaderboard. Two things would make it credible: grow it to 100+, and have someone else write the `test` split without looking at your prompts. Expect variance from the model and from the simulated user; report how many runs you averaged.

## Use it from an MCP client

`npm run mcp` starts a stdio MCP server exposing:

- `describe_schema`: tables and columns (personal data hidden) and the as-of date
- `ask_database`: answers, or returns `needs_clarification` with options **and row previews**
- `answer_clarification`: continue with `optionId` or `freeText`

The point is that the *calling agent* decides what to do with an ambiguity (resolve it from conversation context or ask the human) instead of the tool guessing. Example Claude Desktop entry:

```json
{ "mcpServers": { "askdb": { "command": "npx", "args": ["tsx", "apps/mcp/src/index.ts"], "cwd": "/absolute/path/to/askdb" } } }
```

Paused questions in the MCP server live in memory for the life of the process.

## Configuration

See `.env.example`; every variable is documented there. Notable ones: `DAILY_TOKEN_BUDGET` (per user, protects your free API key), `ASK_RATE_LIMIT_PER_MIN`, `STATEMENT_TIMEOUT_MS`, `MAX_RESULT_ROWS`, `MAX_PLAN_COST`, optional `REDIS_URL` for the LLM response cache.

To use the real Olist data, put the Kaggle CSVs in `warehouse/data/` and run `npm run setup -- --reset-warehouse`.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | API (watch) + web dev server |
| `npm test` | all tests (database-backed tests skip themselves if Postgres is not running) |
| `npm run typecheck` | server, packages and web |
| `npm run e2e` | browser end-to-end suite (23 checks: tour, ask, clarify, feedback, glossary, schema, help, permissions, phone layout). Needs the app running with the mock model and `npx playwright install chromium` once |
| `npm run evals` / `lint:data` | evaluation harness / dataset check |
| `npm run build` / `start` | build the UI / run API + UI on :4711 |

## Known limits

- The schema docs (`warehouse/schema_docs.yaml`) and the glossary defaults are written for the Olist-shaped sample warehouse. Pointing AskDB at a different database means rewriting those descriptions and the PII list; it is not plug-and-play.
- Table selection for the prompt is lexical (no embeddings). It is fine for 8 tables and will not scale to hundreds without retrieval.
- The sample data is generated, so absolute numbers are not real-world numbers.
- Single-node: run state for the live stream is held in memory (it rebuilds the final state from Postgres after a restart, but an in-flight run is lost).
- Accounts are email + password with a JWT cookie. There is no password reset or email verification.
