# Hibiki visual polish

## Active goal

Make artwork and its colors carry through the entire application while preserving readable controls, appearance preferences, playback and seeking.

- [x] Extend the active image across the full application, behind navigation and the playbar.
- [x] Keep artist and album heroes sharp, with an aligned blurred continuation beneath the content.
- [x] Make the top bar, sidebar and playbar semi-transparent, with adjustable opacity and readable light/custom themes.
- [x] Pick stable random library artwork on non-artist/album pages, respecting the current account and artwork source preferences.
- [x] Derive primary and secondary action colors site-wide from the actual background image.
- [x] Adapt the playbar waveform to Heya's symmetric vertical bars, retaining seeking, hover feedback and the other visualization modes.
- [x] Verify native rendering and isolated Chromium/WebKit behavior at different widths, fonts, card sizes and palettes; commit locally.

Use existing cached library artwork without large background library scans. Missing artwork, disabled background settings and reduced-transparency preferences must retain a usable interface. Do not push or release this batch.

The bars share one semantic tint. The toolbar has balanced padding, controls have subtle hover states, and the previous image stays visible underneath the incoming fade. Artwork colors are scoped to the app; disabling them restores the saved accent. Hero metadata and small accent text retain readable contrast.

Validation: 606 frontend tests; both TypeScript projects and production build; Chromium and WebKit appearance, artwork transitions, palette contrast, seek controls, account retirement, library/player geometry, search discovery, notifications and renderer/CSP checks. Native screenshots reviewed sharp album/artist heroes, glass surfaces, toolbar spacing and live waveform rendering. No audio-engine changes in this visual batch.

## Follow-up polish

- [x] Give playback controls, popovers and waveform an independent now-playing artwork palette, with saved-accent fallback.
- [x] Keep Create Playlist on the saved accent as page backgrounds change.
- [x] Make media context menus and Cmd/Ctrl+K consistent across library, collection and detail routes; support keyboard focus and account retirement.
- [x] Give podcast and internet-radio cards the shared square artwork layout, with independent open/play and favorite actions and shared context menus.
- [x] Replace playlist color boxes with sharp full-window artwork heroes, a blurred continuation, labeled actions and a songs/runtime ledger.
- [x] Rotate eligible cached backgrounds every 45 seconds, with pause and next-image controls; pause automatic rotation in hidden windows and exclude artist/album pages.
- [x] Replace persistent artwork-source buttons with accessible hover/focus edit pens.
- [x] Keep wide song tables within their own scroll region and keep keyboard scrolling separate from playback shortcuts.
- [x] Hide broken-image indicators during bounded retries and use the native image cache for radio artwork.

Validation: 611 frontend tests; both TypeScript projects and production build; Chromium and WebKit appearance and real-card context menus across dark/light/custom palettes, fonts, sizes and narrow windows. Shell, library/player geometry, search discovery, notifications and renderer/CSP checks passed in both browsers. Native review covered the small ❤️ Tracks playlist hero, independent playback colors, library shortcuts, shared context menus and podcast/radio layouts. No playback-engine or Rust changes.

The ignored local `TODO.md` records metadata-provider expansion, optional SoulSync, Plex metadata editing and playlist synchronization. It also records a native radio-directory lookup failure seen during final review: direct public HTTP requests succeeded, so the native client error still needs diagnosis. This batch is committed locally without pushing or releasing.

Radio follow-up: the native dev app now loads all three featured shelves, and an explicitly ignored, read-only Rust probe passed their concurrent requests using the application's client. The earlier failure has not been reproduced. Directory error panels now explain known IPC, TLS, timeout, rate-limit and parse failures without echoing upstream content or credential-bearing URLs. All 17 error/ownership/retry checks passed. Transport changes remain deferred pending evidence from a recurrence.

## Loading and interaction finishing pass

- [x] Match artist, album, playlist and podcast skeletons to the actual hero/cover, overview and content layouts.
- [x] Share theme-aware square tile, shelf and song-row skeletons across browsing pages, with subtle shimmer and reduced-motion support.
- [x] Add contextual actions to generated homepage mixes, Stations and Search discovery without inventing library playlist identities.
- [x] Give Jump back in the shared square artwork cards, including media menus and drag sources.
- [x] Fix initial-movement and release-coordinate drag hit testing; cancel retired/cancelled drags and show drop success only after the playlist request succeeds.

