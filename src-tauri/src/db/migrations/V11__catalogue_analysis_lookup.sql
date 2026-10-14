-- Discovery checks exact active track associations. The pending queue index
-- orders by status before track_id and cannot serve that lookup efficiently.
CREATE INDEX plex_catalogue_active_media ON plex_catalogue_media(scope,track_id) WHERE active=1;
