CREATE TABLE semantic_vectors (
    scope TEXT NOT NULL,
    model_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    vector BLOB NOT NULL CHECK(length(vector)=1536),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(scope,model_id,kind,item_id)
);
CREATE INDEX semantic_vectors_age ON semantic_vectors(updated_at,scope,kind,item_id);
