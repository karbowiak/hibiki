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

AutoEq #34 now includes on-demand catalogue search, exact measurement variants,
pinned downloads, custom file/text import, retained originals/attribution/local
edits, offline correction storage and stable output bindings. The correction
picker supports preview/cancel, apply, save/recall, bypass and removal separately
from tone EQ. Duplicate names do not share bindings; unresolved system routes
require manual recall. See [device correction](device-correction.md).

Native checks cover arbitrary peak/shelf frequency/gain/Q, original preamp,
combined headroom, manual gain safety, disabled tone/filters, channel state,
Nyquist rejection, PCM response at multiple rates, smooth scene changes,
superseding updates, and rejecting a retired output's queued configuration without
changing track/state/position. Large filter banks use a separate bounded lane;
ordinary playback commands remain small. The complete native suite passes
**878 tests**, with 13 ignored and 73 remote integration tests excluded.

The complete frontend suite passes **1,262 tests**; the subsequent focused
EQ/parser/device/bridge suite passes **52 tests**. Both TypeScript projects pass.
Chromium/WebKit exercise exact variants, preview/cancel, invalid imports,
save/bypass, A → B → A, offline restart, pasted custom filters and file import.
Desktop/light/dark and narrow editor captures have no horizontal overflow.
A separate read-only public check parsed **8,850** live catalogue entries and
downloaded the HD 650 parametric file from pinned revision
`7ae0f56d53074872b028649617a22bbb4232feb7`. Corrupt caches, redirects and oversized
profile responses are rejected.

An explicit macOS check opened the real default output using silent PCM at a
48 kHz mixer rate. It applied correction, forced stream recovery, rejected the
retired stream's configuration and applied the replacement's settings while
retaining playback identity/state. The observed run processed 36 callbacks with
zero buffer starvations. The retained renderer is allocated once on the output
owner and handed between streams by pointer, preventing large filter banks from
overflowing the device-opening stack. A normal unit check bounds the handoff size.
These checks do not establish a listening result: actual audible transitions and
device switching remain to be checked before #34 closes.

Shared-resolver fixtures cover typed IDs versus generic MBIDs, non-Latin labels,
collaboration credits, live/version and explicit/duration fences, homonyms,
release editions and track lists, multiple Plex copies, durable proof reload,
partial misses, late matches, row/parent changes, removals, account/scope isolation,
bounded fallback outcomes and atomic change cursors. Batch fixtures verify
coalescing, native payload bounds, source ownership, fallback failures and
retirement. These are identity-only checks; no remote ratings or playlist edits
were made. Consumer behavior remains separately tracked in #30.

The #28 refresh foundation covers coalescing and overflow, late notification
responses, missing details without deletion, rematches/reparenting/version edits,
advertised-filter validation, day-boundary overlap, durable partial windows,
changing totals/duplicate pages, absent or backwards server clocks, failed writes,
owner retirement and unchanged restart reuse. Chromium/WebKit check separate
coverage/freshness status and lifecycle controls. Capability discovery can fall
back to complete listing reconciliation; a live server's undocumented filtering
behavior is not assumed. Targeted invalidation and bounded unresolved retries now
connect the shared resolver to music consumers, completing the freshness work in
#28. Real-world audible playback/foreground measurement remains tracked in #30.

Consumer checks cover a later native match resuming a deliberate rating exactly
once, owner retirement during that retry, unchanged binary likes, unknown writes,
Plex library disappearance versus a true playlist removal, repeated occurrences,
typed-ID-only rematches, original metadata/provenance retention, fresh candidate
preflight, and view-cache invalidation. Mounted artist/album checks confirm that
unrelated changes do not refetch a page, duplicate census observations do not
cancel its in-flight read, and removals invalidate even older metadata while
preserving open edits. A slow live fallback cannot delay other verified results
or subsequent local lookup batches.

Chromium and WebKit exercise eight repeated artist navigations plus shared links,
mixed queue counterpart lookup, playlist candidates, target removal and return.
Those warm paths make **zero Plex searches** in the isolated provider fixture.
The playlist comparison measures **25 broad searches before / zero after** for
25 retrievals; the new path retains 25 fresh metadata reads for preflight rather
than treating a native identity row as a complete provider track. Warm renderer
link latency was **12.8/29.6 ms p50/p95 in Chromium** and **9.0/59.0 ms in WebKit**.
These include renderer batching with fixture IPC, not real network/SQLite timing.
Native SQLite measurements are reported separately below. No live remote account
mutations or audible-playback claim are inferred from the browser checks.

The shared resolver's 400,000-track fixture measured **2.387 ms p50 / 2.660 ms
p95** for a batch of 16 identities, an **11,391-byte** maximum response and
**30.5 MiB measured process peak RSS**. All repeated batches used durable native
proofs and made zero network requests. The updated index with relationship
revisions and lookup indexes completed in **170.54 s** and used **435,146,752
bytes (415.0 MiB)**. During it, **12,487** concurrent WAL reads measured **0.035 /
0.075 ms**; the final native ownership guard measured **21.518 ms p95**. This is a
native database/core measurement, not an end-to-end UI or audible-playback claim.

The earlier compact-index foundation for #27 added native paging/ownership, storage,
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

- Full frontend suite: **1,251 passed**, zero failures; subsequent focused
  matching/retention/rating checks pass for the final refinements.
- Focused acceptance suite including those cases: **102 passed**, zero failures.
- Full native suite: **858 passed**, 12 ignored; 73 remote integration tests
  excluded. Focused index checks: **36 passed**, one explicit benchmark ignored.
- Native discovery parser rerun: **9 passed**, zero failures.
- Application and script TypeScript projects pass `--noEmit`.
- Chromium and WebKit issue interaction checks pass.

Native tests use a separate Cargo target directory so the user's dev watcher
does not wait on validation's build lock. Live account checks remain useful for
provider-specific availability and undocumented YTM API changes.
