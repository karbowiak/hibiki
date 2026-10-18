-- V26 client-state builds skipped the reserved V24/V25 migrations. Preserve
-- their existing state while installing provider downloads on those databases.
CREATE TABLE IF NOT EXISTS provider_playlist_downloads (
 owner TEXT NOT NULL, id TEXT NOT NULL, entity_id INTEGER NOT NULL,
 metadata TEXT NOT NULL, members TEXT NOT NULL, revision TEXT NOT NULL,
 PRIMARY KEY(owner,id)
);
