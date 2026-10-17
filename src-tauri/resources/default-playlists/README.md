# Default music playlists

These are the original posters from the reference Plex playlists, saved without
editing. No server addresses, credentials, section IDs or library UUIDs are
bundled. The portable filters live in `src/default_playlists.rs`.

| Playlist | Plex filters and ordering |
| --- | --- |
| ❤️ Tracks | Tracks with `track.userRating>>=1`, grouped by GUID, earliest album release, sorted by `lastRatedAt:desc` |
| All Music | All tracks (`type=10`) |
| Fresh ❤️ | Tracks with `track.userRating>>=4` and `track.lastViewedAt<<=-1mon`, grouped by GUID, earliest album release, sorted by `lastViewedAt` |

The operator suffixes are part of the Plex query keys: for example, the key
`track.userRating>>` has value `1`. URL encoding must preserve those operators.

❤️ Tracks uses ratings in Plex. Hibiki's Liked Songs collection is independent;
creating these defaults does not turn on likes sync, playlist sync or downloads.
