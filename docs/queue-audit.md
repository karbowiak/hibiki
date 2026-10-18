# Queue audit — 19 October 2026

This audit covers the embedded Butler runtime, every registered task, captured
advisory work, and the renderer hooks that submit it. It focuses on cache reuse,
admission, resource contention, retries, ownership and restart behavior.

## Findings fixed

- Plex browsing ignored persisted freshness after a new provider instance and
  could immediately refresh fresh data. SWR now uses the saved timestamp as well
  as in-memory checks, and paces failed stale refreshes for 30 seconds. Cold reads
  and mutation invalidation can still retry immediately.
- Collection warming admitted jobs before checking their SQLite snapshot. Both
  producer and worker now check freshness; a fresh complete collection creates
  no hydration job. Smart Plex playlist contents remain on demand.
- Identical simultaneous renderer calls repeated native admission/IPC. They now
  share their in-flight promise using the owner, domain, method and full arguments.
  Completed results are never memoized as mutation acknowledgements.
- Captured advisory jobs lacked a general admission guard. Keyed work now holds
  a lease until completion/cancellation; even an unpolled rejected future releases
  its key. Browsing access touches, AutoEQ refreshes, default-playlist bootstrap,
  saved-audio maintenance, waveforms and speculative preparation use this guard.
- Cache hits scheduled LRU writes on every read. Access bookkeeping now coalesces
  and updates snapshots at one-minute intervals without changing their IPC shape.
- AutoEQ searches submitted stale refresh jobs during the catalogue's retry
  cooldown. Admission now respects the existing cooldown and shares one refresh.
- YTM playlist expiry could restart an active long traversal. Active/pending work
  is retained, the refresh interval starts at completion, and continuation cycle
  fingerprints survive claim handoffs. Fingerprints keep the maximum cursor
  history within the bridge payload limit.
- Recurring timers created jobs for idle domains. Before admission, the scheduler
  checks the listening outbox, requested downloads, matching-index due state and
  YTM session deadline. Handlers still recheck after claiming.
- Listening-history turns could deserialize the entire retained outbox, including
  old accounts and delayed retries. SQL now filters account and retry time before
  taking at most 32 reports. Other records remain retained.
- Rating producers repeatedly scheduled matching from a timer and resumed
  already acknowledged or disabled targets. Matching now uses startup/relevant
  index notifications; retry admission checks current targets. Bounded retries
  rotate through pending entries, and identical errors avoid redundant saves.
- Cached audio/waveforms still generated speculative jobs. Producers now check
  the shared media/analysis cache first. Keys include cancellation revisions so
  a retired request cannot suppress preparation for a newer selection.
- Server metadata analysis could occupy the sole waveform generation lane for a
  large saved collection. It now uses the metadata lane; local waveform decoding
  retains its separate serial lane. Matching-index and analysis startup admission
  also use durable deduplication.
- Download resume and download-status/local-availability reads could hold Plex's
  admission mutex while waiting for SQLite's writer. Reads now use the WAL reader
  pools, with a reserved reader for a local playback lookup and ownership checks
  before/after. Resume/removal writes acquire storage off-thread before checking
  ownership. Download-folder startup settings use the reader pool too.
- Download workers could immediately resubmit themselves after a storage error
  and ignore failure to save final status. Final state is now awaited, and failed
  workers leave retained intentions for resume/reconnect instead of a hot loop.
- History cleanup used admission age to reclaim results. A long-running job's
  newly completed result could disappear too soon. Retention now starts when a
  terminal job is observed, conservatively restarting that clock after restart.

## Coverage and retained behavior

