CREATE TABLE matching_associations (
 scope TEXT NOT NULL, source_owner TEXT NOT NULL, source_kind TEXT NOT NULL,
 source_id TEXT NOT NULL, fingerprint TEXT NOT NULL, algorithm INTEGER NOT NULL,
 source TEXT NOT NULL, outcome TEXT NOT NULL, proof TEXT NOT NULL,
 revision INTEGER NOT NULL, coverage TEXT NOT NULL, checked INTEGER NOT NULL,
 expires INTEGER NOT NULL,
 PRIMARY KEY(scope,source_owner,source_kind,source_id),
 FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
CREATE INDEX matching_association_expiry ON matching_associations(scope,expires);
CREATE INDEX matching_compact_names ON matching_rows(scope,kind,replace(title_key,' ',''),removed);
