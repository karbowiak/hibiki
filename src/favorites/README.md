# Liked Songs

Stars and likes share one local state. **Three stars or more** (6/10 on Plex's
scale) means liked. A deliberate lower rating or clear removes the local like
and flows through enabled two-way Last.fm/ListenBrainz sync. Artist and album
ratings retain their existing meaning.

Imported likes and legacy local likes display at least three stars in Hibiki;
higher existing ratings remain higher. This display is derived from the saved
favorite and never writes a rating to Plex. Original Plex metadata remains
separate, with its own rating dates. Manual star edits are saved to scoped native
SQLite first, including the exact value, edit date and intent identity. Online
edits then update Plex. A failed/offline Plex write keeps the local choice;
**More → Save rating to Plex** explicitly retries it, with no automatic replay.
Newer edits and library/account changes fence old acknowledgments. Ratings for
the same song are serialized so an older request cannot overwrite a newer edit.

Remote unlikes clear the local star display without changing Plex's original
rating. Last manual values and original Plex ratings remain available as
provenance, so a later remote like preserves a higher rating. Explicit local
unlikes remain tombstones and are not silently restored on reconnect. Imports,
matching, cache hydration and migration never enter the Plex rating-write path.

The one-time profile migration fixes the like threshold at three stars and
reimports eligible existing Plex ratings locally. It preserves saved entries,
liked dates, service observations, pending sync operations and user choices.
Liked Songs keeps Loved, Rated and All: Loved shows local likes; Rated shows
explicit local/Plex ratings; All combines both. Imported three-star displays do
not invent a manual rating date. Sorting uses the effective local rating.
Profiles follow the saved library's native cache identity; changing Plex
credentials or server endpoint selects another local profile. Existing profiles
remain in SQLite.

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
identities; shared library songs display once and local star edits update the linked
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
metadata in native batches of 200 with a bounded Plex fallback. Offline ratings
remain editable; playback still requires complete cached/downloaded audio.

Original love dates are retained in milliseconds: Last.fm's `date.uts` and
ListenBrainz's feedback `created` timestamp. Each service observation keeps its
own date. Continuous imported loves use the earliest known date across sources;
sync acknowledgements and matching do not bump it. Explicit local likes retain
their local date, and an unlike followed by a new love starts a new date. Legacy
imports can acquire dates on the next complete roster without a reset. Missing
service dates stay unknown rather than being replaced with an import timestamp.

Loved defaults to newest known love first. All combines that chronology with
Plex's rating dates for rated songs; library-added dates remain separate. Date
Liked is available as its own sortable column, with unknown values last in
either direction. Existing column visibility preferences are preserved.

All native ListenBrainz traffic shares a one-request-per-second budget, including
favorites, playlists, token checks and scrobbles. Responses update pacing from
rate-limit headers; explicit 429 responses allow bounded retries of reads only.
Long cooldowns return a clear wait message rather than making new requests.
Mutation account checks run after waiting for a slot, and mutations require a
fresh preflight after a long cooldown. Mutation/create/listen POSTs are sent once.
Feedback imports request bounded pages of up to 1,000 records to reduce traffic.

Last.fm traffic also shares a conservative one-request-per-second budget across
favorite imports/exports, metadata, authentication, now-playing and scrobbles.
HTTP 429 and Last.fm error 29 (including HTTP 200 responses) pause that shared
budget, honoring Retry-After or waiting 60 seconds when no delay is supplied.
Account checks run after waiting, and long cooldowns require a new mutation
preflight. Requests are not replayed by this transport.

Library matching requires compatible artist credits independently of title
similarity. Featured artists may move between the title and artist fields;
matching credits may use different join punctuation or order. An omitted
collaborator needs an explicit feature credit, matching album or duration
evidence. Different named guests remain distinct. Compilation tracks use Plex's
track artist when supplied. Artist-prefixed titles and neutral original-mix
labels are tolerated; numbers, live releases, remixes, language versions and
other named editions remain protected. Conflicting recording IDs and genuinely
different local editions still require review. Existing mappings are retained.

Settings → General → Liked Songs sync offers Manage sync and Reset liked sync.
Reset clears imported likes, automatic library matches and per-service sync
observations for the current library. Explicit local ratings, likes and unlike
tombstones, service settings, account bindings, Plex playlist destinations and
Plex ratings are retained. Enabled services are imported again with the current
matcher, and rated favorites may be seeded again. The native reset is atomic,
bumps the storage revision to fence stale saves and refuses pending mutations or
uncertain playlist creation. Reset waits for an active sync to finish; outstanding
matching results are retired so they cannot repopulate the cleared state.

Service issues, unconfirmed changes, missing library matches and unresolved
ListenBrainz identities are reviewed from the Liked Songs Sync button, marked
with a yellow triangle. Background sync does not create global notifications
for these states, and a retry retains the existing indicator until its result
confirms recovery.

Contracts: [ListenBrainz feedback API](https://listenbrainz.readthedocs.io/en/latest/users/api/recordings.html),
[feedback JSON](https://listenbrainz.readthedocs.io/en/latest/users/feedback-json.html),
[Last.fm loved tracks](https://www.last.fm/api/show/user.getLovedTracks),
[love](https://www.last.fm/api/show/track.love),
[unlove](https://www.last.fm/api/show/track.unlove), and
[Plex playlists](https://developer.plex.tv/pms/#tag/Playlist).

Verification uses synthetic renderer fixtures, in-memory SQLite and local HTTP
servers for Plex, Last.fm and ListenBrainz. Personal external favorites are not
mutated as a test.
