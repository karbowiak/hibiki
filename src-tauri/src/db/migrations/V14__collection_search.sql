ALTER TABLE collection_cache_items ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
UPDATE collection_cache_items SET search_text=lower(COALESCE(json_extract(payload,'$.title'),'') || char(10) || COALESCE(json_extract(payload,'$.artistName'),'') || char(10) || COALESCE(json_extract(payload,'$.albumName'),''));
-- Refresh development V13 snapshots once so Rust's Unicode case folding replaces
-- SQLite's ASCII-only initial backfill while old complete pages remain usable.
UPDATE collection_cache SET cached_at=0, stamp='';
