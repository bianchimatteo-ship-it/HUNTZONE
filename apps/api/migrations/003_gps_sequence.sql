ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS last_gps_sequence bigint NOT NULL DEFAULT 0
  CHECK (last_gps_sequence >= 0);
