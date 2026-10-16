# Hibiki visual polish

## Library switching and interface consistency

- [x] Add a grouped music-library picker to the toolbar, with equal-height
  search, selector and action controls, keyboard navigation, retry states and
  explicit switching through the existing connection lifecycle.
- [x] Discover shared servers with their own resource credentials; verify server
  identity before authentication and try public routes alongside private ones.
  Retain the account discovery credential privately when switching servers.
- [x] Tighten sidebar spacing, playlist selection/hover treatment and navigation
  hierarchy; keep Create Playlist on the saved accent.
- [x] Add a top-bar light/dark toggle using the existing Appearance preference.
- [x] Share a tinted translucent material across dropdowns, context menus,
  notifications, player popovers and dialogs, including opaque fallbacks for
  reduced-transparency preferences and unsupported browsers.
- [x] Give docked Queue/Lyrics the navigation material and align their header to
  the measured toolbar, including text scaling and wrapping. Use rounded buttons
  for Queue/Lyrics; improve queue spacing, badges, duration alignment, focus and
  context menus. Closing a docked queue retains the docking preference.
- [x] Remove decorative settings animation and redundant labels; simplify
  provider rows, improve small-text contrast and respect reduced motion.
- [x] Fix narrow song-table overflow and column-picker focus/Escape behavior.
- [x] Record the user-confirmed product brief in `PRODUCT.md`, choose code-first,
  and install Impeccable's project skill and enabled Codex hook manifests. Local
  consent, runtime state and downloaded engine binaries stay untracked. Codex
  may require the user to approve the new definition through `/hooks`.

Validation: 1,005 frontend tests; both TypeScript projects and production build;
704 native unit tests (10 explicitly ignored, 73 live integrations excluded).
Chromium and WebKit appearance checks cover themes, text scaling, narrow/wide
layouts, equal toolbar control heights, docked-header alignment, shared dock tint,
artwork transitions, seeking, keyboard actions, context menus and actual pointer
drag/drop. Native review covered Home, search, library, Stations, podcasts, radio,
settings, the small ❤️ Tracks playlist, artist/album pages, artwork and metadata
dialogs, notifications and docked queue in light/dark mode.

All four account-visible servers responded to library discovery. The three shared
servers exposed no accessible music sections for this account; switching to the
other music section on the current server worked. Music was restored and native
playback progressed across tracks. Alternate-server playback remains unverified
because no other server exposed a music library. Two earlier full test runs hit
bounded loudness-fixture timing failures; the focused checks and final full native
run passed without changing production timeouts or playback behavior.

The Impeccable source detector reported one advisory on an `animate-bounce`
selector inside the reduced-motion rule that disables animation, not an actual
bounce effect. Native WKWebView review supplies visual evidence; no CDP-based
rendered detector run is claimed. These changes remain local; 0.6.0 is on hold.

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

### Waveform and playlist background throughput

The user's scoped follow-up was handled while the release goal remained paused.
All entity rosters and full-detail passes were already complete. The remaining
worker unnecessarily rediscovered every track before fetching any waveforms;
playback added a one-second delay per stream and 600 ms per 200-entry playlist
verification page. Discovery now skips atomically recorded identities using a
covering active-media index (V11). Deferred track GET observations also discover
media atomically, and stale server revisions cannot claim a publication.

Full waveforms now use four concurrent GETs and 24-result transactions, with
exact scope/media/revision guards, foreground reuse and retryable failures.
Playlist verification uses compact local ordered identities, 500-entry pages
and visible progress; interruption still restarts the complete second proof.
Activity separates saved library metadata, playlist verification and waveforms.

Validation: 686 native tests passed, 14 live proofs ignored and 73 integration
tests filtered; 923 frontend tests passed, with the final Activity adjustment
also passing its mounted regression. Frontend/TypeScript and default-protocol
native builds passed. A read-only native Plex probe fetched 24 full waveforms
in 151 ms, all valid. After the authorized dev restart, schema V11 applied,
discovery completed and a 40-second live measurement averaged 64 streams/sec
(about 94 minutes estimated for the remaining 360,273 at that moment). Playlist
verification advanced from 99,500 to 149,500 during that same measurement.
The native Activity panel showed saved metadata, moving playlist progress and
thousands of saved waveforms, with playback resumed. These are throughput and
resume proofs; the entire waveform queue has not yet finished. No release work,
push, tag or publication was performed.