Validation: 620 frontend tests; both TypeScript projects and production build. Chromium and WebKit checks held real component responses to review dark/light skeletons and loading-to-content hero geometry, verified reduced motion and no fake usable controls, and dragged an actual media card onto the sidebar playlist using pointer capture and hit testing. Search discovery checks passed in both browsers. Native review confirmed homepage mix, Jump back in and Stations menus; Home was restored without invoking playback or playlist mutations. The ignored local roadmap now includes the AppImage AppStream/screenshot and update-information follow-ups.

- [x] Keep toolbar dropdowns above all page content with separate sibling stacking contexts, and constrain search suggestions to the area above the playbar. Verified the original overlap and corrected dropdown in the native app; Chromium/WebKit hit tests passed on Home, Library, Album and Playlist at wide/narrow sizes, light/dark themes and with background artwork enabled/disabled. Ten focused search/keyboard tests and the production build passed.

## Metadata editor and source expansion

The artist/album/playlist editor uses a sharp artwork header, a compact left
navigation and responsive identity/description panels. Artist and album artwork
has indented Poster and Background entries with independent choices and small
candidate tiles. The dialog keeps its own artwork palette, including readable
selection text, and isolates keyboard shortcuts and focus from the underlying
page. Plex changes have a dedicated Current/After review before Save; conflicts
and unconfirmed writes require reloading current values.

The shared metadata interface now exposes source capabilities, identity evidence
and field provenance. Existing Plex, Deezer, Apple, Last.fm and MusicBrainz data
share it with Wikidata, Cover Art Archive and optional SoulSync, Fanart.tv and
HeyaMetadata connections. Source preferences belong to the current library and
item; saved image choices retain only source/candidate IDs. The metadata guide
records supported fields and limitations.

ListenBrainz playlist integration offers explicitly reviewed private copies and
opt-in links in either direction, with duplicate/order preservation, conflict
review and durable per-occurrence recovery. Last.fm's retired playlist API is not
presented as an available sync source.

## Metadata, saved-library and discovery roadmap completion

- [x] Add reviewed canonical MusicBrainz/Heya identities with aliases, exact-ID
  evidence and scoped local application. Heya discovery/resolution is an explicit,
  capability-gated action with bounded status polling and ambiguity review.
- [x] Extend SoulSync to conservatively matched album/track data and project richer
  Heya fields through the shared metadata interface.
- [x] Add independent Plex poster/background inventories, selection, validated
  raster uploads and proof after a single attempted save.
- [x] Add reviewed sort title, album studio, genres/styles/moods/labels and
  per-field/artwork locks, using the actual current Plex section identity.
- [x] Add explicit linked ListenBrainz sync, one-sided propagation, conflict
  review, durable write admission, unknown-outcome recovery and credential rebind.
- [x] Add bounded account/server/library SQLite snapshots and read-only saved
  browsing. Refetch current owned track data before online playback of cached DTOs.
- [x] Preserve joined duplicate identities and expose non-destructive album/media
  version comparisons without altering automatic playback selection.
- [x] Add optional local semantic discovery with pinned, hash-verified assets,
  bounded worker inference and metadata-revision-scoped SQLite vectors.
- [x] Prepare safe Home/artist/album/search release previews from actual components
  with fictional data and local artwork; retain existing published screenshots.
- [x] Review direct Discogs/Spotify/TIDAL/TheAudioDB contracts and limitations in
  the metadata guide; retain unsupported adapters as future work.

Native review found and fixed two real Plex contract errors. The section-specific
route returns a browsing interstitial; section validation now selects the exact
item from the global library roster. Current JSON artwork inventories use
`Metadata` rather than the XML/legacy `Photo` key. Local/embedded previews use a
file endpoint bound to the exact native inventory resource, without broadening
the general authenticated image allowlist. The native poster preview, fields and
locks, canonical Heya search and exact review, version comparison, and linked-sync
setup were inspected without applying library/account changes. Global search
shortcut and dropdown layering passed on Your Library. Optional local-model
onboarding remains disabled until explicit installation.

