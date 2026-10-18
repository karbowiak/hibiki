# Compact Plex matching index

The matching index is independent of the focused collection/browse cache. It
retains typed matching evidence for all artists, release formats and tracks in
one native account/server/library scope. It never stores raw Plex documents,
artwork, media paths, credentials or streaming links. Clearing the library cache
does not clear this index. Clearing this index keeps app-owned ratings,
playlists, queues and downloads.

## Census and ownership

- One background lane reads up to 500 listings at a time, with an 8 MiB response
  limit and a 30 second deadline. It yields during native audio buffering and
  supports explicit foreground deferral.
- The selected native music-library UUID is verified. Actual offsets, counts,
  totals, item types, identities and available library IDs must agree. Repeated
  identities or changing totals cannot advance a checkpoint.
- PMS versions supporting the published API receive the explicit `1.0.0`
  version header and field/element selection. Older servers use compatible
  exclusion parameters. Selection is only a request: returned records still
  have independent byte and shape validation.
- SQLite retains each generation and page checkpoint. Restart resumes partial
  work; an unchanged completed census is reused. Errors back off. A changed
  census restarts its checkpoint while retaining useful partial rows.
- Two identical listing passes must finish before unseen rows can be marked
  removed. Failed, partial, cancelled and superseded work cannot remove unseen
  records. Tombstones retain matching provenance; they never delete user data.
- SQL preparation runs on the serialized database writer without holding Plex
  connection/audio admission. A short native ownership guard fences the final
  commit. A library/account change rolls back a prepared old-owner transaction.
  WAL readers remain available during indexing. Checkpoint cleanup is bounded.

Rows preserve original names, normalized lookup keys, individual artist credits,
parent identities, available typed external IDs, duration/version/explicit
evidence, release date/type, disc/track positions and provider timestamps. Generic
Plex `mbid` GUIDs remain untyped; they are not recording MBIDs. Detailed media and
page DTOs remain on demand.

Settings → Cache → Plex Matching Index shows per-kind partial/covered progress
and census dates separately from freshness checks, pending changes and refresh
failures, with Pause, Resume, Rebuild and Clear controls. Clear
leaves indexing paused until Resume. Offline scopes can inspect/manage their
retained local index.

## Incremental freshness

Native refresh hints are scoped, durable and coalesced by identity. Up to 25
identities are fetched together with compact metadata, then checked against the
requested kind, identity and library. A newer hint cannot be acknowledged by an
older response. The queue is capped at 10,000 identities; overflow requests an
inventory reconciliation. A missing detail requests reconciliation and retains
the previous row. It is never deletion proof.

The worker checks section scan/change stamps every 15 minutes and after reconnect
hints, with a 30 second coalescing interval. A changed stamp, overflow, or a census
older than 24 hours schedules listing reconciliation. Unchanged completed indexes
are reused across startup. Active server scans defer reconciliation; pending work
survives restart. A watchdog restarts workers retired by transient local failures.

Once a day, a bounded capability query discovers date fields, date operators and
sorts. Only advertised, whitelisted `addedAt`/`updatedAt` combinations are used.
Unsupported or timed-out capability discovery falls back to listing
reconciliation. Supported delta windows overlap the entire previous UTC day.
Their server-time watermark advances only when all pages complete, and each page
checkpoint is durable. Missing/backwards timestamps, ignored filters and repeated
identities retain existing evidence and fall back safely. A completed census
supersedes old incremental windows. Network failures back off without advancing.

New observations update row and relationship evidence and its revision; late
census responses cannot overwrite newer verified detail responses. Row-change
history is bounded independently of page membership. Association invalidation and
retry consumers are part of the shared resolver work in #29–#30; freshness alone
does not establish that those consumers are connected.

## Shared identity resolver

The provider exposes bounded native batch, fallback, reverse-association and
change-cursor operations. Renderer requests coalesce for eight milliseconds, with
at most 16 items per IPC, two active batches and 256 pending identities. Completed
results live in SQLite rather than an expanding renderer cache. A provider,
session, library or YTM-account change rejects delayed replies.

Native lookup starts with retained associations, typed identifiers and indexed
normalized names. FTS supplies bounded candidates when exact recording/release
labels are absent; broad prefix results cannot make an existing exact match look
truncated. Candidate ranking preserves original credit labels and non-Latin
marks. Artist catalogs can disambiguate close names. Recordings require matching
credits and version/duration/explicit evidence, or a compatible typed identity.
Release dates, types, editions and supplied track lists fence release matching.
A Plex release may contain a verified subset of the YTM track list without being
treated as a different album.

Outcomes distinguish verified matches, candidates, ambiguity, absence, incomplete
source/index evidence, stale coverage, limited discovery and provider failure.
Partial index misses cannot establish absence. A bounded on-demand fallback reads
at most 50 scoped Plex records, with two network lanes and a 15 second listing
deadline. It retains useful native evidence, then reruns identity checks. A
complete bounded query can verify a positive match before the full census ends;
a truncated reply cannot. No YTM searches, ratings or playlist edits are scheduled
by indexing or identity lookup.

Proofs retain original source IDs, source-account binding, algorithm version,
evidence and separate target item IDs. Recording MBIDs remain separate from
release IDs and physical Plex copies. Multiple copies retain separate candidates;
a unique matching release occurrence may identify the preferred copy. Automatic
consumers never receive a selected ID for ambiguity. Returned matching rows are
identity evidence, never playback, offline or full browse DTOs.

Saved proofs reference native rows instead of duplicating their metadata.
Positive proofs validate row and parent-relationship revisions and relevant new
candidates. Negative proofs expire after a minute or on coverage/content changes.
Proof validity is capped at 24 hours. Reverse lookups revalidate the same proof
before exposing an original YTM destination. Targeted change pages preserve each
atomic row/relationship group; old cursors explicitly request a reset. Clearing
the matching index clears these proofs without touching user ratings, playlist
occurrences, queues or downloads. Consumer wiring and active unresolved retries
remain tracked in #30 and the outstanding acceptance work for #28.

## Validation boundary

Tests cover strict paging, changing/repeated records, failed storage, interruption,
durable restart, scope changes before commit, empty libraries, late observations
and independent cleanup. Chromium and WebKit exercise progress and all controls
in light and dark themes. Native tests verify that prepared index transactions
leave audio admission available and cannot commit after a library change.

A read-only sample from PMS 1.43.5 returned 8,306 artists, 87,130 releases and
377,386 tracks. The same strict native parser accepted all three captured
500-item pages. At those counts, an unchanged two-pass census needs **1,894
listing requests**, plus library/capability verification; this is calculated from
the observed totals, not a claim that a full live census was run. Sample page
bodies were 116–238 kB. No per-track detail sweep is needed for the initial pass.

Large synthetic storage and foreground measurements are recorded in
[issue-validation.md](issue-validation.md). These are repeatable native SQLite
checks, distinct from live audible-playback or end-to-end account mutation proof.
Shared associations and consumer integration remain tracked by #28–#30.

Sources: [Plex API versioning and response customization](https://developer.plex.tv/pms/#section/API-Info),
[Library API](https://developer.plex.tv/pms/#tag/Library).
