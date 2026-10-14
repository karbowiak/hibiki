-- Indexed renderer scalars/tags are separate from full private raw metadata.
-- No full archive scan runs in this migration; bounded background batches fill
-- old rows while these triggers cover all inserts/changes/deletions immediately.
CREATE TABLE plex_catalogue_browse_data (
 scope TEXT NOT NULL,kind TEXT NOT NULL,id INTEGER NOT NULL,catalogue_rowid INTEGER NOT NULL,
 removed INTEGER NOT NULL,fields TEXT NOT NULL,
 parent_id INTEGER GENERATED ALWAYS AS (CAST(coalesce(json_extract(fields,'$[0]'),substr(json_extract(fields,'$[1]'),19)) AS INTEGER)) VIRTUAL,
 artist_id INTEGER GENERATED ALWAYS AS (CAST(coalesce(json_extract(fields,'$[2]'),substr(json_extract(fields,'$[3]'),19)) AS INTEGER)) VIRTUAL,
 disc INTEGER GENERATED ALWAYS AS (CAST(json_extract(fields,'$[4]') AS INTEGER)) VIRTUAL,
 track_index INTEGER GENERATED ALWAYS AS (CAST(json_extract(fields,'$[5]') AS INTEGER)) VIRTUAL,
 year INTEGER GENERATED ALWAYS AS (CAST(json_extract(fields,'$[6]') AS INTEGER)) VIRTUAL,
 rating_count INTEGER GENERATED ALWAYS AS (CAST(json_extract(fields,'$[7]') AS INTEGER)) VIRTUAL,
 user_rating REAL GENERATED ALWAYS AS (CAST(json_extract(fields,'$[8]') AS REAL)) VIRTUAL,
 added_at INTEGER GENERATED ALWAYS AS (CAST(json_extract(fields,'$[9]') AS INTEGER)) VIRTUAL,
 last_rated_at INTEGER GENERATED ALWAYS AS (CAST(json_extract(fields,'$[10]') AS INTEGER)) VIRTUAL,
 released_on TEXT GENERATED ALWAYS AS (date(json_extract(fields,'$[11]'))) VIRTUAL,
 album_name TEXT GENERATED ALWAYS AS (json_extract(fields,'$[12]')) VIRTUAL,
 title TEXT GENERATED ALWAYS AS (json_extract(fields,'$[13]')) VIRTUAL,
 PRIMARY KEY(scope,kind,id)
);
CREATE UNIQUE INDEX plex_catalogue_browse_rowid ON plex_catalogue_browse_data(catalogue_rowid);
CREATE INDEX plex_catalogue_browse_title ON plex_catalogue_browse_data(scope,kind,removed,title COLLATE NOCASE,id);
CREATE INDEX plex_catalogue_browse_recent ON plex_catalogue_browse_data(scope,kind,removed,added_at DESC,id);
CREATE INDEX plex_catalogue_browse_liked ON plex_catalogue_browse_data(scope,kind,removed,last_rated_at DESC,id) WHERE user_rating>0;
CREATE INDEX plex_catalogue_browse_release ON plex_catalogue_browse_data(scope,removed,released_on DESC,id) WHERE kind='album';
CREATE TABLE plex_catalogue_browse_tags (
 scope TEXT NOT NULL,kind TEXT NOT NULL,id INTEGER NOT NULL,resource TEXT NOT NULL,
 tag TEXT NOT NULL,removed INTEGER NOT NULL,
 PRIMARY KEY(scope,kind,id,resource,tag)
);
CREATE INDEX plex_catalogue_browse_tag_inventory ON plex_catalogue_browse_tags(scope,resource,removed,tag COLLATE NOCASE);
CREATE INDEX plex_catalogue_browse_tag_members ON plex_catalogue_browse_tags(scope,kind,resource,removed,tag,id);
CREATE TABLE plex_catalogue_browse_state (
 scope TEXT PRIMARY KEY,cursor_kind TEXT NOT NULL DEFAULT '',cursor_id INTEGER NOT NULL DEFAULT 0,
 upper_rowid INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0
);
INSERT INTO plex_catalogue_browse_state(scope,upper_rowid)
 SELECT DISTINCT scope,(SELECT coalesce(max(rowid),0) FROM plex_catalogue) FROM plex_catalogue;
CREATE TRIGGER plex_catalogue_browse_insert AFTER INSERT ON plex_catalogue BEGIN
 INSERT OR IGNORE INTO plex_catalogue_browse_state(scope,upper_rowid,complete) VALUES(new.scope,0,1);
 INSERT INTO plex_catalogue_browse_data(scope,kind,id,catalogue_rowid,removed,fields)
 VALUES(new.scope,new.kind,new.id,new.rowid,new.removed,json_extract(CASE WHEN new.listing_saved_at>new.saved_at THEN json_patch(new.document,json_remove(new.listing,'$.Media','$.Guid')) ELSE new.document END,'$.parentRatingKey','$.parentKey','$.grandparentRatingKey','$.grandparentKey','$.parentIndex','$.index','$.year','$.ratingCount','$.userRating','$.addedAt','$.lastRatedAt','$.originallyAvailableAt','$.parentTitle','$.title'));
 INSERT OR IGNORE INTO plex_catalogue_browse_tags(scope,kind,id,resource,tag,removed)
 SELECT new.scope,new.kind,new.id,
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
 SELECT new.scope,new.kind,new.id,
        CASE CAST(resources.key AS INTEGER) WHEN 0 THEN 'Genre' WHEN 1 THEN 'Mood' WHEN 2 THEN 'Style' ELSE 'Format' END,
        CASE WHEN t.type='object' THEN json_extract(t.value,'$.tag') END,new.removed
 FROM json_each(json_extract(CASE WHEN new.listing_saved_at>new.saved_at THEN json_patch(new.document,json_remove(new.listing,'$.Media','$.Guid')) ELSE new.document END,'$.Genre','$.Mood','$.Style','$.Format')) resources,
      json_each(CASE WHEN resources.type='array' THEN resources.value ELSE '[]' END) t
 WHERE CASE WHEN t.type='object' THEN json_type(t.value,'$.tag')='text' ELSE 0 END;
END;
CREATE TRIGGER plex_catalogue_browse_delete AFTER DELETE ON plex_catalogue BEGIN
 DELETE FROM plex_catalogue_browse_data WHERE scope=old.scope AND kind=old.kind AND id=old.id;
 DELETE FROM plex_catalogue_browse_tags WHERE scope=old.scope AND kind=old.kind AND id=old.id;
END;