Validation: 767 frontend tests; 568 safe native tests (5 ignored and 73 live
integrations excluded); both TypeScript projects and production build; 12
Chromium/WebKit dark/light editor views; real semantic inference in both browsers
and the isolated packaged macOS Tauri window (five normalized 384-dimensional
vectors, all five paraphrase rankings, bounded long input, 1,887 ms, no network or
personal data). The current Linux ARM source builds and validates the actual
AppImage, desktop entry and AppStream metadata. This is compile/bundle evidence;
Windows/Linux semantic webview execution and signed amd64 publication remain
future platform/release checks. Screenshot previews are renderer fixtures with
inert audio and an offline font fallback, not connected-app playback evidence.

The ignored local TODO retains future provider adapters, release publication and
the original un-reproduced radio failure. No push or release is part of this batch.

## 0.6.0 follow-up and release candidate

The user selected 0.6.0 for the interface overhaul and deferred AI integration
for a later design. Local semantic search, model installation, inference workers
and the Transformers dependency have been removed. Existing development
databases keep their already-applied V3 migration; no active model commands,
workers or model assets ship with this release.

Optional premium TheAudioDB V2 metadata and separate poster/background artwork
now use the shared source interface. Private native key storage, exact returned
identity checks, rate limits and stale-account/configuration fences are covered.
The source remains hidden until configured; no premium key was available for a
live service lookup.

Controlled live QA exposed and fixed a real Plex contract defect: playlist
creation and multi-item append need one library URI with comma-separated IDs,
rather than repeating the entire URI. Both operations now make a single request.
Occurrence reordering supports valid forward/backward moves and selects the
predecessor after source removal. Transport tests simulate actual insert-after
semantics rather than mirroring the requested destination index.

The tested Plex server also deduplicates repeated IDs during create and append.
Copies containing repeated Plex IDs are blocked before admission; linked updates
requiring a nonmatching repeated sequence pause before sending changes. Existing
duplicates remain intact, and ListenBrainz exports retain their occurrences.

Two freshly created Plex QA playlists and one fresh private ListenBrainz QA
playlist were the only remotely modified objects. Playlist title/summary edits
and title restoration passed. The distinct-track workflow passed ordered sync
in both directions, both-sided conflict detection without automatic writes, and
read-only recovery after deliberately suppressing a verified frontend receipt.
That last case simulates acknowledgement loss; it is not a claim of a real
network outage. Five proof stages and seven workflow occurrence requests were
retained, alongside the earlier rejected duplicate-append attempt. Existing
music metadata, playlists and playback were not used as mutation targets.
Reviewed cleanup deleted only those three QA playlists once each; every fresh
post-delete read returned 404. Private manifests and proof receipts are retained.

Validation: 775 frontend tests and 576 safe native unit tests passed, with live
integrations excluded from the ordinary run. Both TypeScript projects and the
production build passed. Chromium/WebKit renderer and editor checks passed;
Home/artist/album/search previews use actual components with fictional data.
The refreshed non-AI ARM AppImage validates its AppDir, desktop entry and
AppStream metadata. It predates one later status-message wording adjustment;
exact-commit CI and signed amd64 release checks supply final packaging evidence.

The original Radio Browser failure remains unreproduced; the current native
shelves and bounded concurrent read-only probes pass. Direct Spotify/Discogs/
TIDAL adapters, premium TheAudioDB live verification, a duplicate-preserving Plex
copy path, and the user's later AI design remain future work.

### Playlist sync redesign and matching follow-up (release remains on hold)

The global Playlists Sync entry lists owned, generated and collaborative
ListenBrainz playlists. Each local playlist has its own Sync control and overflow
configuration. Ordinary links default to manual Plex → ListenBrainz; import and
two-way modes require explicit configuration. Weekly Exploration and Weekly Jams
have one stable channel each, with dated editions retained behind the channel.

Create Sync admits one empty destination immediately, retaining the complete
source before creation. Background matching processes the selected songs in
bounded batches and resumes admitted unfinished work on startup. Missing songs
and unsupported repeats remain in per-playlist Review. Unknown creation outcomes
and returned IDs have durable recovery; they cannot silently request another
playlist. Weekly completion requires verified order and description, and a new
edition runs through the same matcher.

Live user testing found two defects: failed combined searches stopped a batch
before adding its reliable matches, and cached empty pages did not refresh after
verified writes. These are fixed. Title searches also recover failed/unrelated
combined results. Matching handles explicit collaborator credits, Latin accents,
punctuation and equivalent library copies, while retaining different recording,
version and duration safeguards. Old automatic metadata choices are revalidated
before reuse; reviewed choices and in-flight jobs stay protected. Search query
parameters are now encoded, preserving ampersands, plus signs and hash marks as
search text. Match labels preserve their actual evidence rather than presenting
metadata choices as verified recording IDs.

