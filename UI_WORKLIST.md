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
