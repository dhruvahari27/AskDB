# AskDB

> **Ask your database questions in plain English. Get answers instantly. No SQL knowledge needed.**

AskDB is a full-stack AI application that converts natural language questions into SQL, executes them safely, and — unlike every other text-to-SQL tool — **only asks for clarification when the answer would actually be different** depending on what you meant.

---

## The Problem AskDB Solves

When a business user asks *"Who is our best customer?"*, this question is ambiguous:

- Best by **total revenue**?
- Best by **number of orders**?

Most text-to-SQL tools either **guess silently** (wrong answer, no warning) or **ask about everything** (annoying, even for obvious questions). AskDB does neither.

**AskDB's approach:** Write SQL for every possible meaning → run them all → compare results. If the results are identical, just show the answer. If they differ, show the user both options **with real data previews** and let them pick. The choice is saved so the same question is never asked again.

---

## Demo

```
You:    Who is our best customer?

AskDB:  "best customer" can mean different things here. Which did you mean?

        Option A — By total revenue spent        Option B — By number of orders placed
        ┌─────────────────────┬──────────┐       ┌─────────────────────┬────────┐
        │ customer_unique_id  │ revenue  │       │ customer_unique_id  │ orders │
        ├─────────────────────┼──────────┤       ├─────────────────────┼────────┤
        │ abc123...           │ R$4,820  │       │ xyz789...           │   7    │
        └─────────────────────┴──────────┘       └─────────────────────┴────────┘

You:    Option A

AskDB:  Showing top customer by revenue — abc123 with R$4,820 total spend.
        [Definition saved. Next time "best customer" = by revenue, no question needed.]
```

---

## Quick Start — Zero Setup, No API Key Needed

> Requires **Node.js 20.11+**

```bash
# 1. Clone and install
git clone https://github.com/dhruvahari27/AskDB.git
cd AskDB
npm install

# 2. Copy environment file
cp .env.example .env          # Mac/Linux
Copy-Item .env.example .env   # Windows PowerShell

# 3. Start the database (keep this terminal open)
npm run db:embedded

# 4. In a new terminal — create tables and load sample data
npm run setup

# 5. In another new terminal — start the app
npm run dev
```

Open **http://localhost:4710** → create an account → try **"Who is our best customer?"**

The default `LLM_PROVIDER=mock` runs fully offline with deterministic demo answers — no API key needed to explore the app.

---

## Enable a Real LLM (Free Tier)

Edit `.env` and set one of these:

```env
# Option 1: Groq (Llama 3.3 — fast, free tier)
LLM_PROVIDER=groq
GROQ_API_KEY=your_key_here     # https://console.groq.com

# Option 2: Google Gemini (free tier)
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_key_here   # https://aistudio.google.com
```

---

## Run with Docker (One Command)

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

Open **http://localhost:4711**

---

## How It Works — The 6-Step Agent

Every question you ask goes through a LangGraph agent with 6 steps, visible in real-time in the UI:

```
┌─────────────────────────────────────────────────────────────────┐
│                        LangGraph Agent                          │
│                                                                 │
│  1. loadContext  →  Read schema + glossary definitions          │
│         ↓                                                       │
│  2. draft        →  Write up to 4 SQL versions (one per meaning)│
│         ↓                                                       │
│  3. execute      →  Run all versions (read-only, guarded)       │
│         ↓                                                       │
│  4. compare      →  Are the result sets identical?             │
│         ↓                                                       │
│  ┌──── same ────────────────────┐                              │
│  │                              │ different                    │
│  ↓                              ↓                              │
│  5a. respond     →  Show answer │  5b. ask  →  Show options    │
│                                 │              + data previews  │
│                                 ↓                              │
│                          6. respond  →  Show chosen answer     │
│                                        Save definition         │
└─────────────────────────────────────────────────────────────────┘
```

**Clarification state is checkpointed in PostgreSQL.** If the server restarts while waiting for your answer, the conversation resumes exactly where it left off.

---

## Features

### Ask Page
- Plain-English question interface with conversation history
- **Live step trace** — watch each agent step execute in real-time over SSE
- Results displayed as **Table / Chart / SQL / Plain-English explanation**
- Assumption chips showing what the AI assumed
- Thumbs up / down feedback with SQL correction form
- 3 modes: **Execution** (smart), **Classifier** (LLM-judges ambiguity), **Baseline** (never asks)

### Dashboard
- Total questions, clarification rate, average latency
- Daily token budget usage (protects free API keys)
- 7-day activity chart — answered directly vs. needed clarification
- Recent questions list
- Getting started checklist

### Glossary (Admin)
- Review, approve, reject, or edit definitions learned from user choices
- Approved definitions silently influence all future answers
- Proposed definitions visible to all; approval restricted to admin

### Schema Browser
- All database tables, columns, types, row estimates
- PII-restricted columns clearly marked

### Evaluation Harness
- 36 benchmark questions (16 clear, 20 ambiguous)
- Compare all 3 modes: execution accuracy, over-asking rate, ambiguity recall, latency
- Simulated user answers clarifying questions using the stored true intent
- Results appear on the Evaluation page in the UI

### MCP Server
- Expose AskDB as tools for any MCP client (Claude Desktop, etc.)
- `describe_schema`, `ask_database`, `answer_clarification`

---

## Tech Stack

### Frontend
| Technology | Role |
|---|---|
| React 19 | UI framework |
| TypeScript | Type safety across all packages |
| Vite 8 | Build tool and dev server |
| React Router v7 | Client-side routing |
| Recharts | Data visualization / charts |
| Custom CSS | Light/dark theme, responsive layout |

