-- supabase/migrations/[timestamp]_fix_spots_remaining_default.sql
ALTER TABLE study_sessions
  ALTER COLUMN spots_remaining SET DEFAULT 0;

-- Also tighten the check: remaining can never exceed total
ALTER TABLE study_sessions
  DROP CONSTRAINT IF EXISTS study_sessions_spots_remaining_check,
  ADD CONSTRAINT study_sessions_spots_remaining_check
    CHECK (spots_remaining >= 0 AND spots_remaining <= spots_total);