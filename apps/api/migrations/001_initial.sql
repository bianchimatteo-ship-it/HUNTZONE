CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name varchar(32) NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guest_sessions (
  token_hash bytea PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS guest_sessions_expiry_idx ON guest_sessions (expires_at);

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code varchar(8) NOT NULL UNIQUE,
  host_player_id uuid NOT NULL REFERENCES players(id),
  mode_id varchar(64) NOT NULL,
  config jsonb NOT NULL,
  area_center geography(Point, 4326),
  phase varchar(16) NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby','countdown','active','paused','completed','cancelled')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS participants (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id),
  ready boolean NOT NULL DEFAULT false,
  connected boolean NOT NULL DEFAULT true,
  role_id varchar(64),
  team_id varchar(64),
  virtual_status varchar(24) NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  event_type varchar(80) NOT NULL,
  event_version smallint NOT NULL DEFAULT 1,
  actor_player_id uuid REFERENCES players(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, revision)
);

CREATE TABLE IF NOT EXISTS processed_commands (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  actor_player_id uuid NOT NULL REFERENCES players(id),
  command_id varchar(80) NOT NULL,
  committed_revision bigint NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, actor_player_id, command_id)
);

CREATE TABLE IF NOT EXISTS match_checkpoints (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  engine_version varchar(32) NOT NULL,
  virtual_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, revision)
);

CREATE TABLE IF NOT EXISTS consents (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id),
  purpose varchar(32) NOT NULL,
  policy_version varchar(32) NOT NULL,
  granted_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  PRIMARY KEY (match_id, player_id, purpose)
);

-- Precise player GPS is intentionally absent from durable schema. Keep observations only in
-- bounded, expiring process memory owned by the active match actor; never add them to logs/events.
