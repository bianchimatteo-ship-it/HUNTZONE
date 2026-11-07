ALTER TABLE matches ADD COLUMN IF NOT EXISTS countdown_ends_at timestamptz;
UPDATE matches
   SET config = config || '{"captureMethod":"radius"}'::jsonb
 WHERE NOT (config ? 'captureMethod');

CREATE INDEX IF NOT EXISTS matches_countdown_idx
  ON matches (countdown_ends_at)
  WHERE phase = 'countdown';
