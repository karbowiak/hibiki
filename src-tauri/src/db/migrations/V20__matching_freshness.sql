CREATE TABLE matching_hints (
 scope TEXT NOT NULL,kind TEXT NOT NULL,id INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,queued_at INTEGER NOT NULL,
 attempted_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,kind,id),FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
CREATE INDEX matching_hint_work ON matching_hints(scope,attempted_at,queued_at);
CREATE TABLE matching_health (
 scope TEXT PRIMARY KEY,wanted INTEGER NOT NULL DEFAULT 0,checked INTEGER NOT NULL DEFAULT 0,
 last_check INTEGER NOT NULL DEFAULT 0,section_stamp TEXT,
 force_census INTEGER NOT NULL DEFAULT 0,
 capabilities TEXT,capabilities_checked INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,
 FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
CREATE TABLE matching_refresh (
 scope TEXT NOT NULL,kind TEXT NOT NULL,
 watermark INTEGER,census_generation TEXT,census_time INTEGER,
 last_checked INTEGER NOT NULL DEFAULT 0,
 delta_generation TEXT,delta_lower INTEGER,delta_upper INTEGER,
 delta_offset INTEGER NOT NULL DEFAULT 0,delta_total INTEGER,
 retry_at INTEGER NOT NULL DEFAULT 0,error TEXT,
 PRIMARY KEY(scope,kind),FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
