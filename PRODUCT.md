# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Hibiki uses a shared web interface inside a Tauri desktop application for macOS,
Windows and Linux. Its design language does not change to imitate each operating
system. Browser fixtures support development; the connected desktop app is the
reference for authentication, playback and native integration.

## Users

People with large personal music libraries in Plex who want a dependable desktop
player for everyday listening, browsing, discovery and playlist management.

## Product Purpose

Make a personal music collection pleasant to explore and effortless to listen to.
Success means reliable playback and transitions, responsive browsing at large
library sizes, useful discovery, and optional offline listening without background
maintenance making the player sluggish.

## Positioning

A dedicated music client for an existing Plex collection, with a native audio
engine, Plex discovery and radio, optional external metadata, and connections to
the listener's favorites and playlists in other music services. Plex supplies the
collection; Hibiki supplies the listening experience.

## Operating Context

- Desktop listening with media keys, keyboard shortcuts, a persistent player and
  optional docked queue or lyrics.
- One account may have access to several Plex servers and music libraries.
  Switching libraries must preserve account and library boundaries.
- Collections can contain hundreds of thousands of items, incomplete metadata,
  duplicate album editions and several media versions of a song.
- Connectivity and provider availability vary. Explicit downloads support offline
  playback; saved browsing must accurately distinguish locally available content.

## Capabilities and Constraints

- Plex is authoritative for connected library browsing. Fetch current data from
  Plex, use bounded caches, and retain the information needed for explicit offline
  downloads. Do not maintain an unsolicited full local mirror or continuous crawl.
- Playback supports streaming, preloading, loudness handling, gapless transitions
  and crossfades. Transition decisions must respect deliberate album playback.
- Combine duplicate album contents and prefer the best available media version
  without changing the user's library destructively.
- Hibiki stores liked songs locally by default. Syncing favorites or playlists
  with Plex, ListenBrainz or Last.fm is optional, with direction and limitations
  made clear. Last.fm is a favorites/scrobbling service, not a playlist-sync API.
- Metadata and independent poster/background artwork can come from Plex and
  configured external providers. Expose only available capabilities, retain source
  attribution, and review edits before writing them to Plex.
- Appearance preferences include theme, font, size, density and color. Preserve
  readability, keyboard access and reduced-motion behavior across these settings.
- Keep credentials private and prevent stale asynchronous work from crossing
  account, server or library boundaries.
- Picard-style bulk identification, metadata repair and artist splitting/merging
  are future ideas. AI integration is deferred; do not introduce model downloads.

## Brand Commitments

Keep the Hibiki name and its music-first identity. The user has explicitly chosen
Heya as an interface reference and artwork-driven presentation as part of the
application's character. Refinement must preserve personal appearance choices
and the prominence of the collection's own artwork.

## Evidence on Hand

- `README.md` describes the application and native integrations.
- `src/metadata/README.md` records metadata capabilities and editing constraints.
- `src/playlistSync/README.md` records matching, sync and recovery behavior.
- `UI_WORKLIST.md` records implemented polish and its validation boundaries.
- `tests/fixtures/` and the renderer scripts exercise actual components with
  controlled data. They do not establish live-service or native playback success.
- `screenshots/` includes fictional demo-library previews and older UI captures;
  screenshots are not customer testimonials or performance benchmarks.

## Product Principles

1. Listening stays responsive while browsing, enrichment and maintenance run.
2. Use Plex's collection directly; store local data for a clear user benefit.
3. Make availability, sync direction and the consequences of edits understandable.
4. Preserve the listener's collection, preferences and account boundaries.
5. Make artwork-rich browsing readable and consistent throughout the application.