Validation: 850 frontend tests and 588 safe native unit tests passed; 8 native
live/manual tests were ignored and 73 integration tests excluded. Both TypeScript
projects and the production build passed. A fresh isolated empty-playlist create
was verified with zero ordered items; its separately reviewed single deletion
returned an exact fresh 404. This evidence is separate from the user's weekly
imports. No release tag or publication has been requested for this revision.

The final weekly/archive and matching changes also passed 38 focused frontend
checks and a fresh production build. Unresolved earlier editions are retained;
only settled history is trimmed. The archive stops before discarding unresolved
records if its capacity is reached. Manual pauses and unknown writes remain
separate from automatic unmatched-song review. Completed partial imports can
explicitly find more matches without creating another playlist.

Native dev-app follow-through on the two weekly imports the user created showed
31 of 50 Weekly Jams songs and 26 of 50 Weekly Exploration songs added, with the
remaining occurrences available in Review. These were resumed only through
their existing admitted syncs. No additional copies or unrelated user playlist
mutations were requested. The isolated QA playlist was separately deleted.

### Packaging and installer verification follow-through

A fresh Linux ARM debug AppImage built from committed `5f437f6`, with its
frontend rebuilt inside the Linux staging directory, passed AppDir, desktop and
AppStream validation. Its private proof records the complete source snapshot
and frontend asset hashes. This does not claim Linux GUI/playback or signed
amd64 release verification.

The release audit found that macOS DMGs were checked only for presence and size.
For 0.6.0 onward, macOS packaging now runs `hdiutil verify`, signs each DMG with
the existing updater key and release version, and uploads its signature only to
the matching draft after proving the uploaded installer matches local bytes.
The publication gate streams and verifies all nine installers. Every signature
must authenticate the release version, and DMGs also authenticate their exact
filename. The application enables Tauri's signed-version update requirement;
historical release verification keeps the old seven-artifact contract.

A real synthetic UDZO image passed native `hdiutil verify` and the installed
Tauri CLI signer using a fresh ephemeral key. The publication verifier accepted
that actual signature and rejected a different version, different filename and
altered image bytes. The ephemeral private key was removed; no production key
or remote release asset was used. Thirty-two focused release tests and six
Python AppImage checks passed; native compilation accepted the updater setting.
Read-only post-publication verification is prepared for all nine artifacts but
has not run: the user continues to hold 0.6.0 and current local commits have not
been pushed for exact-commit CI or release-matrix builds.

### Playlist membership, dynamic sync and metadata configuration

Playlist backgrounds now use only artist/album artwork from loaded members.
The rendered shell also rejects unrelated ready/retiring frames and palette
ownership during loading, empty/error states, navigation and member removal;
eligible rotation within the same playlist retains its crossfade. No full
playlist fetch or extra artwork-provider lookup was added.

Smart/dynamic Plex playlists expose Configure sync and export-only snapshots.
Import/two-way operations remain blocked in UI, journal, fresh execution and
native preflight. Sync reads bypass saved-library fallback, while ordinary
browsing retains it. Current native item membership was 81 songs for the selected
liked playlist despite Plex roster metadata saying 97; item totals govern sync.
No live link or export was created in this verification.

Matching now has bounded artist/recording candidate discovery, with typed
section ownership, source-recording query keys and explicit truncated/unavailable
review limits. Three unresolved live samples produced no additional accepted
matches; synthetic crowded-title regressions prove the retrieval improvement
without claiming a measured live match-rate gain.

Metadata source rows now have configuration dialogs, status badges and keyboard
reordering. SoulSync joins the priority list without replacing saved ranking;
native keys stay absent from modal fields and an in-flight configuration save
prevents dialog dismissal. Existing listening/lyrics account settings remain
separate. The larger scoped SQLite catalogue/path-join design is documented in
src/metadata/README.md as research, not an implemented full-library sync.
SoulSync configuration now retires lookup ownership before dispatch too: a lost
save receipt requires reloading actual native status, and late metadata cannot
reappear under the previous connection. Eleven final focused metadata tests
and a fresh production build passed after this additional guard.

