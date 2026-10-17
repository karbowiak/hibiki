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

Settings → Cache → Plex Matching Index shows per-kind partial/complete progress
and completion dates, with Pause, Resume, Rebuild and Clear controls. Clear
leaves indexing paused until Resume. Offline scopes can inspect/manage their
retained local index.

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
Freshness maintenance and shared associations/consumer integration are tracked
separately by #28–#30.

Sources: [Plex API versioning and response customization](https://developer.plex.tv/pms/#section/API-Info),
[Library API](https://developer.plex.tv/pms/#tag/Library).