### Combined album browsing and playback

Tiffany Day's HALO has two physical Plex entries with the same album GUID:
tracks 2/7 and tracks 1/3/5/6/10/12/13. The previous track-count similarity
check split partial copies, and album pages/play queues loaded only one entry.
Release grouping now uses GUID or normalized artist/title/year, independent
of file counts. A shared local-first composition loads all physical members,
retains original disc/track order, and chooses playable lossless copies before
bit depth, sample rate and bitrate. Artist identities, distinct titles/years
without a shared release GUID, and repeated tracks in distinct disc/track
positions remain separate.

Both physical album links produce the same combined list without modifying
Plex metadata/files. Artist, Home, library, rated-album and search presentation
use the grouping preference. Album-card playback, queue/next actions, queue
dragging and playlist drops use combined tracks rather than a single physical
album URI. Explicit album intent/gain and scheduler identity span aliases while
physical IDs still own playback, waveforms and reporting; mixes retain track
normalization/crossfades. Native DTOs and saved audio retain disc numbers.
Scoped caches fence preferences/retired requests, invalidate alias edits and
prevent raw single-copy revalidation from overwriting combined contents.

Validation: 932 frontend tests and 687 native tests passed (14 live proofs
ignored; 73 integration tests filtered), with successful TypeScript/frontend
and default-protocol native builds. The final native suite used four test
threads while bulk indexing was active; an observed cancelled test-server
connection now exits without being mistaken for an API request. Through native
computer use, both HALO URLs showed all nine available tracks; Play from the
smaller entry started EVERYTHING I'VE EVER WANTED and advanced to 17 seconds.
The final native update was installed after verified process exit. Waveforms
passed 192,000 saved; dev hot reloads restarted the ordered playlist verification
proof, so the workers are being left uninterrupted after the final restart.
Native entity download leases/status remain per physical copy; merged download
ownership/badges are explicitly retained as a follow-up in the private TODO.
The release goal remains paused, and no push/tag/publication occurred.

Final post-restart readback: all roster, full-detail and playlist tasks are
complete. The native Activity panel reports "Library saved on this device"
(463,378 items) and just one active operation: waveform collection, with 260,933
saved, 108,250 remaining and 10 unavailable from Plex. The clean committed dev
build is left running without further hot reloads.

### Playlist matching and new ListenBrainz destinations

Background imports now continue through unavailable lookups and use the same
repeat-aware mapping calculation across batches, revalidation and filling.
Reliable songs are saved in source order; unresolved and unsupported repeated
occurrences remain in Sync review. Completed partial results are ready for
rematching, and weekly following can admit newer editions without treating a
missing match as a content conflict. Manual pauses, account changes, destination
drift and unknown mutations retain their gates. Successful background matching
clears stale session errors, and interrupted final fills remain resumable.

Matching completion now produces a dismissible notice once per outcome, with
hashed local receipts preventing restart repeats. Progress remains in playlist
settings, and notification actions refresh safely after reconnects. Native
review showed Weekly Jams with 31/50 matched and 19 review songs, and Weekly
Exploration with 26/50 matched and 24 review songs, without persistent matching
warnings.

Per-playlist Setup now defaults to creating a new private ListenBrainz
destination for local exports, including smart playlists such as ❤️ Tracks.
The playlist name is prefilled; existing destinations remain selectable.
Creation retains its source and receipt before a single empty create, then opens
recording review. Export intents and recovery have their own account orientation;
unknown destination IDs are canonicalized and inspected before durable adoption.
Recovery can reconnect the original account and never replays creation.

Validation: 947 frontend tests, seven native ListenBrainz transport tests,
both TypeScript projects and the production frontend build passed. Native UI
verification confirmed the ready ❤️ Tracks creation setup, its prefilled name
and export-only direction. Full creation, recording review, sync and recovery
were exercised with synthetic transports; personal playlists were not modified
for testing. The dev app is left on this setup. Commits remain local and 0.6.0
publication remains on hold.

