-- Explicit playlist/favorites browsing cache. No whole-library crawler or analysis jobs.
CREATE TABLE collection_cache (
 scope TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 active_generation INTEGER, total INTEGER NOT NULL DEFAULT 0, cached_at INTEGER NOT NULL DEFAULT 0,
 dirty INTEGER NOT NULL DEFAULT 0, staged_count INTEGER NOT NULL DEFAULT 0,
 staged_total INTEGER NOT NULL DEFAULT 0, stamp TEXT NOT NULL DEFAULT '', changed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,key)
);
CREATE TABLE collection_cache_items (
 scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(scope,kind,id)
);
CREATE TABLE collection_cache_members (
 scope TEXT NOT NULL, key TEXT NOT NULL, generation INTEGER NOT NULL, position INTEGER NOT NULL,
 kind TEXT NOT NULL, item_id TEXT NOT NULL, occurrence TEXT,
 PRIMARY KEY(scope,key,generation,position)
);
CREATE INDEX collection_cache_item_members ON collection_cache_members(scope,kind,item_id);
