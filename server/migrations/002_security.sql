-- Security hardening (audit follow-up).

-- Anonymous visitors do not get the AI code check: it is the one part of a scan that costs money per call.
UPDATE plans SET ai_enabled = false WHERE id = 'anonymous';

-- schema_migrations was created without row level security; every table in public must have it.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- Supabase's REST roles must hold no privileges on our tables. (Plain Postgres has no such roles: nothing to do.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
  END IF;
END
$$;
