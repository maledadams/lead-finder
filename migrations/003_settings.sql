-- ---------------------------------------------------------------------------
-- app_settings — small operational state that has to survive deploys.
--
-- Holds the Zoho OAuth refresh token and the resolved account id. A refresh
-- token is a credential, so this is the one table whose contents matter:
-- it is stored in D1 (encrypted at rest, reachable only by this Worker) rather
-- than in the repository, and it can be revoked at any time from Zoho's
-- console without touching this code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- Sending is recorded per message so a bug cannot quietly send twice.
ALTER TABLE outreach ADD COLUMN sent_via TEXT;
ALTER TABLE outreach ADD COLUMN send_error TEXT;
