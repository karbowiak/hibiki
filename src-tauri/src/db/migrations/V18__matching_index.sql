-- Compact matching evidence has a separate lifecycle from focused/offline DTOs.
CREATE TABLE matching_scopes (
 scope TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
 epoch INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE matching_tasks (
 scope TEXT NOT NULL, kind TEXT NOT NULL,
 generation TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'scan',
 offset INTEGER NOT NULL DEFAULT 0, total INTEGER,
 digest TEXT NOT NULL DEFAULT '', verify_digest TEXT NOT NULL DEFAULT '',
 prune_cursor INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL,
 completed INTEGER, count INTEGER NOT NULL DEFAULT 0,
 requests INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
 error TEXT, failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,kind), FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
CREATE TABLE matching_rows (
 scope TEXT NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL,
 title TEXT NOT NULL, title_key TEXT NOT NULL, artist_key TEXT NOT NULL,
 artist_id INTEGER, album_id INTEGER, duration INTEGER,
 evidence TEXT NOT NULL, revision TEXT NOT NULL,
 observed INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,kind,id), FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
CREATE INDEX matching_names ON matching_rows(scope,kind,title_key,artist_key,removed);
CREATE INDEX matching_artists ON matching_rows(scope,artist_id,kind,removed,id);
CREATE INDEX matching_albums ON matching_rows(scope,album_id,kind,removed,id);
CREATE TABLE matching_identifiers (
 scope TEXT NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL,
 scheme TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(scope,kind,id,scheme,value),
 FOREIGN KEY(scope,kind,id) REFERENCES matching_rows(scope,kind,id) ON DELETE CASCADE
);
CREATE INDEX matching_external ON matching_identifiers(scope,kind,scheme,value);
CREATE TABLE matching_seen (
 scope TEXT NOT NULL, kind TEXT NOT NULL, generation TEXT NOT NULL,
 id INTEGER NOT NULL, revision TEXT NOT NULL,
 PRIMARY KEY(scope,kind,generation,id),
 FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE matching_fts USING fts5(scope UNINDEXED, kind UNINDEXED, id UNINDEXED, title, artist, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER matching_insert AFTER INSERT ON matching_rows WHEN new.removed=0 BEGIN
 INSERT INTO matching_fts(rowid,scope,kind,id,title,artist) VALUES(new.rowid,new.scope,new.kind,new.id,new.title_key,new.artist_key);
END;
CREATE TRIGGER matching_delete AFTER DELETE ON matching_rows BEGIN
 DELETE FROM matching_fts WHERE rowid=old.rowid;
END;
CREATE TRIGGER matching_update AFTER UPDATE ON matching_rows WHEN old.revision!=new.revision OR old.removed!=new.removed BEGIN
 DELETE FROM matching_fts WHERE rowid=old.rowid;
 INSERT INTO matching_fts(rowid,scope,kind,id,title,artist) SELECT new.rowid,new.scope,new.kind,new.id,new.title_key,new.artist_key WHERE new.removed=0;
END;
CREATE TABLE matching_changes (
 scope TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL,
 PRIMARY KEY(scope,sequence,kind,id), FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
