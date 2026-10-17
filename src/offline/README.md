# Saved browsing, collections and audio

Hibiki retains the data needed for visited pages, favorites, selected collections
and offline audio. Browsing does not crawl or mirror the entire Plex library. Historical
catalogue tables and readers remain compatible with previously saved data; their
old census, catch-up and waveform-discovery workers are retired.

The separately requested [compact matching index](../../docs/plex-matching-index.md)
retains scoped artist/release/recording identities and matching evidence. It is
independent of saved browse DTOs, survives focused-cache eviction and does not
claim offline availability or authorize playback/remote mutations.

## Ownership and saved pages

Native reads and writes belong to a protected account/server/library scope and a
connection revision. Reconnects, logout and library changes retire outstanding
work. A renderer-provided identity cannot authorize a different saved library.

`providerCache.ts` stores sanitized, exact method-and-argument responses, including
pagination and filters. Online reads can show a saved response and revalidate it;
changed responses refresh the affected view. Cold misses use Plex. Transport
unavailability may use the same owner's saved response; authentication, permission
and not-found failures do not become successful cached reads. Optional persistence
failure does not turn a successful online read into a failure.

Saved DTOs exclude credentials, authenticated URLs and opaque native provider data.
Pages are bounded to 1 MiB, 2,000 pages/32 MiB per scope and 8,000 pages/128 MiB
across scopes. Accepted mutations invalidate relevant snapshots. Fresh playlist
sync and download preparation bypass saved browse responses. Mutations and remote
queue generation never execute from saved responses.

“Browse saved library” restores a trusted saved identity through native code. The
provider is offline, disconnected and read-only; missing pages remain unavailable.
A health monitor can also switch a temporarily unavailable connected library to
local reads while preserving active audio. File availability is checked separately
from the presence of metadata.

## Focused collection caches

`collectionCache.ts` manages paged playlist rosters, selected mixes and rated
collections. Native `db/collection_cache.rs` stages membership in bounded batches
and activates a complete generation atomically. An incomplete refresh cannot
replace a complete collection. Repeated playlist occurrences retain their own IDs.

Default pages seek indexed positions and use the collection's stored total.
Filtered and sorted reads share compact ordered identities, keyed by database,
owner, active generation, item revision and query. The native query cache retains
at most eight results within 32 MiB. Shared metadata edits invalidate the order
through a transaction-visible database revision; full item DTOs stay in SQLite.

Mix order is seeded by a hash of complete canonical membership. Upstream paging,
metadata edits and source reordering do not linearize or reseed a mix. A membership
change produces a new stable permutation. Explicit shuffle remains a separate
playback choice.

`useWindowedPages` and `WindowedPages` retain up to eight 200-item renderer pages.
Playlist views use this single paging lifecycle, including retry and refresh.
They do not also load an independent prefix into the library store.

## Queue membership and metadata

A prepared cached queue captures its full ordered identity and occurrence list.
Filtered/sorted playback captures the query result once; later metadata reads use
those captured IDs rather than positions in a mutable query. Selecting a row also
checks that its captured occurrence still matches the clicked row.

`QueueSession` retains compact membership for the complete queue while hydrating
only visited/upcoming details. `QueueHydration` reads at most 100 positions per
batch and retains up to 800 full tracks. Playback precedes queued viewport and
prefetch work. New viewports supersede obsolete queued requests, and retired queues
cannot publish late data. Structural queue edits rebuild the position index once;
unchanged projections preserve the existing queue reference.

Queue persistence stores the selected order, occurrences, source positions and
playback state. A saved queue does not authorize audio belonging to another owner.
Playback preparation and Track Info share the scoped `PlaybackMetadata` resource;
provider/session changes and explicit metadata invalidation retire cached data.

## Audio cache and explicit downloads

The automatic playback cache is bounded and evictable. Explicit downloads live in
the operating system's Music directory under `Hibiki`, or a user-selected location.
Clearing or shrinking the playback cache preserves explicit downloads. Moving
downloads uses verified no-clobber copies before changing the configured root;
failed moves retain their original files.

Audio bindings include owner, track and media-source identity. Complete files are
validated before atomic publication, and playback/preload rechecks the owned file.
Offline playback never falls back to an HTTP audio request. Missing, truncated or
damaged files are unavailable, even when metadata remains browsable. Local playback
does not request remote gain or waveform metadata.

One native transfer worker processes downloads sequentially. Fresh, paged
collection preparation preserves expected order and repeated playlist occurrences,
while encoded-audio intentions deduplicate tracks. Publication checks ownership
and intention revision again, so logout, cancellation and remove/re-add cannot
publish retired work. Existing complete playback-cache files can be copied and
validated without downloading them again. Interrupted work restarts safely after
reconnect; abandoned partial files are never marked available.

Collection claims are separate from individual song intentions. Removing one
collection releases its claims while preserving songs owned by other collections
or individual downloads. Removing a song releases that song across collections.
New playlist editions do not silently delete previously downloaded editions.
Managed M3U files preserve verified playlist order and repeated occurrences and
contain only available complete files. Manual files are preserved.

`downloadStatusStore.ts` batches visible entity requests. Native status reads
select only jobs referenced by those entities and check each relevant file once.
The renderer drops departed badge statuses and reuses unchanged status objects.
Playlist Info exposes scoped, paged failures and retry actions. Explicit collection
requests are rechecked on reconnect and periodically while their library is online;
an individual song request does not start library-wide discovery.

`db/focused_library.rs` retains metadata needed by downloads, claims and favorites,
plus a small recent playback working set. Legacy catalogue presence does not prove
complete server coverage. Partial offline artist/album reads report partial data.
Existing native metadata and exact waveform identities remain private to their
owner; renderer projections omit native paths and authenticated audio URLs.

## Database and diagnostics

SQLite migrations and their schema versions commit together. Browse and playback
use independent read-only WAL connections on bounded blocking workers; playback
has reserved reader capacity. Each read runs against a consistent snapshot.
Writes run on the serialized writer lane and do not hold Plex/audio admission
locks while waiting for SQLite.

Development builds can write bounded private `performance-*.jsonl` sessions. They
record fixed operation/phase names and durations, without metadata, identities,
query arguments, URLs, paths, credentials or error text. Each session stops at
4 MiB and drops admissions under pressure. Production builds do not create these
logs. Run `python3 scripts/report-performance.py` to summarize a session. Native
SQL timings alone do not establish complete page-load or audible playback latency.
