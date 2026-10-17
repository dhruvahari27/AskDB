-- Read-only role used by the agent. Run by `npm run setup` as the warehouse owner.
-- :ro_password is substituted by the setup script.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'askdb_ro') THEN
    CREATE ROLE askdb_ro LOGIN PASSWORD '__RO_PASSWORD__';
  ELSE
    ALTER ROLE askdb_ro WITH LOGIN PASSWORD '__RO_PASSWORD__';
  END IF;
END
$$;

-- Defence in depth: even if every other check failed, this role cannot write.
ALTER ROLE askdb_ro SET default_transaction_read_only = on;
ALTER ROLE askdb_ro SET statement_timeout = '8s';
ALTER ROLE askdb_ro SET search_path = analytics;
ALTER ROLE askdb_ro SET idle_in_transaction_session_timeout = '10s';

REVOKE ALL ON SCHEMA public FROM askdb_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM askdb_ro;
GRANT USAGE ON SCHEMA analytics TO askdb_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO askdb_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO askdb_ro;
