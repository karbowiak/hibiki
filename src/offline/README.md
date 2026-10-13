# Scoped saved-library browsing

SQLite V2 browsing snapshots are separate from the legacy globally keyed Plex
metadata tables. A snapshot belongs to the protected account/server/library digest
and an exact method + argument key, including pagination offset/size and filters.
Repeated playlist occurrences, server totals and album alternate IDs are preserved.
The cache records only already requested pages; it performs no library-wide scan.

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

Downloads are fully decoded in bounded batches and compared with native file
size/duration before atomic publication. Publication rechecks the connection and
job revision, so logout, removal, remove/re-add and reconnect cannot publish old
work. Failed index persistence is a failed download. Progress, retry, removal and
actual file availability are visible in Downloads. User-selected local playback
does not fetch Plex audio, gain or waveform metadata; native audio rechecks its
owned file at every play/preload and never falls back to HTTP in saved-library
mode. Missing/truncated files are unavailable; late decode failure retires only
the file revision that failed.

The full local Plex catalogue, immediate local reads with asynchronous refresh,
connection health/recovery and availability styling across all library views
remain the next phase. This audio index does not silently download the library.
