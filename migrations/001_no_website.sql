-- ---------------------------------------------------------------------------
-- Businesses with no website of their own.
--
-- Often the strongest leads: a boutique with a real Instagram following and
-- nowhere to send people has the largest possible website opportunity. There
-- is no page to fetch, so OSM tags and the social handle are the only
-- evidence, and these columns carry it.
-- ---------------------------------------------------------------------------
ALTER TABLE entities ADD COLUMN phone TEXT;
ALTER TABLE entities ADD COLUMN osm_tags TEXT;       -- JSON
ALTER TABLE entities ADD COLUMN has_website INTEGER; -- 1 | 0 | NULL (unknown)

CREATE INDEX IF NOT EXISTS idx_entities_has_website ON entities(has_website);
