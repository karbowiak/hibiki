CREATE TABLE playback_queue (
    scope TEXT PRIMARY KEY NOT NULL,
    total INTEGER NOT NULL,
    entries TEXT NOT NULL,
    state TEXT NOT NULL
);
