CREATE TABLE IF NOT EXISTS favorites_profiles (
    scope TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL CHECK(json_valid(metadata))
);
CREATE TABLE IF NOT EXISTS favorites_entries (
    scope TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    PRIMARY KEY(scope,id)
);
