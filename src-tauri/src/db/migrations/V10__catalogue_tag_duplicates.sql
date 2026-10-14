-- Full Plex metadata can repeat a tag. Deduplicate derived tag rows before
-- INSERT so outer catalogue UPSERT conflict policy cannot turn them into a
-- primary-key error. Raw documents, existing projections and backfill cursors
-- are preserved; this migration never scans the catalogue.
DROP TRIGGER plex_catalogue_browse_insert;
DROP TRIGGER plex_catalogue_browse_update;
CREATE TRIGGER plex_catalogue_browse_insert AFTER INSERT ON plex_catalogue BEGIN
 INSERT OR IGNORE INTO plex_catalogue_browse_state(scope,upper_rowid,complete) VALUES(new.scope,0,1);
 INSERT INTO plex_catalogue_browse_data(scope,kind,id,catalogue_rowid,removed,fields)
 VALUES(new.scope,new.kind,new.id,new.rowid,new.removed,json_extract(CASE WHEN new.listing_saved_at>new.saved_at THEN json_patch(new.document,json_remove(new.listing,'$.Media','$.Guid')) ELSE new.document END,'$.parentRatingKey','$.parentKey','$.grandparentRatingKey','$.grandparentKey','$.parentIndex','$.index','$.year','$.ratingCount','$.userRating','$.addedAt','$.lastRatedAt','$.originallyAvailableAt','$.parentTitle','$.title'));
 INSERT OR IGNORE INTO plex_catalogue_browse_tags(scope,kind,id,resource,tag,removed)
 SELECT DISTINCT new.scope,new.kind,new.id,
        CASE CAST(resources.key AS INTEGER) WHEN 0 THEN 'Genre' WHEN 1 THEN 'Mood' WHEN 2 THEN 'Style' ELSE 'Format' END,
        CASE WHEN t.type='object' THEN json_extract(t.value,'$.tag') END,new.removed
 FROM json_each(json_extract(CASE WHEN new.listing_saved_at>new.saved_at THEN json_patch(new.document,json_remove(new.listing,'$.Media','$.Guid')) ELSE new.document END,'$.Genre','$.Mood','$.Style','$.Format')) resources,
      json_each(CASE WHEN resources.type='array' THEN resources.value ELSE '[]' END) t
 WHERE CASE WHEN t.type='object' THEN json_type(t.value,'$.tag')='text' ELSE 0 END;
END;
CREATE TRIGGER plex_catalogue_browse_update AFTER UPDATE OF document,listing,saved_at,listing_saved_at,removed ON plex_catalogue
 WHEN old.document IS NOT new.document OR old.listing IS NOT new.listing OR old.removed IS NOT new.removed
   OR (old.listing_saved_at>old.saved_at) IS NOT (new.listing_saved_at>new.saved_at) BEGIN
 INSERT INTO plex_catalogue_browse_data(scope,kind,id,catalogue_rowid,removed,fields)
 VALUES(new.scope,new.kind,new.id,new.rowid,new.removed,json_extract(CASE WHEN new.listing_saved_at>new.saved_at THEN json_patch(new.document,json_remove(new.listing,'$.Media','$.Guid')) ELSE new.document END,'$.parentRatingKey','$.parentKey','$.grandparentRatingKey','$.grandparentKey','$.parentIndex','$.index','$.year','$.ratingCount','$.userRating','$.addedAt','$.lastRatedAt','$.originallyAvailableAt','$.parentTitle','$.title'))
 ON CONFLICT(scope,kind,id) DO UPDATE SET catalogue_rowid=excluded.catalogue_rowid,removed=excluded.removed,fields=excluded.fields;
 DELETE FROM plex_catalogue_browse_tags WHERE scope=new.scope AND kind=new.kind AND id=new.id;
 INSERT OR IGNORE INTO plex_catalogue_browse_tags(scope,kind,id,resource,tag,removed)
 SELECT DISTINCT new.scope,new.kind,new.id,
        CASE CAST(resources.key AS INTEGER) WHEN 0 THEN 'Genre' WHEN 1 THEN 'Mood' WHEN 2 THEN 'Style' ELSE 'Format' END,
        CASE WHEN t.type='object' THEN json_extract(t.value,'$.tag') END,new.removed
 FROM json_each(json_extract(CASE WHEN new.listing_saved_at>new.saved_at THEN json_patch(new.document,json_remove(new.listing,'$.Media','$.Guid')) ELSE new.document END,'$.Genre','$.Mood','$.Style','$.Format')) resources,
      json_each(CASE WHEN resources.type='array' THEN resources.value ELSE '[]' END) t
 WHERE CASE WHEN t.type='object' THEN json_type(t.value,'$.tag')='text' ELSE 0 END;
END;
