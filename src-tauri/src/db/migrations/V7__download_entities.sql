-- Explicit offline ownership is separate from the automatic playback cache.
CREATE TABLE audio_download_entities (
 scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('track','album','artist','playlist')),
 entity_id INTEGER NOT NULL CHECK(entity_id>0), title TEXT NOT NULL, revision TEXT NOT NULL,
 captured_at INTEGER NOT NULL, entry_count INTEGER NOT NULL,
 PRIMARY KEY(scope,kind,entity_id)
);
CREATE TABLE audio_download_claims (
 scope TEXT NOT NULL, kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
 track_id INTEGER NOT NULL CHECK(track_id>0),
 PRIMARY KEY(scope,kind,entity_id,track_id)
);
CREATE INDEX audio_download_shared ON audio_download_claims(scope,track_id);
CREATE TABLE audio_download_members (
 scope TEXT NOT NULL, kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
 track_id INTEGER NOT NULL CHECK(track_id>0), document TEXT,
 PRIMARY KEY(scope,kind,entity_id,track_id)
);
-- Old intentions have no reliable album/playlist provenance. Keep them as
-- individual intentions rather than deleting files when a new group is removed.
INSERT INTO audio_download_entities(scope,kind,entity_id,title,revision,captured_at,entry_count)
 SELECT scope,'track',track_id,'',lower(hex(randomblob(16))),created_at,1 FROM audio_download_jobs;
INSERT INTO audio_download_claims(scope,kind,entity_id,track_id)
 SELECT scope,'track',track_id,track_id FROM audio_download_jobs;
INSERT INTO audio_download_members(scope,kind,entity_id,track_id)
 SELECT scope,'track',track_id,track_id FROM audio_download_jobs;

ALTER TABLE plex_catalogue ADD COLUMN download_album INTEGER GENERATED ALWAYS AS
 (CAST(coalesce(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.parentRatingKey'),substr(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.parentKey'),19)) AS INTEGER)) VIRTUAL;
CREATE INDEX plex_catalogue_download_album ON plex_catalogue(scope,kind,removed,download_album);

ALTER TABLE plex_catalogue ADD COLUMN download_artist INTEGER GENERATED ALWAYS AS
 (CAST(coalesce(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.grandparentRatingKey'),substr(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.grandparentKey'),19)) AS INTEGER)) VIRTUAL;
CREATE INDEX plex_catalogue_download_artist ON plex_catalogue(scope,kind,removed,download_artist);