### Local favorites and optional two-way mirrors

Liked Songs now owns a compact local SQLite collection rather than treating all
rated Plex tracks as loves. Hearts are available in track lists, artist/album
song rows, context menus and the player. Loved, Rated and All views preserve
separate rating browsing. Existing high ratings are included once; an explicit
heart overrides later star changes. Direct rating-triggered Last.fm love/unlove
has been replaced by the opted-in favorites worker.

The Sync dialog independently enables Plex, ListenBrainz and Last.fm, all off by
default. Plex can create a regular Liked Songs mirror or use an existing regular
playlist; ❤️ Tracks stays independent. Initial connection merges existing
favorites. Later complete stable rosters share likes/unlikes, preserve local
in-flight edits, retain unmatched songs and support manual library/recording-ID
review. Native credentials, account leases, durable receipts, single verbs and
read-back checks protect mutations and uncertain playlist creation. Distinct
ListenBrainz MSIDs remain addressable; a still-loved alias protects shared Plex
and Last.fm membership.

Native reads use the WAL read pool and bounded metadata batches; SQLite saves
only changed compact rows. A 12,000-record synthetic roster merge completes in
under the three-second regression limit. Large pagination, partial failures,
unknown writes/creation, offline local persistence, CAS, retired ownership,
ratings, real heart controls and recording review are covered by tests. All 978
frontend tests and 695 native unit tests passed (14 native tests ignored; live
integration tests excluded), along with both TypeScript projects and production
build. Real native UI review showed 78 local loved records and three disabled
sync connections; readonly SQLite readback confirmed those counts/flags. External
favorites were not changed for testing.

The default-protocol dev executable was installed after verified process exit
and hash readback. The app is running on localhost:1420 with the updated dialog.
Current profiles follow the existing credential/endpoint-bound library cache
identity; verified stable profile identity and migration across credential or
endpoint renewal remain on the private roadmap. No push, tag or release occurred;
0.6.0 remains on hold and the larger release goal stays paused.

### Favorites reload compatibility and sync clarity

Native remote recordings serialize missing duration and local track identity as
null. Favorites now accept that wire format when reloading saved rows and pending
receipts, while retaining validation of malformed durations and collection data.
Readonly verification of the actual SQLite collection found all 2,493 rows valid;
2,415 imported rows previously failed solely because duration was null. No reset
or database migration is needed. The user confirmed the collection loads again
and reported 93 matched songs; further matching improvements are deferred until
tomorrow.

Last.fm and ListenBrainz controls now say "Sync likes with" to make import and
shared updates clear. Tauri string errors retain their underlying message instead
of the generic sync failure. The playbar heart and rating share a centered row.
All 35 focused favorites and player accessibility tests passed, along with
TypeScript and diff checks. Native computer use still fails to start its pipe;
live recovery was confirmed by the user, and the heart layout was not visually
rechecked. No push, tag or release occurred; 0.6.0 remains on hold.

### Original like dates and an explicitly requested fresh import

Native imports now retain Last.fm date.uts and ListenBrainz feedback.created as
Unix milliseconds. Saved favorites and service observations keep those dates
separate from local edit/sync state. Repeated syncs, acknowledgements and matching
preserve chronology; explicit local relikes get a new date. Legacy imports can
backfill dates, and unavailable dates stay unknown. Loved sorts by love date,
All combines love/rating chronology, and a Date Liked column supports either
direction with unknown dates last. Library-added/rating dates stay separate.

At the user's request, the exact development app was stopped and a private
favorites-only SQLite backup was created and read back. Reset removed 2,415
remote-import entries, retained 78 local favorites, cleared Last.fm/ListenBrainz
observations/bindings, and disabled those two sync switches. Plex catalogue,
ratings, audio and service credentials were not part of this reset. The rebuilt
default-protocol executable was installed with hash verification and reopened;
readonly database checks confirmed 78 retained favorites, both sync switches off
and no remote bindings. Re-enabling sync and personal matching remain for the
user, as requested. Native computer use still fails to start its pipe.

