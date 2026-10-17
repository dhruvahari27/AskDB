-- App database (users, chats, runs, glossary, feedback). LangGraph's checkpoint tables are created separately
-- by PostgresSaver.setup() in the "langgraph" schema.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text,
  role          text NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'New conversation',
  mode       text NOT NULL DEFAULT 'execution' CHECK (mode IN ('baseline', 'classifier', 'execution')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'complete' CHECK (status IN ('running', 'awaiting_clarification', 'complete', 'failed')),
  run_id          uuid,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS query_runs (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
  question        text NOT NULL,
  mode            text NOT NULL,
  status          text NOT NULL DEFAULT 'running',
  sql             text,
  row_count       integer,
  duration_ms     integer,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  llm_calls       integer NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS query_runs_user_day_idx ON query_runs (user_id, created_at);

CREATE TABLE IF NOT EXISTS clarifications (
  id          uuid PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES query_runs (id) ON DELETE CASCADE,
  question    text NOT NULL,
  options     jsonb NOT NULL,
  chosen_id   text,
  free_text   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE TABLE IF NOT EXISTS glossary_terms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term        text NOT NULL,
  definition  text NOT NULL,
  sql_snippet text,
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  source      text NOT NULL DEFAULT 'manual',
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term, definition)
);

CREATE TABLE IF NOT EXISTS feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating        smallint NOT NULL CHECK (rating IN (-1, 1)),
  corrected_sql text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

-- Defaults the system applies instead of asking (approved on day one).
INSERT INTO glossary_terms (term, definition, status, source) VALUES
  ('last month',   'the previous full calendar month before the as-of date (the as-of date is the latest order date in the data)', 'approved', 'default'),
  ('last quarter', 'the previous full calendar quarter before the as-of date', 'approved', 'default'),
  ('last year',    'the previous full calendar year before the as-of date', 'approved', 'default'),
  ('this year',    'the current calendar year from January 1 up to and including the as-of date', 'approved', 'default')
ON CONFLICT DO NOTHING;
