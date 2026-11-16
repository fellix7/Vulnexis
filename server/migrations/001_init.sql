-- Vulnera accounts: plans, users, sessions, API keys, saved scans, usage counters, AI spend.
-- Plan numbers are placeholders the founder edits as data (UPDATE plans ...); prices stay null until Razorpay.

CREATE TABLE plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  monthly_scans integer NOT NULL CHECK (monthly_scans >= 0),
  daily_scans integer CHECK (daily_scans >= 0),          -- used for the anonymous plan only
  max_concurrent integer NOT NULL CHECK (max_concurrent >= 1),
  max_api_keys integer NOT NULL DEFAULT 0,
  ai_enabled boolean NOT NULL DEFAULT true,
  price_paise integer,                                   -- null until Razorpay checkout is switched on
  active boolean NOT NULL DEFAULT true
);
INSERT INTO plans (id, name, monthly_scans, daily_scans, max_concurrent, max_api_keys, ai_enabled, active) VALUES
  ('anonymous', 'Anonymous', 60, 2, 1, 0, true, true),
  ('free', 'Free', 30, NULL, 2, 3, true, true),
  ('pro', 'Pro', 500, NULL, 4, 10, true, false);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id bigint NOT NULL UNIQUE,
  github_login text NOT NULL,
  name text,
  email text,
  plan_id text NOT NULL DEFAULT 'free' REFERENCES plans(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash bytea PRIMARY KEY,                             -- sha256 of the session id; the id itself is only in the cookie
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  key_id text NOT NULL UNIQUE,                           -- public 16-hex part of the key
  key_hash bytea NOT NULL,                               -- sha256 of the whole key; the key itself is shown once
  last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys(user_id);

CREATE TABLE scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('upload', 'repo')),
  project_name text NOT NULL CHECK (char_length(project_name) <= 200),
  package_count integer NOT NULL,
  finding_count integer NOT NULL,
  fix_now_count integer NOT NULL,
  ai_status text NOT NULL,
  result jsonb NOT NULL,                                 -- ScanResult with code quotes stripped (source code is never stored)
  result_bytes integer NOT NULL CHECK (result_bytes <= 2097152),
  review jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days'
);
CREATE INDEX scans_user_created_idx ON scans(user_id, created_at DESC, id DESC);
CREATE INDEX scans_expires_idx ON scans(expires_at);

CREATE TABLE usage (
  subject text NOT NULL,                                 -- 'user:<uuid>' | 'key:<uuid>' | 'ip:<sha256(ip|day)>'
  period date NOT NULL,                                  -- month start (IST) for users and keys; the day for IPs
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  scans integer NOT NULL DEFAULT 0 CHECK (scans >= 0),
  PRIMARY KEY (subject, period)
);
CREATE INDEX usage_user_idx ON usage(user_id);

CREATE TABLE ai_usage (
  period date PRIMARY KEY,                               -- month start (IST)
  calls integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0
);

-- Supabase exposes tables in `public` through its REST API. Row level security with no policies closes that door;
-- the app connects as the table owner, so it is unaffected.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
