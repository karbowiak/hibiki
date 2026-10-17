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

## Recorded checks

- Full frontend suite: **1,199 passed**, zero failures (before the four additional
  mixed-playlist regression cases above).
- Focused acceptance suite including those cases: **102 passed**, zero failures.
- Full native suite: **817 passed**, 11 ignored; remote integration tests excluded.
- Native discovery parser rerun: **9 passed**, zero failures.
- Application and script TypeScript projects pass `--noEmit`.
- Chromium and WebKit issue interaction checks pass.

Native tests use a separate Cargo target directory so the user's dev watcher
does not wait on validation's build lock. Live account checks remain useful for
provider-specific availability and undocumented YTM API changes.
