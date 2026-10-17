-- Live queue sources retain their captured membership across refreshes and GC.
-- The owning renderer drops abandoned leases during each maintenance pass.
CREATE TABLE collection_cache_pins (
 scope TEXT NOT NULL, pin TEXT NOT NULL, key TEXT NOT NULL, generation INTEGER NOT NULL,
 PRIMARY KEY(scope,pin)
);
CREATE INDEX collection_cache_pinned_generation ON collection_cache_pins(scope,key,generation);