Validation: 38 focused frontend tests, five native favorites transport/parser
tests, both TypeScript projects and the production frontend/native dev builds
passed. Regression cases cover service timestamps, optional/malformed values,
save/reload, date backfill, relikes, acknowledgement stability, combined All
ordering and date-column sorting. Existing build warnings remain. No push/tag or
release occurred; 0.6.0 stays on hold.

### ListenBrainz pacing and rate-limit recovery

Favorites, playlists, token checks and listen submissions now share a native
ListenBrainz request budget. Requests are separated by at least one second,
include the application User-Agent and adapt to remaining/reset headers.
Explicit 429 rejections allow up to two additional read attempts after the
cooldown; writes, creates and listen POSTs are never automatically replayed.
Long cooldowns produce a clear wait message. Mutation account guards run after
waiting, and long waits require a new preflight rather than using stale proof.
ListenBrainz feedback pages now request up to 1,000 records, retaining complete
stable-roster checks while reducing initial request volume.

Validation: 38 focused frontend favorites tests, 18 distinct native
transport/parser/playlist tests, TypeScript and the default-protocol native build
passed. A macOS loopback fixture now explicitly makes accepted sockets blocking
before its blocking reader; this fixed a sporadic WouldBlock harness failure.
Readonly live checks confirmed Last.fm imported all 2,431 source love dates.
The rebuilt native dev app was installed with hash verification and restarted;
both user-enabled sync connections and the saved favorites were retained. Native
computer use remains unavailable. No push, tag or release occurred.

Post-restart readonly verification confirmed both favorite connections are
initialized: 2,431 Last.fm source loves and 4,076 ListenBrainz source loves are
recorded. The combined collection contains 5,698 records, including 5,636 with
known love dates. This verifies the running app completed its ListenBrainz
roster after the reported 429 failure; future matching improvements stay deferred.

### Long-session background refresh stability

The reported reload affects page contents while the shell and player remain
visible. Readonly inspection of the 15-hour development process found all saved
library/waveform tasks complete, no queued item changes and an idle incremental
worker. A requested future catch-up was incorrectly presented as running work.
Activity now distinguishes scheduled checks from active work. Failed native
catch-ups return to idle while retaining their resumable window.

Native WebSocket hints now refresh through committed catalogue events instead of
also refreshing immediately. Event and polling revisions share a serialized,
coalesced refresh queue with a ten-second minimum between starts. Background
metadata callbacks refresh only their visible artist/album page; unchanged JSON
with different object-field ordering no longer counts as a metadata change.
Artist/album refreshes preserve expanded descriptions and open artwork/edit
dialogs, including after cache eviction. Real navigation still resets the page.
Connection heartbeat intervals use monotonic time, and development module
retirement disposes old monitors, sockets and pending page refreshes.

Validation: 108 focused frontend tests and 16 native incremental catalogue tests
passed, along with both TypeScript projects, the production frontend build and
default-protocol native build. Tests include a simulated 24-hour event stream,
slow overlapping reads, duplicate signals, offline/retired ownership, field-order
comparison and mounted artist/album controls. The existing page-ownership fixture
now supplies the Date Liked column introduced by the previous favorites work.
The rebuilt dev app was installed after verified process exit/hash readback and
reopened. No real overnight soak or native visual recheck has been completed;
computer use remains unavailable. No library/favorites reset, push, tag or release
occurred; 0.6.0 remains on hold.

### Stable Plex device identity for retained listening reports

Normal requests already reuse the saved installation UUID. The retained native
listening outbox incorrectly used an installation-plus-job hash as the client
identifier, registering a new server device for every completed track. Readonly
inspection found 415 such records initially, then 416 before the fix was installed.
The account's separate Authorized Devices list contains one correct Hibiki client.

All timelines now use the installation identity, with no caller override. Retained
reports use Plex's documented X-Plex-Session-Identifier and offline/updated fields
to isolate historical playback from the live player. New retained records save
their end timestamp; old records use their saved start timestamp. Live/shutdown
timelines retain their normal behavior. Timeline requests use the documented POST
method and encode query values through the HTTP client.

