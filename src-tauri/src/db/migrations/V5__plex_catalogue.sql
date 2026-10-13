-- Complete Plex documents are kept privately, separately from renderer DTOs.
-- Account/server/library scopes never adopt the old ratingKey-only tables.
CREATE TABLE plex_catalogue (
    scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('artist','album','track','playlist')),
    id INTEGER NOT NULL CHECK(id > 0),
    document TEXT NOT NULL,
    detail INTEGER NOT NULL DEFAULT 0,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY(scope, kind, id)
);
CREATE TABLE plex_audio_analysis (
    scope TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    stream_id INTEGER NOT NULL CHECK(stream_id > 0),
    version TEXT NOT NULL,
    document TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY(scope, cache_key, stream_id, version)
);
-- Preserve complete algorithm responses (including distances and future fields)
-- when requested. A sonic-analysis flag is not a downloadable feature vector.
CREATE TABLE plex_metadata_resources (
    scope TEXT NOT NULL,
    item_id INTEGER NOT NULL CHECK(item_id > 0),
    resource TEXT NOT NULL,
    document TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY(scope, item_id, resource)
);
