ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
