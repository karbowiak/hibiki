# Scoped saved-library browsing

SQLite V2 browsing snapshots are separate from the legacy globally keyed Plex
metadata tables. A snapshot belongs to the protected account/server/library digest
and an exact method + argument key, including pagination offset/size and filters.
Repeated playlist occurrences, server totals and album alternate IDs are preserved.
These snapshots remain bounded. SQLite V5/V6 separately retains the complete
private Plex documents and builds a resumable catalogue with scoped FTS5 search.
The native worker scans bounded artist/album/track/playlist rosters, batches full
details, and publishes playlist memberships only after a complete verified scan.
Interrupted pages resume; changed totals/repeated pages restart a generation.
Missing entities are soft removed after a complete census, preserving download
provenance. Legacy unscoped rows never become a trusted catalogue.

Plex reads show local data immediately and revalidate asynchronously. Identical
sanitized responses do not trigger UI refreshes; changed responses update active
collections/detail caches, and changed playlist pages retire the old paging
generation. Cold misses use Plex and persist the result. Fresh playlist sync and
download preflight reads bypass local-first snapshots.

Online read methods save successful credential-free DTOs. Transport unavailability
can return an exact saved page while the same provider/session/library still owns
the request. Authentication/permission/not-found failures do not become cached
success. Storage failure leaves online browsing usable. Mutation, queue and playback
methods never execute from saved data. Accepted writes invalidate the relevant
cached method/item prefixes, preserving unrelated visited detail pages.

The explicit “Browse saved library” entry resets/revokes the previous connection
and asks native code to restore a trusted identity from protected saved settings.
It cannot select an arbitrary previous frontend account. Its provider reports
`isOffline=true`, `isConnected=false` and read-only capabilities; uncached pages
remain unavailable. The native audio index enables playback of complete local
files for that same owner. Remote mutations and queue generation remain disabled.

Each page is at most 1 MiB, each scope at most 2,000 pages/32 MiB, globally at most
8,000 pages/128 MiB. Writes and eviction are atomic. SQL migrations and schema
version changes commit together. DTOs exclude opaque provider data, stream URLs,
credential fields and URL credentials (including nested image source URLs).

## Audio cache and downloads

SQLite V4 stores native audio bindings under account/server/library + track +
media-source digest, and a separate durable download queue. No credentials,
authenticated URLs or server filesystem paths are stored in these rows. Legacy
globally keyed track rows cannot authorize local audio. Native fresh metadata
must match both the selected library and track; media quality uses the same
lossless/bit-depth/sample-rate/bitrate order as the renderer.

Automatic playback caching remains bounded and evictable. Explicit downloads
use an independent private `downloads` directory in app data, with no automatic
LRU eviction. Clearing or shrinking the automatic cache preserves downloads.
Download storage rejects new admissions at its 32,768-file index limit rather
than deleting saved music. Files are capped at 2 GiB each; unsupported multipart
tracks are rejected rather than saving only the first part.

One native worker transfers tracks sequentially. Playlist requests use fresh,
paged reads; audio intentions collapse repeated tracks without altering Plex
playlist occurrences. Admission is limited to 256 tracks per batch and 10,000
pending intentions. Complete automatic-cache files are copied and validated
without another media request. Transfers retry verified overlapping HTTP byte
ranges in the current run. After an app restart/reconnect, interrupted intentions
restart from byte zero; abandoned partials are never marked available.

Downloads are fully decoded in bounded batches and compared with HTTP body
length and native decoded duration before atomic publication. Publication rechecks the connection and
job revision, so logout, removal, remove/re-add and reconnect cannot publish old
work. Failed index persistence is a failed download. Progress, retry, removal and
actual file availability are visible on each music item. User-selected local playback
does not fetch Plex audio, gain or waveform metadata; native audio rechecks its
owned file at every play/preload and never falls back to HTTP in saved-library
mode. Missing/truncated files are unavailable; late decode failure retires only
the file revision that failed.

A native health monitor verifies server and library identity before restoring a
connection. Temporary loss closes native remote admission and switches the same
playback owner to local reads/playback with a prominent banner and read-only
capabilities. It does not stop active audio. Saved-only mode stays explicitly
local; startup can fall back to a trusted saved catalogue when connection fails.
Actual file availability is projected in batches; missing tracks are grayed and
cannot be played or queued offline. Catalogue scanning never downloads encoded
audio, requests server analysis, installs models or changes remote objects.

Full raw documents (including unknown fields, all media/streams, GUIDs and native
paths) remain in private native storage. Renderer projections strip native file
paths and audio URLs. Full `/levels` responses are indexed for every available
audio stream under exact scoped source and analysis identities. Missing analysis
is explicitly unavailable/retryable; it does not imply exported sonic vectors.
The Activity dropdown reports saved entities, the current indexing phase,
waveforms and missing analysis; failures use the shared notification center.
A large initial scan can take time: partial local browse reports local counts
separately from server totals, and children require verified coverage.
Very large unpaged DTO collections fail explicitly at 32 MiB instead of silently
truncating; paged library/playlist reads remain bounded.

Plex read responses can contain invalid UTF-8 from imported tags. Bounded native
decoding repairs only malformed value text to U+FFFD and retains original byte
sequences, offsets and field pointers privately beside the affected raw record.
Object keys, JSON structure and response limits remain strict; credential fields
and authenticated URLs are excluded from recovery provenance. Generic provider
JSON and Plex mutations retain strict decoding.

Download status lives on tracks, albums, artists and playlists rather than a
separate Downloads screen. Visible icons share scoped, batched native polling;
complete membership is required before showing a fully downloaded collection.
Partial and failed downloads remain retryable from the entity menu, including
artist discographies. Cache settings show explicit download storage separately
from the evictable playback cache. The old /downloads route redirects there.

V7 retains expected download membership separately from file ownership. A
collection removal releases only that collection's claims and preserves files
used by other collections or explicit individual-song downloads. Song removal
releases that song everywhere, leaving collections honestly partial. New weekly
playlist membership never silently deletes a previously saved edition. Existing
V4 download jobs migrate as individual intentions because their original source
was not recorded. Preparation verifies the native library identity, paged
membership and playlist revision before queueing encoded audio.

Entity preparation also archives the entity's full native document and complete
raw member roster. Captured album children and verified published playlist
occurrences are independently browsable before the global census completes;
full track details enrich their media/analysis without losing playlist order or
duplicate occurrences. Removing a collection or removing/re-adding it retires
its revision, so outstanding batch admission cannot resurrect cancelled jobs.
Individual-song removal excludes that song from any remaining pending batches.
