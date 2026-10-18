-- Playlist occurrence manifests point at the same shared audio jobs/files.
CREATE TABLE provider_playlist_downloads (
 owner TEXT NOT NULL, id TEXT NOT NULL, entity_id INTEGER NOT NULL,
 metadata TEXT NOT NULL, members TEXT NOT NULL, revision TEXT NOT NULL,
 PRIMARY KEY(owner,id)
);
