# Background work

Hibiki embeds Butler (`butler-jobs`, SQLite and Tokio features only). Native jobs
run on two `hibiki-background` Tokio threads inside the desktop process. Existing
TypeScript reconciliation runs in the app-owned `hibiki-reconciliation` Web Worker,
with Butler controlling admission and execution. Nothing continues after quitting.
There is no service, sidecar executable, broker, or separately installed runtime.

Creating a merged playlist commits a local SQLite request and opens its page
immediately. The mixed-playlist worker reads the ordered source contents, retains
unavailable source occurrences, then matches and syncs in bounded turns. An
unfinished source read resumes from the retained request after restart. The
original provider playlists are read-only inputs. Duplicate removal joins the
loaded sources by recording metadata before provider lookups, keeps both service
references, then combines additional shared identities as matches arrive. Version,
performer, explicitness and duration checks protect different recordings. Playback
uses the best known audio quality, with Plex preferred when formats are unknown. Activity
and the playlist's Sync button distinguish preparation, matching and syncing.

`jobs.sqlite3`, alongside `plexmusic.db`, contains jobs and recurring schedules.
It has separate connections/WAL and private file permissions. Domain handlers still
use the library database through its existing APIs when they need library data.
File protections run before SQLite opens the job database. Do not open/close raw
database or SHM descriptors afterward: POSIX close can release SQLite's locks.

## Capacity

The durable worker claims eight jobs at most. Named queues allow two jobs each,
except reporting, waveform/analysis, speculative audio preparation, each TypeScript
reconciliation domain, and collection hydration, which each allow one. Playlist,
ListenBrainz, favorites, and rating work have independent queues, so a slow matcher
cannot hold up unrelated sync. Weighted scheduling favors sync and matching
while allowing other lanes to advance. The coordination limit leaves native slots
available for the catalog and playlist reads a coordinator awaits. Domain journals
also serialize their own writes. Existing provider throttles and CPU/download locks
remain authoritative; queue concurrency cannot bypass them.

Admission and captured advisory futures are capped at 1,000. Identical concurrent
renderer calls share admission/IPC, and keyed advisory captures share pending work.
Completed results are retained for at least an hour after observing completion
(Butler has no completion timestamp); terminal rows beyond a recent 200 per state are
reclaimed in bounded batches. The Activity dropdown shows individual queued/running
jobs, their current step/item, and measured progress when a total is known. Progress
notifications and checkpoints are sampled; write receipts are not.
Queue notifications coalesce status reads to at most two per second. Store
transfers compare immutable field references before cloning and send changed
fields only; a progress change does not copy an unchanged playlist collection.
Queue and domain reports share semantic Activity identities, preserving names,
navigation and review state in one row per operation.

Collection turns carry their saved cursor and total across queue handoffs and
report them before the next network page. Completed matching indexes admit work
only when a scan, notification, freshness check or incremental refresh is due.
Automatic Plex collection warming excludes smart playlists; their metadata stays
in the sidebar, and their contents load on demand. Saved YTM playlists warm through
the same collection lane in four-page turns, reusing the native catalog cache,
SWR and adaptive rate limiter. One account-scoped feeder coalesces library views,
revisits playlists every 15 minutes, and retires work after an account change.
Warmup caches track metadata, not audio downloads or personalized radio queues.
Fresh persisted collection snapshots are checked before admitting a hydration job,
then checked again by the worker. YTM warmups retain cursor fingerprints across
turns to reject cycles, do not restart active work at expiry, and measure their
next refresh interval from completion rather than admission.
Liked-song imports run hourly or when the user clicks Sync. New likes and newly
resolved recordings export promptly in bounded turns without importing both
complete remote rosters again. Pending receipts are verified first, then remaining
membership changes retry automatically against the observed state. Recovery does
not import a remote roster over retained local intent; stalled turns back off for
two minutes. Disabled services stay idle. Their own saves do not request another
import. Missing-recording checks have a separate
Activity identity and drain in bounded batches, with progress measured across
the saved daily backlog.

Playlist index checks run once for unresolved counterparts on startup, then only
for relevant index notifications. They share the playlist writer lane, and check
the latest saved playlist again after waiting so a completed sync needs no repeat
work. Ordinary sync polling does not enqueue these index checks.
YTM catalog matching checks the native catalog cache before admitting a read job.
Fresh hits return immediately, while stale hits retain the ordinary coalesced SWR
refresh. Cold or explicitly forced lookups still run in the matching queue.
Plex and YTM browsing use the shared native Moka/SQLite metadata store. Their
provider-owned SWR returns stale data immediately and admits refreshes in Butler's
refresh lane. Persisted fetch timestamps survive restart, failed refreshes back off,
and changed results notify the visible client without remounting its page.

Recurring schedules check whether their domain has work before admission. Empty
listening outboxes, unrequested download collections, fresh matching indexes and
not-yet-due YTM sign-in refreshes do not create polling jobs. Listening-history
turns select up to 32 due reports for the current accounts before applying the
batch limit; old accounts and backed-off reports remain retained. Exact rating
matching reacts to relevant index changes, with one startup check. Retry turns
skip acknowledged/disabled targets and rotate through pending entries so earlier
unmatched recordings cannot starve later intentions.

## Integrated workflows

- Mixed-playlist matching and two-way Plex/YTM reconciliation. A lookup producer
  and coalescing writer run concurrently: newly verified matches can sync before
  the remaining lookup batch finishes. Checkpoints preserve membership, order,
  revisions, and uncertain-write receipts.
