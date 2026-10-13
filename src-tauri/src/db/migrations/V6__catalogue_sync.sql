ALTER TABLE plex_catalogue ADD COLUMN listing TEXT;
ALTER TABLE plex_catalogue ADD COLUMN listing_saved_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plex_catalogue ADD COLUMN seen_generation TEXT;
ALTER TABLE plex_catalogue ADD COLUMN position INTEGER;
ALTER TABLE plex_catalogue ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plex_catalogue ADD COLUMN title TEXT GENERATED ALWAYS AS
 (CASE WHEN listing_saved_at > saved_at THEN json_extract(listing,'$.title') ELSE json_extract(document,'$.title') END) VIRTUAL;
ALTER TABLE plex_catalogue ADD COLUMN artist TEXT GENERATED ALWAYS AS
 (coalesce(CASE WHEN listing_saved_at > saved_at THEN json_extract(json_patch(document,listing),'$.grandparentTitle') ELSE json_extract(document,'$.grandparentTitle') END,CASE WHEN listing_saved_at > saved_at THEN json_extract(json_patch(document,listing),'$.parentTitle') ELSE json_extract(document,'$.parentTitle') END,'')) VIRTUAL;
ALTER TABLE plex_catalogue ADD COLUMN album TEXT GENERATED ALWAYS AS
 (coalesce(CASE WHEN listing_saved_at > saved_at THEN json_extract(json_patch(document,listing),'$.parentTitle') ELSE json_extract(document,'$.parentTitle') END,'')) VIRTUAL;
CREATE INDEX plex_catalogue_browse ON plex_catalogue(scope,kind,removed,title COLLATE NOCASE,id);
CREATE INDEX plex_catalogue_parent ON plex_catalogue(scope,kind,removed,CAST(json_extract(document,'$.parentRatingKey') AS INTEGER));
CREATE INDEX plex_catalogue_detail ON plex_catalogue(scope,kind,removed,id,detail);
CREATE VIRTUAL TABLE plex_catalogue_search USING fts5(scope UNINDEXED,kind UNINDEXED,id UNINDEXED,title,artist,album,
 content='plex_catalogue',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER plex_catalogue_search_insert AFTER INSERT ON plex_catalogue BEGIN
 INSERT INTO plex_catalogue_search(rowid,scope,kind,id,title,artist,album) VALUES(new.rowid,new.scope,new.kind,new.id,new.title,new.artist,new.album);
END;
CREATE TRIGGER plex_catalogue_search_delete AFTER DELETE ON plex_catalogue BEGIN
 INSERT INTO plex_catalogue_search(plex_catalogue_search,rowid,scope,kind,id,title,artist,album) VALUES('delete',old.rowid,old.scope,old.kind,old.id,old.title,old.artist,old.album);
END;
CREATE TRIGGER plex_catalogue_search_update AFTER UPDATE ON plex_catalogue
 WHEN old.title IS NOT new.title OR old.artist IS NOT new.artist OR old.album IS NOT new.album BEGIN
 INSERT INTO plex_catalogue_search(plex_catalogue_search,rowid,scope,kind,id,title,artist,album) VALUES('delete',old.rowid,old.scope,old.kind,old.id,old.title,old.artist,old.album);
 INSERT INTO plex_catalogue_search(rowid,scope,kind,id,title,artist,album) VALUES(new.rowid,new.scope,new.kind,new.id,new.title,new.artist,new.album);
END;
INSERT INTO plex_catalogue_search(plex_catalogue_search) VALUES('rebuild');

CREATE TABLE plex_catalogue_tasks (
 scope TEXT NOT NULL, task TEXT NOT NULL, generation TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','paused','error','complete')),
 cursor INTEGER NOT NULL DEFAULT 0, total INTEGER,
 completed_at INTEGER, error TEXT, updated_at INTEGER NOT NULL,
 PRIMARY KEY(scope,task)
);
-- Staged membership is published only after a complete verified scan. Track
-- IDs deliberately are not unique: repeated playlist occurrences are valid.
CREATE TABLE plex_catalogue_playlist_members (
 scope TEXT NOT NULL, playlist_id INTEGER NOT NULL, generation TEXT NOT NULL,
 position INTEGER NOT NULL, document TEXT NOT NULL,
 occurrence INTEGER GENERATED ALWAYS AS (CAST(json_extract(document,'$.playlistItemID') AS INTEGER)) VIRTUAL,
 PRIMARY KEY(scope,playlist_id,generation,position)
);
CREATE UNIQUE INDEX plex_catalogue_occurrences ON plex_catalogue_playlist_members(scope,playlist_id,generation,occurrence)
 WHERE occurrence IS NOT NULL AND occurrence > 0;
CREATE TABLE plex_catalogue_playlist_versions (
 scope TEXT NOT NULL, playlist_id INTEGER NOT NULL, generation TEXT NOT NULL,
 total INTEGER NOT NULL, saved_at INTEGER NOT NULL,
 PRIMARY KEY(scope,playlist_id)
);
CREATE TABLE plex_catalogue_media (
 scope TEXT NOT NULL, track_id INTEGER NOT NULL, cache_key TEXT NOT NULL,
 stream_id INTEGER NOT NULL, version TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','saved','unavailable')),
 attempted_at INTEGER,
 PRIMARY KEY(scope,track_id,cache_key,stream_id,version)
);
CREATE TABLE plex_catalogue_invalidations(scope TEXT NOT NULL,method TEXT NOT NULL,invalidated_at INTEGER NOT NULL,PRIMARY KEY(scope,method));

CREATE INDEX plex_catalogue_pending_analysis ON plex_catalogue_media(scope,active,status,track_id,attempted_at);
CREATE INDEX local_audio_album ON local_audio(scope,json_extract(metadata,'$.albumId'));
CREATE INDEX local_audio_artist ON local_audio(scope,json_extract(metadata,'$.artistId'));
CREATE INDEX plex_catalogue_playlist_track ON plex_catalogue_playlist_members(scope,playlist_id,generation,CAST(json_extract(document,'$.ratingKey') AS INTEGER));
