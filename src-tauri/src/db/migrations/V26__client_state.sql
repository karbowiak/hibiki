-- Application state has one durable owner, shared by webviews and workers.
-- Tombstones retain revisions so a delayed writer cannot resurrect
-- a deleted journal or preference.
CREATE TABLE IF NOT EXISTS client_state (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, key)
);
