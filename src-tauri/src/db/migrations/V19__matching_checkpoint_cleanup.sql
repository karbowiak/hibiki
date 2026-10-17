CREATE TABLE matching_retired (
 scope TEXT NOT NULL,kind TEXT NOT NULL,generation TEXT NOT NULL,
 PRIMARY KEY(scope,kind,generation),FOREIGN KEY(scope) REFERENCES matching_scopes(scope) ON DELETE CASCADE
);
