-- Audio identity is native, credential-free, and scoped to account/server/library.
-- The legacy globally keyed Plex tables are deliberately not adopted.
CREATE TABLE local_audio (
    scope TEXT NOT NULL,
    track_id INTEGER NOT NULL CHECK(track_id > 0),
    cache_key TEXT NOT NULL,
    extension TEXT NOT NULL,
    metadata TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY(scope, track_id, cache_key)
);
CREATE INDEX local_audio_recent ON local_audio(scope, saved_at DESC);
CREATE TABLE audio_download_jobs (
    scope TEXT NOT NULL,
    track_id INTEGER NOT NULL CHECK(track_id > 0),
    revision TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','downloading','paused','downloaded','error')),
    cache_key TEXT,
    received INTEGER NOT NULL DEFAULT 0,
    total INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope, track_id)
);
CREATE INDEX audio_download_queue ON audio_download_jobs(scope, status, created_at);
