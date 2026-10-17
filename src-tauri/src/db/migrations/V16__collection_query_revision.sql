-- Readers key their bounded sorted membership cache to a transaction-visible
-- revision. Shared item edits can affect several collections at once.
CREATE TABLE collection_query_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
    identity TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO collection_query_revision(singleton,identity) VALUES(1,hex(randomblob(16)));
CREATE TRIGGER collection_items_inserted AFTER INSERT ON collection_cache_items BEGIN
    UPDATE collection_query_revision SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER collection_items_updated AFTER UPDATE ON collection_cache_items BEGIN
    UPDATE collection_query_revision SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER collection_items_deleted AFTER DELETE ON collection_cache_items BEGIN
    UPDATE collection_query_revision SET revision=revision+1 WHERE singleton=1;
END;