Validation: all 702 native unit tests passed (14 ignored, live integration tests
excluded), including actual loopback HTTP requests for live playback, repeated
historical delivery, distinct sessions, shutdown, recreated clients and legacy
outbox rows. The native build passed and was installed into the exact development
bundle with exit/hash verification. No push, tag or release occurred.

At the user's request, the 416 server-side history devices were consolidated into
the existing installation record. Plex's device API does not support deleting
these records. A consistent 3.2 GB database backup and a rollback rehearsal
preceded the cleanup. An exact affected-row recovery backup was captured during
a brief stop of the supervised Plex process; the Flux-owned Deployment, replica
count and sidecar were unchanged. One checked transaction reassigned 2,080
bandwidth-statistic rows and 2,080 media-statistic rows, retained every statistics
and listening-history row, and removed only the matching per-track device IDs.
Plex returned online in its existing pod with zero container restarts. API
readback confirms zero duplicate history clients and the original device and
account authorization intact.

### Stationary waveform during playback

The playbar's proportional elapsed-time label resized slightly as clock digits
changed. Its flex sibling was the waveform canvas, so each width change could
change the bar count and resample the waveform into visibly different heights.
Both clocks now reserve non-shrinking, tabular-digit columns sized for the track's
duration. The same sizing also accommodates long durations in the fullscreen
visualizer. The waveform may still resize with an intentional window/layout
change, while playback progress only advances its played-color overlay.

Five focused waveform/canvas/player accessibility tests, both TypeScript projects
and the production frontend build passed. Native computer use is working again:
the exact development app was inspected during real playback, with the same
waveform retaining its geometry as the clock advanced. The frontend update is
live through Vite without restarting playback. No push, tag or release occurred.


## Plex-first browsing and focused offline storage (2026-10-16)

Connected reads now use Plex and bounded visited-page snapshots (32 MiB per
scope, 128 MiB globally), alongside existing in-memory navigation caches. Removed
the full native catalogue, playlist-membership and waveform workers, IPC start/
retry/event entry points and catalogue Activity notices. Plex events refresh
shelves and invalidate relevant details without restarting unrelated pages.

Offline storage retains explicit entity membership, complete cached/downloaded
audio metadata, exact waveform/media revisions, requested sonic responses and
favorite references. Favorites and chronology, provider/artwork choices, sync
receipts/settings and audio intentions are preserved. Missing favorite metadata
loads in bounded Plex batches. Offline activation reprojects file availability
instead of restoring online UI flags, and retains local favorites access. Known
endpoint aliases recover an existing scope only with the same credential,
server identity and library UUID; they do not merge accounts or libraries.

Sidebar download icons now mean an explicit playlist download intention.
Shared cached tracks no longer produce partial/error badges on other playlists.
Persistent artwork retries after connectivity/focus recovery with bounded
backoff. Detailed download failures remain on the entity page.

The stopped development database was fully backed up and reduced from
17,660,665,856 to 148,545,536 bytes. Protected-table checksums and every retained
raw metadata/analysis/playlist row matched the backup; quick_check passed.
Preserved 5,698 favorite records and 83 explicit download entities. Subsequent
playback naturally adds small working-set records. The full private backup is
retained outside the repository. scripts/compact-local-library.py supplies the
same transactional, backup-verified maintenance for V12 development databases.

Validation: 1,002 frontend tests, 702 native unit tests (10 ignored, 73 live
integration tests excluded), both TypeScript projects and production frontend
build pass. Native online QA opened the small ❤️ Tracks playlist and started
playback in about a second; progress advanced and sidebar artwork rendered.
Activity showed the server's actual Plex scan rather than Hibiki indexing.
Picard-style metadata editing is documented as a deferred, opt-in workspace.
No push, tag or release.

Native offline readback also passed after the final build: Browse offline showed
the Plex-unavailable banner, ❤️ Tracks retained its explicit download badge,
its Play action worked, local audio advanced from 0 to 10 seconds, and Liked
Songs remained available. Endpoint fallback initially exposed an existing
credential/server/library-equivalent scope split; the verified alias resolver
now recovers the original downloads/favorites owner without merging accounts.