- ListenBrainz linked-playlist matching and reconciliation, favorites sync, and
  exact YTM/Plex/Last.fm/ListenBrainz rating propagation. Their background entry
  points run in the reconciliation worker; presentation and user edits stay in
  the client. Only existing explicit sync settings and links are followed.
- Plex download transfers and hourly requested playlist/album/artist refreshes,
  including their existing manifest reconciliation for new/removed members.
- Explicit YTM and mixed-playlist downloads, using native playlist manifests,
  shared audio claims and the existing download transfer lock. The v2 task remains
  distinct from the deliberately retired experimental YTM download task.
- Bounded automatic YTM audio-quality probes for verified search counterparts,
  fenced by account and session in the matching lane.
- Speculative upcoming audio caching and loudness measurement, independently of
  the playback control thread, plus waveform generation and saved audio analysis
  backfill. Actual selected playback and deck preloads retain their immediate path.
- Compact Plex matching-index acquisition and incremental metadata maintenance,
  in bounded turns with existing foreground-pressure and pause behavior.
- Native listening outbox for Plex, Last.fm, and ListenBrainz on a recurring schedule.
- YTM matching/catalog reads, fresh playlist snapshots, stale catalog refreshes,
  and periodic sign-in maintenance. Interactive sign-in stays immediate.
- Paged Plex collection hydration and stale library metadata revalidation, with
  bounded page turns. Reads needed by the displayed page retain their direct path.
- Default Plex playlist bootstrap, downloaded-library reconciliation/exports,
  cache access bookkeeping, and stale headphone EQ catalog refreshes.

Cached upcoming audio and waveforms are checked before speculative admission;
actual workers still recheck the shared file/analysis cache. Server-side saved
audio metadata backfill uses the metadata lane so it cannot occupy the local
waveform generation lane. Browsing LRU touches are coalesced and written at most
once per minute per active snapshot, rather than on every cache hit.

YTM playlist writes run on the background runtime with two reserved permits,
rather than entering an at-least-once mutation queue. The playlist's own journal
retains its receipt and verifies uncertain results. Interrupted song writes read
the complete current playlist and replan only the remaining changes, preserving
local intent and unexpected provider additions. Known destinations recover even
if automatic sync was switched off after admission, with 30-second retry pacing.
Fresh occurrence handles replace old ones before any positional edit. Recovery
details remain in Info; Activity shows the retry without requesting review.
An unidentified creation still needs its destination selected, so recovery never
creates another copy by guessing.
Expected ownership retirement and domain-level review outcomes do not become
Butler handler failures. Worker startup, transport, and programming failures still do.

## Ownership and the TypeScript bridge

Job payloads contain public identifiers, opaque owner IDs, connection revisions,
and reconciliation options. They never contain cookies, tokens, expiring streaming
URLs, provider instances, or executable functions. The flattened job envelope uses
`workId`; advisory captures use `id`. Keep these distinct.

The main webview transports worker RPC, provides a live provider binding, and
publishes state for rendering. Reconciliation and scoring execute off its thread.
Provider IO is checked before and after against the live binding. Fresh playlist
reads bypass saved browsing data during write preflight. SQLite domain
journals retain their existing revision checks; delayed publications cannot replace
newer playlist revisions or rating intentions.
Incoming patches are acknowledged without echoing them back. Unsent local edits
remain pending, and clearing an optional state field is carried across the bridge.

A real account/session replacement retires work. Routine settings and YTM catalog
updates do not recreate an unchanged Plex proxy. Native job keys include their
scope/revision. Active dedup keys are reconstructed from SQLite after restart.
An unrecognized saved schedule is deferred independently so compatible schedules
can continue; a reconnect cannot overwrite a newer schedule's due time.
Renderer jobs also have a renderer-session owner; after a reload, the existing
foreground hooks reoffer unfinished domain intentions for the new owner. Stale
renderer jobs retire without replaying writes for a different binding.

Best-effort advisory captures (cache warming/maintenance) expire with their process.
Their next startup/read reoffers work. They are not a replacement for durable user
intent. UI-visible read requests, audio callbacks/visualizers, connection transport,
and the shutdown durability barrier retain their direct paths.

## Adding native work

Add a versioned `Task`, lane, name, and dispatcher in `src-tauri/src/background_jobs`.
Bound handlers so they release slots between batches. Use:

- `spawn(app, task, unique)` for accepted fire-and-forget work.
- `submit(app, task, unique, delay)` for a durable job ID.
- `call(app, task)` for a shared deduplicated read result.
- `every(app, task, interval)` for a retained coalescing schedule.
- `advisory(lane, label, future)` for transient captured cache work.
- `advisory_once(key, lane, label, future)` for keyed, coalesced cache work. Include
  ownership/cancellation revisions where a newer request can retire older work.
- `mutation(app, future)` for non-replayable writes with domain-owned receipts.
- `report(stage, current, completed, total, unit)` for public progress. Propagate
  its cancellation result at safe boundaries; it is a no-op outside a queue job.

Use `DbState::read` for background lookups and `DbState::write` or the scoped
`owned_write` helper for persistence. Do not block an async worker on the writer
mutex, especially while retaining `PlexState.0`: that mutex also admits playback.
Check account ownership before IO and again at publication. Download progress is
best effort when the writer is busy; final download state remains durable.

Resume cursors and side-effect receipts belong in the relevant domain journal;
Butler's progress snapshot is display/checkpoint metadata, not a replacement for
write verification. Keep recurring identities stable across reconnects, replacing
their payload with the current connection revision.

Butler's web dashboard is not hosted or exposed by Hibiki in this implementation.
Its 0.1.0 crate requires Rust 1.96; Hibiki's declared minimum now matches that.
