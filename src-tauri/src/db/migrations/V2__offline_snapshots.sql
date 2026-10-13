-- Separate scoped browsing snapshots: legacy Plex IDs have no account identity.
CREATE TABLE offline_snapshots (
    scope TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count > 0),
    cached_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL,
    PRIMARY KEY (scope, cache_key)
);
CREATE INDEX offline_snapshots_lru ON offline_snapshots(accessed_at, scope, cache_key);
