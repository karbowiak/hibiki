-- A finite ID census survives concurrent Plex imports and app restarts.
ALTER TABLE plex_catalogue_tasks ADD COLUMN scan_mode TEXT NOT NULL DEFAULT 'offset';
ALTER TABLE plex_catalogue_tasks ADD COLUMN key_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plex_catalogue_tasks ADD COLUMN upper_id INTEGER;
ALTER TABLE plex_catalogue_tasks ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plex_catalogue_tasks ADD COLUMN lower_time INTEGER;
ALTER TABLE plex_catalogue_tasks ADD COLUMN upper_time INTEGER;
ALTER TABLE plex_catalogue ADD COLUMN listing_revision TEXT;
ALTER TABLE plex_catalogue ADD COLUMN detail_revision TEXT;
ALTER TABLE plex_catalogue ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plex_catalogue ADD COLUMN verify_missing INTEGER NOT NULL DEFAULT 0;
CREATE INDEX plex_catalogue_verify_missing ON plex_catalogue(scope,verify_missing,kind,id);
-- Lazy digest initialization avoids parsing hundreds of thousands of documents
-- during migration. Existing detail rows compare against their original listing.
CREATE TABLE plex_catalogue_changes (
 scope TEXT NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, hint_state INTEGER NOT NULL DEFAULT 0,
 priority INTEGER NOT NULL DEFAULT 1,
 queued_at INTEGER NOT NULL, attempted_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,kind,id)
);
CREATE INDEX plex_catalogue_changes_ready ON plex_catalogue_changes(scope,priority,attempted_at,queued_at);
CREATE INDEX plex_catalogue_changed_details ON plex_catalogue(scope,kind,removed,detail_revision,listing_revision,id);
CREATE TABLE plex_catalogue_incremental (
 scope TEXT PRIMARY KEY, watermark INTEGER, catchup_requested INTEGER NOT NULL DEFAULT 0,
 request_version INTEGER NOT NULL DEFAULT 0, catchup_started INTEGER NOT NULL DEFAULT 0,
 catchup_target INTEGER, catchup_lower INTEGER, catchup_version INTEGER, catchup_force INTEGER NOT NULL DEFAULT 0, catchup_full INTEGER NOT NULL DEFAULT 0, changes_revision INTEGER NOT NULL DEFAULT 0,
 phase TEXT NOT NULL DEFAULT 'idle'
);
