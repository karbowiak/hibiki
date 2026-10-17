# YouTube Music connection experiment

The YTM button opens the actual YouTube Music website in an isolated,
persistent native WebView. There is no OAuth application registration. Google
can reject embedded sign-in; the macOS window uses a Safari identity matching
its WebKit engine. Other platforms still need real-account verification.

The user verified Google password/2FA sign-in, authenticated search, automatic
window closure, persistence across app restarts, and hidden startup renewal.
The post-2FA hang was a blocked `gds.google.com` navigation. The exact Google
handoff host is now allowed. Native plugin initialization scripts run only in
Hibiki's main window, preserving the website's browser APIs. Regional Google
session handoffs are restricted to the supported domain snapshot and explicit
SetSID/CheckCookie paths. The session window has no Hibiki IPC capabilities.

Hibiki refreshes the session at startup and about hourly while open, earlier
when authentication cookies approach expiration. Network failures retry after
five minutes. Interactive sign-in is never interrupted by automatic navigation.
The user verified startup renewal; elapsed hourly renewal still needs a live
check. Window-state restoration excludes the hidden session window. The bare
dev executable and app bundle have separate WebKit application containers.

The YTM connection panel manages sign-in and playback tools; the temporary song
tester has been removed ahead of integrated search. Queue entries contain a
stable `ytmusic:VIDEO_ID` identity, never a signed audio URL. Rust admits that
identity into the existing audio engine, then runs yt-dlp with current website
cookies under the engine's cancellable play/preload ownership. Stop, rapid
selection changes, and replacing the next queued track cancel obsolete lookups.
The resolved native HTTP source enters the normal streaming cache, Symphonia
decoder, DSP, output, seeking and queue transitions. YTM identities bypass Plex
metadata, timeline and DJ requests. Mixed queues persist stable identities and
public display metadata; restoring a YTM row does not ask Plex for it.

Played, current and upcoming queue rows identify Plex and YouTube tracks with
source logos, including saved rows awaiting metadata hydration. The player shows
the current source logo and a `Plex` or `YTM` label beside shuffle. The track information
panel shows YouTube Music as the source, its public video ID, the native decoder
format and current normalization, transfer size and stream/cache source. It does
not ask Plex for YouTube metadata or claim that missing list metadata means the
track has no loudness analysis. Live measurements are read only while an info
view is open and remain bound to the current playback occurrence.

