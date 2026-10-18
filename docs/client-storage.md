# Application storage

Desktop application records use the `client_state` table in `plexmusic.db`.
Preferences, provider caches, playlist links, matching results and mutation
receipts all use the same native SQLite commands from the renderer and worker.
Butler's scheduling records remain in the separate `jobs.sqlite3` database.
Raw Plex/YTM browsing responses share Moka and `metadata/metadata.sqlite` in
the disposable cache directory; rendered page snapshots use `client_state`.
Explicit provider download manifests use `provider_playlist_downloads` alongside
the existing native audio jobs and claims in `plexmusic.db`.

This development cutover starts fresh for former IndexedDB and localStorage
records. There is no browser-data import or fallback. Existing browser records
are unused; provider playlists and native audio/cache/account data retain their
existing storage. Browser-only previews keep temporary records in memory.

`src/storage/clientStorage.ts` provides asynchronous records and the small
synchronous preference snapshot needed for first paint. Startup loads that
snapshot before importing application stores. Preference writes participate in
the existing retry notice and graceful-shutdown barrier.

Updates use an expected revision in SQLite. A competing renderer/worker write
causes the reducer to rerun against the committed value. Deletes retain a
tombstone revision so delayed writes cannot restore old records. Domain journals
still validate their own revisions, ownership and mutation receipts before a
provider write. SQLite work runs through the native blocking database lanes.
