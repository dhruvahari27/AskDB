<div align="center">

# ⚡ AskDB

### *Ask your database in plain English. Get answers instantly. No SQL knowledge needed.*

**AskDB only asks for clarification when different interpretations would actually change the answer.**

---

[![Live Demo](https://img.shields.io/badge/🌐_Live_Demo-askdb--i5sc.onrender.com-00C7B7?style=for-the-badge&logo=render&logoColor=white)](https://askdb-i5sc.onrender.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-20.11+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![LangGraph](https://img.shields.io/badge/AI_Agent-LangGraph-FF6F00?style=for-the-badge)](https://langchain-ai.github.io/langgraph/)
[![Tests](https://img.shields.io/badge/Tests-130%20Passed-2ea44f?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)

<br/>

### 🚀 **[Try the Live Demo: https://askdb-i5sc.onrender.com](https://askdb-i5sc.onrender.com)**

<br/>

[🌐 Live Demo](https://askdb-i5sc.onrender.com) • [Quick Start](#-quick-start) • [How It Works](#-how-it-works--differential-execution) • [SQL Safety](#-sql-safety--4-independent-layers) • [Deployment](#-deployment-guide) • [Architecture](#-architecture--monorepo-structure)

</div>

---

## 💡 The Problem AskDB Solves

When a business user asks:
> *"Who is our best customer?"*

This question is inherently ambiguous:
* Best by **total revenue spent**?
* Best by **number of orders placed**?
* Best by **recent activity**?

Most text-to-SQL tools either:
1. **Guess Silently:** Pick an arbitrary SQL query without warning the user. If they guessed wrong, leadership makes critical business decisions based on faulty numbers.
2. **Over-Clarify Constantly:** Bombard the user with dialog boxes on every word, even when all interpretations yield the exact same result.

### 🌟 The AskDB Innovation: Differential Execution

```text
Write SQL for every plausible meaning ➔ Execute all candidates in parallel ➔ Compare live data results
```

* **If the results are identical:** AskDB shows the answer immediately without bothering you.
* **If the results differ:** AskDB pauses and shows both options **with real data previews** so you can pick.
* **Self-Learning Glossary:** Your choice is saved to the Business Glossary so the same question is never asked again.

---

## 🎬 Demo

```text
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

## 🚀 Quick Start

> **Prerequisites:** Node.js **20.11+**

```bash
# 1. Clone the repository
git clone https://github.com/dhruvahari27/AskDB.git
cd AskDB

# 2. Install dependencies (auto-links monorepo packages)
npm install

# 3. Create your environment configuration
cp .env.example .env          # macOS / Linux
Copy-Item .env.example .env   # Windows PowerShell

# 4. Start the embedded PostgreSQL database (Terminal 1)
npm run db:embedded

# 5. In a new terminal — seed tables and warehouse data
npm run setup

# 6. In another new terminal — start the development server
npm run dev
```

Open **[http://localhost:4710](http://localhost:4710)** in your browser, sign up with any test account, and ask your first question!

> **Zero Setup / Offline Demo:** The default `LLM_PROVIDER=mock` runs fully offline with deterministic demo answers — no API keys required to explore the entire UI.

---

## 🧠 Enable a Real LLM (Free Tier)

Edit your `.env` file to enable live reasoning:

```env
# Option 1: Groq (Ultra-fast inference, free tier)
LLM_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key_here     # https://console.groq.com
GROQ_MODEL=openai/gpt-oss-120b

# Option 2: Google Gemini (Free tier)
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key_here    # https://aistudio.google.com
GEMINI_MODEL=gemini-3.8-flash
```

---

## 🔄 How It Works — Differential Execution

Every query follows an execution graph orchestrated with **LangGraph**:

```mermaid
flowchart TD
    UserQuery(["User Question: 'Who is our best customer?'"]) --> LoadContext["1. loadContext<br/>Fetch Schema, PII policies & Approved Glossary Definitions"]
    LoadContext --> Draft["2. draft<br/>Generate up to 4 distinct SQL readings via LLM"]
    Draft --> Guard["3. sql-guard<br/>Validate AST parse-tree, enforce read-only & block mutations"]
    Guard --> Execute["4. execute<br/>Run all candidates concurrently in read-only transaction"]
    Execute --> Compare{"5. compare<br/>Are result sets identical?"}
    
    Compare -- Identical Results --> DirectAnswer["6a. Direct Answer<br/>Render table, chart & explanation"]
    Compare -- Divergent Results --> Pause["6b. Clarification Prompt<br/>Interrupt graph with live data previews"]
    
    Pause --> UserChoice["User picks preferred reading"]
    UserChoice --> ResumeGraph["Resume graph execution"]
    ResumeGraph --> SaveGlossary["Save definition into Business Glossary"]
    SaveGlossary --> DirectAnswer
```

> **Durable Checkpointing:** Clarification state is checkpointed directly in PostgreSQL. If the server restarts while waiting for your response, the conversation resumes seamlessly from the exact same point.

---

## 🛡️ SQL Safety — 4 Independent Layers

Because AI generates dynamic SQL, AskDB implements defense-in-depth:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: PostgreSQL AST Parse-Tree Guard (packages/sql-guard)          │
│ • Uses libpg-query (Postgres C parser in WASM), never brittle regex.    │
│ • Rejects: non-SELECT, writes in CTEs, SELECT INTO, FOR UPDATE,        │
│   unknown tables, PII columns, and 30+ forbidden functions.            │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Dedicated Read-Only DB Role (askdb_ro)                       │
│ • Database user only has SELECT privileges.                            │
│ • default_transaction_read_only = ON enforced at session level.       │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Transaction Isolation & Resource Ceilings                    │
│ • Every query wrapped in BEGIN READ ONLY ... ROLLBACK.                 │
│ • 5-second statement timeout, EXPLAIN plan cost ceiling, 500-row cap.  │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 4: PII Redaction at the Schema Boundary                          │
│ • Personal identifiable columns are stripped before prompting the LLM. │
│ • AI cannot leak or reference what it is never shown.                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🌐 Deployment Guide

> **Live Production Deployment:** 👉 **[https://askdb-i5sc.onrender.com](https://askdb-i5sc.onrender.com)**  
> Hosted on Render with managed PostgreSQL, automated schema migrations, and Groq reasoning.

### Option 1: Docker Compose (Recommended)

Run the full stack (Web UI + API Server + PostgreSQL Warehouse + Cache) with one command:

```bash
# 1. Set a random 32+ character JWT secret
export JWT_SECRET=$(openssl rand -hex 32)

# 2. Build and launch all containers
docker compose up --build -d
```

Access the app at **[http://localhost:4711](http://localhost:4711)**.

### Option 2: Cloud Deployment (Railway / Render / Fly.io / VPS)

1. **Deploy PostgreSQL**: Provision a managed PostgreSQL instance (e.g. Supabase, Neon, AWS RDS, or Railway Postgres).
2. **Set Environment Variables**:
   ```env
   NODE_ENV=production
   PORT=4711
   APP_DATABASE_URL=postgres://user:password@host:5432/askdb_app
   WAREHOUSE_ADMIN_URL=postgres://user:password@host:5432/askdb_warehouse
   WAREHOUSE_READONLY_URL=postgres://ro_user:password@host:5432/askdb_warehouse
   JWT_SECRET=your-secure-random-32-byte-hex-string
   LLM_PROVIDER=groq
   GROQ_API_KEY=gsk_...
   GROQ_MODEL=openai/gpt-oss-120b
   ```
3. **Run Container**: Deploy the root `Dockerfile`. On container startup, it automatically executes database migrations, provisions read-only roles, and starts the unified production server.

---

## 📊 Evaluation & Benchmarks

AskDB includes an automated benchmarking suite across 36 realistic e-commerce scenarios:

| Mode | Accuracy | Over-Ask Rate | Ambiguity Recall | Avg Latency | Tokens / Query |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Baseline** (Never asks) | 100% | 0% | — | 1.0s | ~1,820 |
| **Classifier** (LLM judges intent) | 100% | 50% | 100% | 0.8s | ~3,466 |
| **Execution** (*AskDB Differential*) | **100%** | **0%** | **100%** | **0.9s** | **~1,898** |

Run the evaluation suite yourself anytime:
```bash
npm run evals
```

---

## 🏗️ Architecture & Monorepo Structure

```text
AskDB/
├── apps/
│   ├── api/          # Express 5 REST API + SSE streaming + JWT auth
│   ├── web/          # React 19 + Vite frontend (Tailwind, Recharts)
│   └── mcp/          # Model Context Protocol stdio server for AI clients
├── packages/
│   ├── agent/        # LangGraph state machine & LLM orchestration
│   ├── sql-guard/    # AST parse-tree SQL security & policy validator
│   ├── evals/        # Benchmarking framework & 36 gold test cases
│   └── shared/       # Zod schemas, normalization & shared utilities
├── warehouse/        # Olist Brazilian E-commerce schema & dataset
├── migrations/       # Versioned PostgreSQL migrations
├── scripts/          # Embedded DB runner, workspace linkers & setup
├── docker-compose.yml
└── Dockerfile
```

---

## ⌨️ CLI Reference

| Command | Description |
| :--- | :--- |
| `npm run db:embedded` | Starts zero-install local PostgreSQL on port 5434 |
| `npm run setup` | Runs migrations, configures roles, and loads warehouse data |
| `npm run dev` | Launches both API (:4711) and Web UI (:4710) concurrently |
| `npm test` | Runs the full Vitest suite (130 unit & integration tests) |
| `npm run typecheck` | Typechecks all packages and web app with TypeScript |
| `npm run evals` | Runs the agent evaluation harness |
| `npm run lint:data` | Validates benchmark questions against gold SQL |
| `npm run build` | Compiles production assets for web frontend |
| `npm run mcp` | Starts the Model Context Protocol stdio server |

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for details.

<div align="center">
<sub>Crafted with React 19 · Node.js · PostgreSQL 17 · LangGraph · TypeScript</sub>
</div>