### Backend
| Technology | Role |
|---|---|
| Node.js 20+ | Runtime |
| Express 5 | REST API + SSE streaming |
| JWT + bcrypt | Authentication and password hashing |
| Zod | Input validation and schema definitions |
| Pino | Structured logging |
| Helmet + rate-limiter | Security headers and abuse prevention |

### AI / Agent
| Technology | Role |
|---|---|
| LangGraph | Stateful multi-step agent graph |
| LangChain Core | LLM abstraction layer |
| Groq (Llama 3.3) | Primary LLM provider (free tier) |
| Google Gemini | Alternative LLM provider (free tier) |
| Prompt engineering | Structured prompts for draft / classify / explain |

### Database
| Technology | Role |
|---|---|
| PostgreSQL | App DB + LangGraph checkpoint store |
| pg (node-postgres) | Node.js database driver |
| Read-only DB role | Safety layer — AI can never write data |
| SQL migrations | Versioned schema management |

### DevOps
| Technology | Role |
|---|---|
| Docker + Compose | Containerized production deployment |
| npm workspaces | Monorepo — 3 apps + 4 packages |
| Vitest | Unit and integration tests |
| Playwright | End-to-end browser tests (23 checks) |
| embedded-postgres | Zero-install local database for development |

---

## SQL Safety — 4 Independent Layers

The AI writes SQL. This is the attack surface. AskDB defends it at every level:

```
Layer 1 — Parse Tree Guard (packages/sql-guard)
  Uses PostgreSQL's own parser (libpg-query), not regex.
  Rejects: non-SELECT statements, writes inside CTEs, SELECT INTO,
  FOR UPDATE, unknown tables, 30+ dangerous functions (pg_sleep,
  dblink, set_config...), PII columns, SELECT * on PII tables.
  → 83 attack/allow test cases

Layer 2 — Read-Only Database Role (askdb_ro)
  SELECT permission only. default_transaction_read_only = on.
  Even if Layer 1 fails, the DB user cannot write anything.

Layer 3 — Transaction Wrapping
  BEGIN READ ONLY. Always ROLLBACK, never COMMIT.
  5s statement timeout. EXPLAIN cost ceiling. Row limit 500.

Layer 4 — AI Never Sees PII
  Personal data columns removed from schema prompt.
  AI cannot reference what it cannot see.
```

---

## Project Structure

```
AskDB/
├── apps/
│   ├── api/          Express 5 REST API + SSE + JWT auth
│   ├── web/          React 19 + Vite frontend (7 pages)
│   └── mcp/          MCP stdio server for AI clients
├── packages/
│   ├── agent/        LangGraph agent — the 6-step graph
│   ├── sql-guard/    Parse-tree SQL safety checker
│   ├── evals/        Benchmark harness — 36 questions, 3 modes
│   └── shared/       Zod schemas + result normalisation
├── warehouse/        Sample e-commerce schema + seed data
├── migrations/       PostgreSQL schema migrations
├── scripts/          DB setup and embedded Postgres launcher
├── e2e/              Playwright end-to-end tests
├── docker-compose.yml
├── Dockerfile
└── .env.example      All config documented
```

---

## All Commands

| Command | What it does |
|---|---|
| `npm run db:embedded` | Start local PostgreSQL on port 5433 |
| `npm run setup` | Create tables, roles, load sample data |
| `npm run dev` | API on :4711 + web on :4710 (watch mode) |
| `npm test` | All unit + integration tests |
| `npm run typecheck` | TypeScript check across all packages |
| `npm run e2e` | Playwright browser tests (23 checks) |
| `npm run evals` | Run evaluation harness (needs real LLM) |
| `npm run lint:data` | Validate all 36 benchmark questions |
| `npm run build` | Build production frontend |
| `npm start` | Serve API + built UI on :4711 |
| `npm run mcp` | Start MCP stdio server |

---

## Environment Variables

See `.env.example` — every variable is documented. Key ones:

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` / `groq` / `gemini` |
| `GROQ_API_KEY` | — | Groq API key |
| `GEMINI_API_KEY` | — | Gemini API key |
| `JWT_SECRET` | change-me | Must be changed in production |
| `DAILY_TOKEN_BUDGET` | `200000` | Per-user token limit (0 = unlimited) |
| `ASK_RATE_LIMIT_PER_MIN` | `20` | Requests per minute per user |
| `PORT` | `4711` | API server port |
| `WEB_PORT` | `4710` | Dev web server port |

---

## Sample Questions to Try

| Type | Question |
|---|---|
| Clear | `How many customers do we have?` |
| Clear | `What is the order status breakdown?` |
| Clear | `How many delivered orders arrived late?` |
| Ambiguous | `Who is our best customer?` |
| Ambiguous | `Show the top 5 sellers` |
| Uses glossary | `What was the revenue last month?` |

---

## Known Limitations

- Sample data is generated (not real Olist data) — numbers are illustrative
- Table selection is lexical, not embedding-based — works for 8 tables, won't scale to hundreds
- Single-node only — in-flight SSE streams are lost on restart (completed state is recovered from Postgres)
- No password reset or email verification
- Schema docs written for the sample warehouse — pointing at a different DB requires rewriting `warehouse/schema_docs.yaml`

---

## License

MIT — free to use, modify, and deploy.

---

<div align="center">
Built with React · Node.js · PostgreSQL · LangGraph · TypeScript
</div>
