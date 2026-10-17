# Issue validation

These checks cover main before the next release. They are source/fixture and
browser validations, not a claim that remote account mutations were exercised
against a user's playlists. No release tag is created by this work.

## Navigation, browsing and presentation (#12–#15, #22)

- Artist-credit tests cover the reported `NEEDY GIRL OVERDOSE, Aiobahn +81`
  credit, semicolons, standalone collaboration markers, structured identities,
  canonical Plex artist names and punctuation that belongs to a name.
- Music-link tests cover Plex-first destinations, YTM-only artists, edition and
  performer ambiguity, restored song metadata and retirement on account changes.
- `check-appearance.ts --issue-regressions-only` exercises the Server Library
  menu, playbar pointer/keyboard album navigation and sharp artist hero in
  Chromium and WebKit at supported window widths. Shared Plex/YTM hero rendering
  retains the lower overlay and uses an unfiltered sharp artwork layer.
- Native YTM parser tests keep popularity separate from release metadata and
  retain album IDs and individual artist IDs. The shared artist-track table uses
  the release field for both providers and an honest empty release fallback.

## Ratings, lyrics and queue radio (#23–#25)

- Isolated rating fixtures cover exact local intent across restart, binary likes,
  1/2/3/5 stars and threshold precision, late matching, newer intent, failures and
  account changes. Imported likes cannot invent a deliberate Plex rating.
- Player metadata lifecycle tests cover YTM timed/plain lyrics without Plex,
  verified Plex and configured Genius fallbacks, manual source selection and
  stale request retirement. Both lyrics surfaces consume the same store.
- Radio tests cover paused and active playback, deliberate duplicate occurrences,
  deterministic seeds, long queues, Plex/YTM/mixed additions, pending cancellation
  and queue replacement. Browser checks exercise the accessible queue controls.

## Mixed playlist persistence, conversion and sync (#17–#21)

- Mixed-playlist tests retain ordered duplicate occurrences, provider-scoped
  identities, revisions and separate library/occurrence dates across hydration.
- Matching tests cover complete resumable batches, shared duplicate lookups,
  conservative recording/version/duration evidence and retired requests.
- Both Plex-origin and YTM-origin conversion are covered, including unmatched
  songs and reuse after restart. External edits from either provider propagate
  once without echoing. Hidden unmatched occurrences survive reconciliation.
- Every mutation has a retained receipt and exact readback. Interrupted writes
  settle without repeating a mutation; uncertain creation and account changes
  after creation cannot blindly create a second playlist.
- Queue pointer/keyboard drop checks cover admission, eligibility, reorder
  coexistence, identity fencing and retaining the original playback queue.
- The background hook resumes bounded round-robin matching/sync while the
  playlist's original accounts are connected; conflicts remain reviewable.

## Liked-song completeness (#31–#32)

- Audio/video pagination and cache fixtures cover empty/duplicate-only pages,
  continuation cycles, coalescing, mode-specific updates and account retirement.
- Both-provider results retain stable source identities rather than suppressing
  identical artist/title rows. The music-video scope changes counts and playback
  membership without changing remote likes.
- Chromium and WebKit check both provider filters, video inclusion and the exact
  resulting playback identities.

## Local playlist creation and deferred service sync (#16, #33)

- Empty playlists retain their name, description, raster artwork and external
  sync preferences in IndexedDB. Creation and local editing work without Plex or
  YTM and make no service calls. Double submission reuses one local identity.
- First-song tests cover Plex and YTM independently, adding the other service,
  offline admission, duplicate occurrences, restart reuse, account changes and
  becoming empty again without deleting or recreating counterparts.
- Details and Plex artwork saves retain separate receipts before mutation.
  Uncertain outcomes require readback or explicit review; known destination IDs
  recover the existing playlist. Unknown creations cannot retry automatically.
- ListenBrainz tests cover verified recording subsets, delayed matches, incoming
  additions/reordering, conflicts, restart, uncertain creates/edits and explicitly
  reviewed absent creations. Existing recording checks and direction controls are
  reused. Descriptions use the supported edit endpoint while preserving privacy
  and collaborators. Artwork remains local for YTM and ListenBrainz. Last.fm's
  deprecated playlist API is shown as unavailable.
- Chromium and WebKit exercise creation, artwork replacement/removal, cancel,
  local storage reload, stable sidebar links, empty view and offline editing.
- Remote writes are fixture-tested with exact before/after snapshots. These
  checks did not create or edit playlists in the user's live accounts.

## Recorded checks

The compact-index foundation for #27 adds native paging/ownership, storage,
restart and cache-retention checks and a Chromium/WebKit settings check. The
400,000-track native SQLite fixture completed a two-pass census in **121.66 s**,
using **380,977,152 bytes (363.3 MiB)**, without loading the library into renderer
memory. During indexing, **8,904** separate WAL reads measured **0.036 ms p50 /
0.074 ms p95**; warm exact reads measured **0.012 / 0.014 ms**. SQL page preparation
measured **80.8 / 123.8 ms**, and the final commit guard measured **20.3 ms p95**.
Only that final commit guard holds native owner publication; SQL preparation and
writer waits do not hold connection/audio admission. The benchmark process's
observed RSS was approximately **26 MiB**; the outer Cargo timing includes the
compiler and is not an index-process peak-memory measurement.

These are synthetic database/foreground measurements; a complete live census and
audible playback under indexing were not measured. See
[the index contract](plex-matching-index.md) for the read-only live page sample and
the distinction between matching metadata and full browse/offline data.

- Full frontend suite: **1,220 passed**, zero failures, including the draft and
  mixed-playlist regression cases above.
- Focused acceptance suite including those cases: **102 passed**, zero failures.
- Full native suite: **829 passed**, 12 ignored; remote integration tests excluded
  (followed by the focused index/connection checks for the latest additions).
- Native discovery parser rerun: **9 passed**, zero failures.
- Application and script TypeScript projects pass `--noEmit`.
- Chromium and WebKit issue interaction checks pass.

Native tests use a separate Cargo target directory so the user's dev watcher
does not wait on validation's build lock. Live account checks remain useful for
provider-specific availability and undocumented YTM API changes.