Saved queue metadata includes track, album and artist artwork URLs, including
cold rows retained during bounded metadata hydration. YTM cover images use the
shared native image protocol and disk cache. Restores reuse the selected cover
without wrapping its image URL again. Older entries with no saved cover use
the public video thumbnail ([YouTube API example](https://developers.google.com/youtube/data/getting-started?hl=en)).

The user verified full audible playback for a search for `f5ve electro`, then
verified the in-app installer, managed yt-dlp/Node installation, and full audible
playback of `f5ve - I Choose You` with the Node runtime. Initial playback can include
extractor startup/network time and complete loudness preparation when no gain
metadata exists. The extractor now retains its script cache and skips redundant
account-menu verification after a recent successful session check. Native info
logs separate stream lookup, initial decode and loudness preparation durations.

Encoded audio now uses a stable cache key for the connection and video ID,
independent of the temporary stream signature. The connection cache namespace
survives restarts and is replaced on Disconnect. It shares the existing size
limit, eviction, revision checks and cache settings with Plex. A complete cache
hit bypasses yt-dlp and the player API entirely, including quick resume.
Corrupt or evicted bytes fall back to a fresh native stream lookup.

The authenticated player metadata request runs alongside yt-dlp. Absolute
`trackAbsoluteLoudnessLkfs` for the selected audio format, or the player's
`perceptualLoudnessDb`, supplies track gain for Hibiki's existing -18 LUFS target.
The relative `loudnessDb` field is not treated as LUFS or assumed to use -14 LUFS.
Missing or invalid absolute metadata falls back to the same R128 worker used
for Plex. Both supplied and measured track gain persist with the encoded file's
exact cache revision; album gain stays separate.

The next three songs in a mixed queue are prepared through one native path:
download/cache the encoded item, then obtain any missing track loudness using
the shared worker. The immediate next song still gets the existing PCM preload
for gapless transitions. Background warming owns no playback deck, yields to
foreground commands and resumes after a preload; selection, Stop and replacing
the warming batch retire obsolete work. Cached replay and gain reuse across a
cache-manager restart are covered by native synthetic-audio tests. The user
verified about eight seconds for an initial uncached song, immediate playback
after restarting Hibiki, consistent Plex/YTM loudness and working mixed queues.
An unplayed queued YTM song starts immediately after roughly ten seconds of
background preparation.

Waveform fallback is shared by Plex, YTM and other native audio sources. Provider
waveforms take precedence; missing or failed provider levels use completed cached
audio, including queue preparation. Only the next three queued songs are prepared;
this does not scan the library. Loudness already uses provider gain when present
and the same cached-file R128 worker when it is missing. A separate waveform worker
decodes one file at a time and builds a
bounded RMS envelope for the existing waveform renderer. This display data does
not change playback gain and never blocks playback startup. Selected playback
awaits the optional result separately; obsolete occurrences cannot update the
current waveform. Results use the encoded cache revision, persist across restarts
and disappear with replaced, cleared or evicted audio. Up to 512 compact
1024-point waveforms are retained (about 1 MiB of index data); older envelopes
can be regenerated while their audio and loudness remain cached.
The user verified that waveforms appear during playback and are generated for
upcoming YTM songs in the queue.

Home discovery keeps Mixes for You, Latest Releases, Recently Added and Recently
Played Music first, in that order. Compatible Plex and YTM shelves merge; other
music shelves alternate between providers. YTM shelves are optional and disappear
when the connection is unavailable. Mixes accept playlists rather than individual
song recommendations, with Mixed for You taking priority. Source logos identify
Plex and YTM mixes. Cards retain YTM's own generated mix artwork and subtitle,
including composition query parameters, through the shared public image cache.
Collection pages show each song's artist and artwork.

All parsed YTM catalog reads (home, artists, albums, mixes, playlists, library,
search and continuation pages) pass through the same native persistent cache.
HTTP `Cache-Control: max-age` or `Expires` takes precedence, accounting for
`Date` and `Age`. Otherwise freshness defaults to six hours for artist/album
details, five minutes for home/history/mixes, and fifteen minutes for other
collections/searches. Fresh pages return immediately; expired pages within the
stale window return immediately and launch one background revalidation. Changed
results update mounted views without navigating away. Cursor chains discard
unreachable old pages if YTM changes a continuation token.

The fallback stale window is seven days; an explicit `stale-while-revalidate`
window takes precedence, capped at seven days. `no-store`, `no-cache` and
`must-revalidate` restrictions are respected, following
[HTTP caching semantics](https://www.rfc-editor.org/rfc/rfc9111.html).
Refresh failures retain saved data; background retries have a thirty-second
cooldown. Only parsed catalog metadata is persisted, never credentials, raw
responses or signed media URLs. Live authentication checks remain uncached;
audio, waveform, loudness and artwork use their existing dedicated caches.

The catalog cache is scoped to the persistent connection identity, with up to
128 pages and 32 MiB on disk. Concurrent browsing and queue requests share the
same result. Disconnect clears the data and retires late writes and UI events.
Refresh page bypasses freshness for the current view, including YTM, without
clearing unrelated artwork and catalog caches. Starting playback
from a mix uses the displayed track-list snapshot before continuing its cursor,
so regenerating a personalized mix cannot change which selected row starts.

Hub headings open dedicated pages with incremental loading. Plex uses hub keys
and container paging where available, or requests larger generated hub previews
until the server stops returning more. YTM collections use continuation tokens
for browsing and the mixed-source queue. Latest releases sort known release dates
across providers. Year-only releases are interleaved within that year in provider
order; undated new-release recommendations join the current batch. Exact day
ordering is unavailable for those items, and upload dates are not treated as
release dates. Plex editions take precedence when the
artist and title match.

Recently Played combines Plex history, YTM history and up to 200 locally saved
YTM plays. Local history is recorded after the native engine accepts a track
start, including queue transitions. It stores only stable IDs, timestamps and
public display metadata; Disconnect clears it. This does not report playback
back to Google. Combined client search remains future work.

The connected account's saved playlists join Plex playlists in the sidebar,
Playlists view and Your Library. All three use the same saved user order;
disconnecting YTM preserves its positions for the next connection. Liked Songs
includes YTM likes, Liked Albums includes saved albums, and Liked Artists includes
subscribed artists. Library shelves interleave providers and prefer matching Plex
editions. Album and artist grids retain Plex's bounded paging; YTM continuations
load as the view reaches them. The Liked Songs view prepares its full YTM membership
on demand for playback and shuffle, rather than scanning songs at startup.

YTM collection pages use the Plex playlist layout, track table and saved column
preferences, with no outer page inset. Available artist/album links, duration,
year, track position, explicit markers and view counts are retained. Missing
metadata stays empty, and YouTube views are separate from personal play counts.
YTM songs have a shared heart control in search, track tables, the player and
queue, plus a like/unlike context-menu action. These write to the connected YTM
account through native `like/like` and `like/removelike` requests, following the
[ytmusicapi library implementation](https://github.com/sigma67/ytmusicapi/blob/main/ytmusicapi/mixins/library.py).
They do not change Plex stars or Hibiki's local Plex favorites. Liked Songs updates
optimistically and rolls back on failure; duplicate writes for a song are blocked
across views. Unknown status is checked on hover/focus or before toggling, with
eager checks only for the current song. Status reads use the same persistent SWR
cache as discovery. Menus use YTM's current status when supplied, including the
inverse action described by its watch-queue menu.

Successful writes invalidate saved Liked Songs cursor pages and patch that song's
like state in other cached pages. Pre-mutation responses cannot overwrite these
disk updates. The visible collection updates immediately; the next library read
or page refresh reconciles the invalidated pages without a full-library scan on
each heart click. In-session optimistic overrides protect it from old responses.
Disconnecting retires pending
checks, writes and UI state. Offline controls are disabled; errors remain available
in the button tooltip and explicit save failures appear in the notification center.

Other YTM library data remains read only: its menus offer playback and queue actions without
Plex rating, playlist editing, download or sync actions. Parsed library data uses
the same native connection-scoped catalog cache and refresh behavior as mixes.

YTM artist links open the shared artist page rather than a playlist view. It
retains the artist's artwork, biography, top songs, albums, singles/EPs, live
performances, featured releases, artist playlists and Similar Artists. Video,
Shorts and podcast shelves are omitted. Performance shelves explicitly admit
their video-backed entries for native audio playback; ordinary music shelves
still use the audio-track filter. Expanded shelves fetch their full destination
and continuation on demand through the native catalog cache. Album and single
cards merge in release-year order; unknown years stay behind dated releases.

Opening a Plex artist looks up YTM artists and compares their destination names
at a 93% normalized edit-similarity threshold. Matching ignores case, accents,
spacing and punctuation; short names require the same normalized spelling.
Opening a YTM artist uses the same rules for its scoped Plex artist lookup.
Duplicate or close profiles are ranked by shared songs and releases, including
duration and release year when available. YTM profiles sharing a subscription
channel can be treated as aliases and prefer the fuller catalog. Unresolved
ties stay separate, and catalog lookups are limited to six candidates without
selecting from a truncated set. This is heuristic matching, not independently
verified artist identity. Matched pages retain Plex metadata and editions, and add
missing YTM releases, top songs and recommendations. Plex's Sonically Similar
Artists shelf remains available whenever matched Plex data and that capability
are present. YTM-only artists never receive Plex editing, rating or download
controls. Header Play/Shuffle prepares a mixed cursor-backed artist queue on
selection, using Plex's known tracks and YTM's artist song destination without
pre-fetching the artist's entire album catalog when the page opens.

The artist response structure and filtered search parameters follow the primary
[ytmusicapi browsing implementation](https://github.com/sigma67/ytmusicapi/blob/main/ytmusicapi/mixins/browsing.py)
and [search parser](https://github.com/sigma67/ytmusicapi/blob/main/ytmusicapi/parsers/search.py).

Client search queries Plex and YTM concurrently, publishes available results
as each finishes, and interleaves artists, albums and songs within their groups.
All YTM artists are eligible. Matching Plex entries take precedence; artist
names use the same 93% threshold, while recordings retain version, featured
credit, duration and explicit/clean checks. YTM results use native playback and
the shared detail routes, without Plex editing actions on remote IDs.
Search includes YTM's featured top-result card as well as its nested result
rows, following the [ytmusicapi top-result parser](https://github.com/sigma67/ytmusicapi/blob/main/ytmusicapi/parsers/search.py).
Search cache keys are versioned separately so incomplete snapshots from the
previous parser do not hide the featured artist until their TTL expires.

Plex album pages look up the corresponding YTM album using artist name, release
title and year when present. Ambiguous editions require a unique recording
overlap or the same sequence of video IDs. Missing recordings are inserted at
their album positions while Plex recordings retain their metadata and order.
YTM album links with an unambiguous matching Plex catalog open that same album
view after checking recording overlap; unmatched or ambiguous albums retain
their YTM view.
Play, Shuffle and queue actions use this mixed track list; version review and
Plex download actions retain the Plex catalog. Track rows and release/artist
cards show Plex/YTM source logos.

Playback tools are **not bundled**. Install playback tools in the YTM panel
explicitly downloads official yt-dlp and Node executables into Hibiki's per-user
local data directory. Downloads use the platform URLs and SHA-256 checksums in
`src-tauri/src/ytmusic/tools.lock.json`; each executable must pass `--version`
before becoming available. They remain available after restarting Hibiki, and
Reinstall playback tools repairs the current pinned versions. Existing tools in
PATH are usable until managed tools are installed. There is no startup download,
package-manager dependency, global install, Deno dependency, or renderer process
execution permission. The manifest currently covers Apple Silicon/Intel macOS,
x64/arm64 Linux and x64 Windows. Runtime selection explicitly enables Node and
clears yt-dlp's default runtimes. See [yt-dlp's runtime support](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

Cookies remain in the native WebView store and native memory. yt-dlp receives a
private temporary Netscape cookie file, removed when the operation finishes or
is cancelled. Native API calls derive SAPISIDHASH authorization from current
YouTube cookies. Cookies, signed media URLs and raw extractor errors never enter
React or logs. Disconnect revokes in-flight session admission and clears the
website's browsing data; it does not revoke other Google sessions.

The native `ytmusic_test_stream` diagnostic remains available: it downloads at
most 2 MiB and silently decodes about one second. Combined client search remains
future work.

Validation:

```sh
(cd src-tauri && cargo test --locked --all-features --bin hibiki ytmusic::)
(cd src-tauri && cargo test --locked --all-features --bin hibiki audio_engine::source::tests)
(cd src-tauri && cargo test --locked --all-features --bin hibiki audio_engine::preparation::tests)
(cd src-tauri && cargo test --locked --all-features --bin hibiki audio_engine::waveform::tests)
(cd src-tauri && cargo test --locked --all-features --bin hibiki audio_engine::control_tests)
(cd src-tauri && cargo test --locked --all-features --bin hibiki db::playback_queue::tests)
bun test tests/audioBridge.test.ts tests/playerMetadataLifecycle.test.ts tests/playbackRequests.test.ts tests/queueSession.test.ts tests/imageUrl.test.ts tests/youtubeMusicPlugin.test.ts
bun scripts/check-youtube-music.ts
bun scripts/check-youtube-music-playback.ts
```

The browser fixtures use fake account, installation and playback implementations.
The running Hibiki client uses the real native backend through the YTM button.
The connection panel uses the shared translucent overlay surface and includes an
unsupported-use disclaimer. YouTube’s [terms](https://www.youtube.com/static?template=terms)
restrict automated access and allow account suspension for material or repeated
breaches; the panel describes this as a possible risk, not an expected outcome.

### Music radio

The headphone panel offers Plex radio, YTM radio, and a combined Radio button.
Plex uses its existing track/album/artist radio recommendations, independently
of Guest DJ. YTM uses an audio-only `next` queue seeded with the song's video ID
and follows radio continuation tokens through the shared authenticated SWR cache.
Cross-service seeds must match the same recording. If a mixed-radio seed has no
match in the other catalog, it uses ten recommendations from its original service.
A dedicated other-service radio request still reports a missing seed match.

The current song sits outside a ten-song upcoming window. Dedicated radio uses
ten tracks from one service; mixed radio alternates five Plex and five YTM tracks.
Each service retains at most 60 buffered recommendations, with a bounded recent
recording history for duplicate suppression. Refills follow the station across
skips and publish against the latest queue. They retire on a new queue context
or connection change. Playback preparation, encoded audio, gain and waveforms
reuse the normal shared cache and prefetch pipeline.

A failed service keeps its quota empty rather than silently changing a 5/5 mix.
The queue footer offers Retry, and automatic requests back off for 30 seconds.
Manual insertion, reordering, shuffle, or clearing upcoming songs stops radio
autofill while retaining the user's queue. Removing an upcoming song refills its
service quota. Stopping radio retains already queued songs.

Regression coverage is in `tests/musicRadio.test.ts`, the radio cases in
`tests/playerMetadataLifecycle.test.ts`, and the native radio continuation parser
test. These additions have not been run in the active development session.

### Music links

Artist/album credits share Plex-first navigation across track tables, the player,
queue, search, artwork cards and detail views. Known Plex IDs open directly. YTM
credits check for a unique matching Plex entity on navigation, then retain their
YTM destination; metadata-only credits can resolve a YTM artist or album as well.
The resolver caches at most 256 lookups for ten minutes (one minute for a missing
match), coalesces requests and retires results on provider/account changes. It
does not search once per rendered row. YTM catalog searches still use the native
SWR cache. Names with ambiguous catalog matches keep a known YTM link instead of
choosing a Plex artist or album arbitrarily.

YTM albums, artists, songs and playlists use the shared context-menu renderer,
with the same playback/navigation ordering, icons, section dividers and Share
group as Plex. Collections can play through the normal progressive queue;
Play next/Add to bottom materialize at most 500 songs and fail before insertion
if the collection is larger. Radio from a collection uses its first playable
song. Async menu actions are fenced by the menu, playback selection and account.
Plex-specific offline downloads and star ratings remain provider capabilities.
