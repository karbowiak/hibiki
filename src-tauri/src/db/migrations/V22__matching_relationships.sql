CREATE TABLE matching_relationships (
 scope TEXT NOT NULL,kind TEXT NOT NULL,id INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(scope,kind,id),FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
