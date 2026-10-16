-- Run in a transaction with temp.focused_scope(scope) set by the native owner.
-- Only the retired Plex mirror is pruned. App-owned state and audio intentions
-- are never deleted here. Audio bytes live in their independent native caches.
-- Native media keys are the retention identity; avoid correlated scans across
-- every waveform when retiring a large pre-0.6 development mirror.
CREATE INDEX IF NOT EXISTS local_audio_cache_key ON local_audio(scope,cache_key);
CREATE INDEX IF NOT EXISTS audio_download_cache_key ON audio_download_jobs(scope,cache_key);
CREATE TEMP TABLE IF NOT EXISTS focused_keep (
 scope TEXT NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL,
 PRIMARY KEY(scope,kind,id)
);
DELETE FROM focused_keep;
INSERT OR IGNORE INTO focused_keep
 SELECT scope,'track',track_id FROM local_audio WHERE scope IN focused_scope;
INSERT OR IGNORE INTO focused_keep
 SELECT scope,'track',track_id FROM audio_download_jobs WHERE scope IN focused_scope;
INSERT OR IGNORE INTO focused_keep
 SELECT scope,'track',track_id FROM audio_download_members WHERE scope IN focused_scope;
INSERT OR IGNORE INTO focused_keep
 SELECT scope,kind,entity_id FROM audio_download_entities WHERE scope IN focused_scope;
INSERT OR IGNORE INTO focused_keep
 SELECT f.scope,'track',CAST(j.value AS INTEGER)
 FROM favorites_entries f, json_each(f.payload,'$.localTrackIds') j
 WHERE f.scope IN focused_scope AND CAST(j.value AS INTEGER)>0;
-- Related parents are useful offline, but unrelated artists/albums are Plex's job.
INSERT OR IGNORE INTO focused_keep
 SELECT c.scope,'album',c.download_album FROM plex_catalogue c
 JOIN focused_keep k ON k.scope=c.scope AND k.kind=c.kind AND k.id=c.id
 WHERE c.kind='track' AND c.download_album>0;
INSERT OR IGNORE INTO focused_keep
 SELECT c.scope,'artist',coalesce(c.download_artist,c.download_album) FROM plex_catalogue c
 JOIN focused_keep k ON k.scope=c.scope AND k.kind=c.kind AND k.id=c.id
 WHERE c.kind IN ('track','album') AND coalesce(c.download_artist,c.download_album)>0;
DELETE FROM plex_audio_analysis AS a WHERE a.scope IN focused_scope
 AND NOT EXISTS(SELECT 1 FROM local_audio l WHERE l.scope=a.scope AND l.cache_key=a.cache_key)
 AND NOT EXISTS(SELECT 1 FROM audio_download_jobs j WHERE j.scope=a.scope AND j.cache_key=a.cache_key);
DELETE FROM plex_metadata_resources AS r WHERE r.scope IN focused_scope
 AND NOT EXISTS(SELECT 1 FROM focused_keep k WHERE k.scope=r.scope AND k.kind='track' AND k.id=r.item_id);
DELETE FROM plex_catalogue_playlist_members AS m WHERE m.scope IN focused_scope
 AND NOT EXISTS(SELECT 1 FROM audio_download_entities e JOIN plex_catalogue_playlist_versions v
 ON v.scope=e.scope AND v.playlist_id=e.entity_id
 WHERE e.scope=m.scope AND e.kind='playlist' AND e.entity_id=m.playlist_id AND v.generation=m.generation);
DELETE FROM plex_catalogue_playlist_versions AS v WHERE v.scope IN focused_scope
 AND NOT EXISTS(SELECT 1 FROM audio_download_entities e WHERE e.scope=v.scope AND e.kind='playlist' AND e.entity_id=v.playlist_id);
DELETE FROM plex_catalogue AS c WHERE c.scope IN focused_scope
 AND NOT EXISTS(SELECT 1 FROM focused_keep k WHERE k.scope=c.scope AND k.kind=c.kind AND k.id=c.id);
DELETE FROM plex_catalogue_tasks WHERE scope IN focused_scope;
DELETE FROM plex_catalogue_changes WHERE scope IN focused_scope;
DELETE FROM plex_catalogue_incremental WHERE scope IN focused_scope;
DELETE FROM plex_catalogue_media WHERE scope IN focused_scope;
DELETE FROM plex_catalogue_invalidations WHERE scope IN focused_scope;
-- The remaining archive is a focused subset, never a claim of complete coverage.
INSERT INTO plex_catalogue_browse_state(scope,upper_rowid,complete)
 SELECT scope,0,1 FROM focused_scope WHERE true
 ON CONFLICT(scope) DO UPDATE SET complete=1;
DROP TABLE focused_keep;
