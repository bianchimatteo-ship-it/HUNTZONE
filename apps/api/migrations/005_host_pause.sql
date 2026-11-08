ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS paused_from_phase varchar(16),
  ADD COLUMN IF NOT EXISTS host_disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS host_disconnect_player_id uuid REFERENCES players(id);

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS connected_since timestamptz NOT NULL DEFAULT now();

ALTER TABLE matches
  DROP CONSTRAINT IF EXISTS matches_paused_from_phase_check;

ALTER TABLE matches
  ADD CONSTRAINT matches_paused_from_phase_check
  CHECK (paused_from_phase IS NULL OR paused_from_phase IN ('lobby','countdown','active'));
