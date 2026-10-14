# Liked Songs

Hearts save compact recording references to native SQLite (V12), scoped to the
Plex account/server/music library. A heart does not rate a song or change Plex,
Last.fm or ListenBrainz by default. Unlike records remain as tombstones so a
reconnect does not silently restore an explicit local unlike.
Profiles currently follow the saved library's native cache identity: changing
Plex credentials or server endpoint selects another local profile. Existing
profiles remain in SQLite.

Liked Songs has Loved, Rated and All views. On its first successful rated-track
load, existing ratings at or above the local threshold are included once. New
ratings at the threshold also add a local favorite. Explicit hearts override
later rating changes. Stars continue to use Plex ratings; Last.fm scrobbling and
favorites syncing have separate switches.

The Sync dialog enables each connection independently, with all three disabled
initially. Plex uses a regular audio playlist, defaulting to a new **Liked Songs**
playlist; an existing regular playlist can be chosen. Smart playlists such as
❤️ Tracks remain independent. ListenBrainz uses recording feedback; Last.fm
uses loved tracks. Only known recording MBIDs/MSIDs are sent to ListenBrainz.
Unresolved IDs or library matches stay saved and appear in the review panel,
which supports manual matching and local removal. Missing recording IDs can be
looked up again or explicitly selected using a checked MusicBrainz recording ID.

First connection is additive: existing remote favorites are imported and local
favorites are exported, while explicit local unlikes stay removed. Subsequent
complete, stable rosters reconcile remote likes/unlikes against per-service
observations and captured local intent. Local changes during a write survive its
acknowledgment. Read failures, truncated pages and account changes do not admit
roster removals. Distinct legacy ListenBrainz MSIDs retain separate feedback
identities; shared library songs display once and local hearts update the linked
identities together. Plex/Last.fm removals wait while another retained identity
still loves the same song. Last.fm cannot distinguish recordings sharing the
same artist/title labels.

Network credentials remain native. Each mutation has a durable admission
receipt, a fresh preflight and read-back proof. Plex validates the library,
regular playlist, complete ordered membership and occurrence handles. Additions
use ordered batches of up to 100 songs; removals use the actual occurrence ID.
Mutations are not automatically retried. An uncertain result is reconciled by
reads; an unchanged uncertain write needs the explicit retry button. Unknown
playlist creation never issues a second create, and its original empty
Liked Songs destination can be inspected/adopted in the dialog.

While Hibiki is open and connected, sync runs after local changes and every two
minutes, with bounded writes and matching work. Unmatched favorites retry daily
or through Find more matches. SQLite updates serialize only changed compact
rows in batches of 1,000. Indexed identity maps make large roster merges linear;
unchanged observations do not rewrite the collection. Browsing publishes saved
metadata in native batches of 200 with a bounded Plex fallback. Offline hearts
remain editable; playback still requires complete cached/downloaded audio.

Contracts: [ListenBrainz feedback API](https://listenbrainz.readthedocs.io/en/latest/users/api/recordings.html),
[feedback JSON](https://listenbrainz.readthedocs.io/en/latest/users/feedback-json.html),
[Last.fm loved tracks](https://www.last.fm/api/show/user.getLovedTracks),
[love](https://www.last.fm/api/show/track.love),
[unlove](https://www.last.fm/api/show/track.unlove), and
[Plex playlists](https://developer.plex.tv/pms/#tag/Playlist).

Verification uses synthetic renderer fixtures, in-memory SQLite and local HTTP
servers for Plex, Last.fm and ListenBrainz. Personal external favorites are not
mutated as a test.