Validation: final full frontend run passed 882 tests; native run passed 595,
with eight ignored live tests and 73 integration tests filtered. Production
build and TypeScript passed. Native computer use verified the source dialog,
smart export-only setup and 90er Dakkedak's member artwork. The idle development
bundle was rebuilt/reopened at localhost:1420 and reconnected cleanly; playback
and settings were not used as write targets. Release remains held.

### Saved-library performance and stalled indexing follow-up

Foreground catalogue and visited-snapshot reads now use independent read-only
WAL connections, with reserved playback capacity and ownership rechecks. Core
artist/album content publishes before optional recommendations. Mutation
invalidations retain a read barrier; unrelated snapshot saves do not. Deep
playlist pages select occurrence positions before metadata joins, and Latest
Releases counts use the covering date index. Bounded development-only timing
logs separate database admission/SQL, Plex, IPC, cache, rendering and enrichment
without library identities, arguments, paths, tokens or SQL values.

Read-only profiling of the private library measured the final 200 rows of a
369,237-occurrence playlist at 72 ms versus 2,522 ms before the range fix;
Latest Releases counting improved from 183 ms to 13 ms. Actual dev-app core
loader samples measured artist median 87 ms and album median 28 ms. Navigation
and playback smoke checks succeeded, but the rare reported 30-second freeze
has not been reproduced and is not declared universally solved.

A subsequent stopped full-track detail batch reproduced a duplicate-genre
primary-key failure in an isolated database: 49 of 50 saves passed before the
fix, all 50 afterward. V10 replaces the derived-tag triggers, retaining raw
metadata and all progress without a library rewrite. A V9 upgrade regression
verifies failed-save recovery, case-distinct tags, all four tag resources,
preserved raw metadata/checkpoints and idempotence.

The local library has 14,062 distinct genres, exceeding the earlier 10,000-tag
response limit. Bounded local inventories now retain the complete set and
truthful coverage; genre/mood/style grids render 96 tiles per page while
searching every label. Fresh verified playlist membership totals replace stale
Plex roster counts in local and online responses, retaining duplicate
occurrences, zero counts, source documents and mutation fences.

Validation: 923 frontend tests and 682 native application tests passed, with
13 intentionally ignored live proofs and 73 integration tests filtered.
Production frontend/TypeScript and default-protocol native builds passed.
With the user's restart authorization, the exact dev app was quit, its process
absence checked, and the default-protocol executable replaced with a matching
SHA256 before native relaunch. V10 is applied to the actual database; the
full-track detail scan advanced past its failed cursor with no error, retaining
all four completed baselines and 55 playlist publications. Playback resumed
automatically and continued across tracks. The playlist grid showed the current
verified 82-song liked playlist and 369,244-song library playlist. The release
remains held; there has been no push, tag or publication.

An isolated Linux ARM diagnostic AppImage from exact prior commit 7894360
also passed source/frontend hash, AppDir, desktop and AppStream validation.
It is not evidence for the subsequent V10/query changes, native Linux GUI/audio
or signed amd64 release/update assets; those remain separate release gates.

The subsequent exact runtime commit 21b1fb3 also passed a fresh isolated Linux
ARM AppImage build, including AppDir/Desktop/AppStream checks. The same commit
built an isolated macOS ARM diagnostic app and DMG: version 0.6.0, fresh staged
frontend, verified source changes limited to four version substitutions, no
model assets and a valid hdiutil image. Both are debug diagnostics; no production
signing, packaged-app launch or Linux GUI/audio verification is implied. Later
release-note/documentation changes preserve that packaged runtime. The 0.6.0
notes now describe full-library indexing, downloads and offline audio playback.

The repaired full-track detail task subsequently completed at cursor 931163
without errors; waveform indexing and playlist refresh continue asynchronously.
The updated native app loaded all three Radio Browser shelves with 45 station
controls and no error while music continued. Controlled metadata saves, ordered
sync both ways, conflict pause and simulated acknowledgement-loss recovery are
confirmed by retained disposable-item receipts; all three cleanup reads were 404.
TheAudioDB remains implemented but unconfigured locally. AI was deferred by the
user, and the only available native desktop is macOS. Exact-candidate CI, actual
signed release-matrix/published-byte verification and catalogue follow-through
remain gated by the explicit release hold; no third-party messages were sent.
