-- ---------------------------------------------------------------------------
-- The medium-business profile searches the whole country too.
--
-- It shipped with 40 cities chosen to share none with the creative profile, on
-- the reasoning that overlapping geography wastes a sweep: the first profile to
-- find a business owns it, so the other one crawls and discards.
--
-- That reasoning was thinner than it looked. The two profiles look for different
-- OpenStreetMap tags — a dental clinic is never a pottery studio — so they were
-- never really competing for the same businesses, only for the same map squares.
-- Coverage is worth more than the handful of duplicate queries it costs.
--
-- NULL rather than a copy of the list: unset means "fall back to the built-in
-- national list", so this profile picks up new cities as they are added instead
-- of freezing today's snapshot into a row.
--
-- Safe to re-run.
--   pnpm exec wrangler d1 execute lead-finder --remote --file=./migrations/010_medium_goes_national.sql
-- ---------------------------------------------------------------------------

UPDATE profiles SET metros = NULL, updated_at = '2026-09-08T00:00:00Z'
WHERE id = 'p-medium';
