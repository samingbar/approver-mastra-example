-- Run once as the bootstrap administrator, never as loan_app.
-- Local demonstration credentials only; .env.example describes the boundary.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loan_app') THEN
    CREATE ROLE loan_app LOGIN PASSWORD 'loan_demo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS applications (
  id text PRIMARY KEY,
  document_key text NOT NULL,
  document_hash text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('fixture', 'live')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  parent_application_id text REFERENCES applications(id),
  workflow_id text NOT NULL UNIQUE,
  workflow_run_id text,
  policy_version text NOT NULL,
  policy_hash text NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADED',
  stage text NOT NULL DEFAULT 'UPLOAD',
  evidence_revision integer NOT NULL DEFAULT 0 CHECK (evidence_revision >= 0),
  audit_committed boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_cases (
  application_id text PRIMARY KEY REFERENCES applications(id),
  case_revision integer NOT NULL CHECK (case_revision > 0),
  evidence_revision integer NOT NULL CHECK (evidence_revision >= 0),
  policy_version text NOT NULL,
  workflow_id text NOT NULL,
  workflow_run_id text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  overdue boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}',
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id),
  application_revision integer NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  policy_version text NOT NULL,
  policy_hash text NOT NULL,
  evidence_revision integer,
  evidence_hash text,
  workflow_id text NOT NULL,
  workflow_run_id text,
  reason_codes jsonb NOT NULL DEFAULT '[]',
  artifact_refs jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL DEFAULT '{}',
  content_hash text NOT NULL,
  UNIQUE(application_id, sequence)
);

CREATE INDEX IF NOT EXISTS audit_events_application ON audit_events(application_id, sequence);
CREATE INDEX IF NOT EXISTS applications_status ON applications(status, created_at);
CREATE INDEX IF NOT EXISTS review_cases_open ON review_cases(status, opened_at);

-- Session tokens are random opaque credentials. Store only their SHA-256 hashes,
-- so API replicas and API restarts share authenticated reviewer sessions.
CREATE TABLE IF NOT EXISTS reviewer_sessions (
  token_hash text PRIMARY KEY,
  identity jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS reviewer_sessions_expiration ON reviewer_sessions(expires_at);

-- HTTP rejections are observable even when an Update validator records no history.
CREATE TABLE IF NOT EXISTS command_audit (
  application_id text NOT NULL REFERENCES applications(id),
  command_id text NOT NULL,
  reviewer_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  status_code integer NOT NULL,
  request_hash text,
  payload jsonb NOT NULL DEFAULT '{}',
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(application_id, command_id)
);

CREATE OR REPLACE FUNCTION reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
DROP TRIGGER IF EXISTS command_audit_immutable ON command_audit;
CREATE TRIGGER command_audit_immutable BEFORE UPDATE OR DELETE ON command_audit
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM loan_app;
GRANT USAGE ON SCHEMA public TO loan_app;
GRANT SELECT, INSERT, UPDATE ON applications, review_cases TO loan_app;
GRANT SELECT, INSERT ON audit_events, command_audit TO loan_app;
GRANT SELECT, INSERT, DELETE ON reviewer_sessions TO loan_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