| Task family | Trigger and reuse | Bounds / correctness |
| --- | --- | --- |
| Mixed playlists | Retained merge/edit intent; pending/settled polling; relevant index changes | Artist/release grouping shares catalogue pages; bounded matching and write passes; local revisions and remote receipts stay authoritative |
| Linked ListenBrainz playlists | Explicit links and configured automatic sync | Ownership/holds checked; bounded write budget; interrupted writes require fresh verification |
| Favorites | Hourly/manual import; prompt export of new likes/resolved identities | Separate bounded matching backlog; pending receipts settle first; acknowledgements do not trigger another full import |
| Exact ratings | New intent, actionable pending retry, relevant index event | Current enabled accounts only; 20-entry rotating turns; per-song intent IDs protect newer ratings |
| Plex collections | Startup/expiry/invalidation or explicit view | Persisted freshness before admission; four-page turns resume the same generation; smart playlists stay on demand |
| YTM playlists | Saved-library roster and 15-minute warmup | One account-scoped feeder; four-page turns; native SWR; cycle/account/roster checks; no audio or radio traversal |
| Plex metadata SWR | Stale browsing snapshot | Immediate saved result; shared refresh; failed-refresh pacing; ownership and mutation publication barriers |
| YTM catalogue | Native browse/search cache | Fresh hits skip the queue; stale hits share a refresh; account/version/continuation keys; HTTP cache policy and application fallback TTLs |
| Fresh YTM playlist reads | Sync/source-read request | Coalesced identical active requests; fresh write preflight/readback deliberately bypasses browsing SWR |
| YTM session | Session deadline/explicit interaction | Idle deadline checks before admission; interactive sign-in stays direct |
| Plex matching index | Due scan/delta/hint/health work | Durable cursor and retry state; foreground pressure/pause gates; approximately 30-second worker turns |
| Requested offline collections | Explicit download request and hourly refresh | Only requested collections; manifest reconciliation handles additions/removals; no whole-library pre-cache |
| Download transfers | Retained download intentions | Existing scoped worker and per-file cancellation; shared cached files; durable final state; no playback lock while waiting for storage |
| Upcoming audio | Small upcoming playback window | Shared file, supplied/computed gain and waveform caches; fill locks; cancellation/foreground preemption; one speculative lane |
| Waveforms/local analysis | Missing analysis of cached media | Cache revision proof, shared fill lock, serial CPU limit and timeout; complete cached work skips admission |
| Saved Plex audio analysis | Download/resume/backfill | Cached binding/levels checks and ID paging; metadata lane, separate from local waveform generation |
| Listening outbox | Retained listens and recurring due check | Current binding, at most 32 due reports, request timeout/backoff, single outbox owner |
| Default playlists | Once per owner connection | Shared startup admission; existing fresh provider verification and write receipts |
| Download folder maintenance | Startup or dirty export state | Scoped relocation gate; coalesced export lease and dirty tail; filesystem/SQLite work stays off async executor threads |
| Browsing LRU / AutoEQ | Cache use / stale headphone catalogue | Keyed admission, access interval / existing refresh cooldown |

All native lanes remain bounded under eight total claims. Reconciliation domains
have independent writer lanes; child catalogue and playlist reads retain native
capacity. Jobs and schedules use the separate `jobs.sqlite3`; domain state remains
in the application database. Heavy SQLite operations use blocking workers and WAL
readers. Progress transfers/checkpoints are sampled; write receipts are not.

YTM's shared adaptive request pacing still covers native API calls, session
refresh and extractor admission. Extractor subrequests also use `--sleep-requests`.
Queued work cannot bypass that pacing. No undocumented fixed provider quota is
assumed by this audit.

Fresh remote reads remain necessary around writes. A cached browsing snapshot
cannot prove a provider accepted a change, detect a conflicting edit, or authorize
repeating an uncertain mutation. YTM playlist writes continue outside the
at-least-once job queue, on the embedded runtime with domain-owned receipts.

## Verification boundary

Focused Bun regressions cover cache admission/SWR, continuation traversal,
account retirement, renderer/worker ownership, in-flight deduplication, rating
retry fairness, playlist matching and sync journals: 200 cases across 15 files
passed, including the targeted rerun after correcting a retained-rating fixture.
TypeScript is checked with
`bunx tsc --noEmit`. The actual outbox SQL is also exercised against an in-memory
SQLite database, including old accounts, delayed retries and malformed JSON.

Native regression cases were added for advisory lease cancellation, terminal
result retention, outbox selection, cache IPC shape and audio readiness. Native
files receive a Rust parser check through `rustfmt --emit stdout`; no Cargo
compilation/tests, app build or dev server are run. These checks therefore do
not establish native type checking or live provider behavior. Existing live
development remains the next native/runtime validation boundary.
