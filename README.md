# Hibiki

<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Hibiki icon" width="128" />
  <br />
  <strong style="font-size: 1.5em;">Hibiki</strong>
  <br />
  <em>響き — Japanese for "resonance" or "echo"; the sound that lingers after the note is played.</em>
</p>

<p align="center">
  A Spotify-inspired desktop music client for <a href="https://www.plex.tv/">Plex</a>, built with Tauri 2 and React 19.<br />
  Browse your library, play tracks with a native Rust audio engine, manage playlists, explore radio & DJ modes, discover podcasts, enjoy visualizers, and more — all from a fast, frameless desktop app.
</p>

<p align="center">
  <img src="screenshots/main.png" alt="Hibiki" width="100%" />
</p>

> Frontend layout and design based on [tauri-spotify-clone](https://github.com/agmmnn/tauri-spotify-clone) by [@agmmnn](https://github.com/agmmnn).

## Screenshots

Home, artist, album and search previews show the 0.6 interface with a fictional
demo library. Playlist, radio and podcast images below are from the earlier UI.

<p>
  <a href="screenshots/artist.png"><img src="screenshots/artist.png" alt="Artist" width="32%" /></a>
  <a href="screenshots/album.png"><img src="screenshots/album.png" alt="Album" width="32%" /></a>
  <a href="screenshots/playlist.png"><img src="screenshots/playlist.png" alt="Playlist" width="32%" /></a>
</p>
<p>
  <a href="screenshots/search.png"><img src="screenshots/search.png" alt="Search" width="32%" /></a>
  <a href="screenshots/internetradio.png"><img src="screenshots/internetradio.png" alt="Internet Radio" width="32%" /></a>
  <a href="screenshots/podcasts.png"><img src="screenshots/podcasts.png" alt="Podcasts" width="32%" /></a>
</p>

## Features

### Playback
- Native Rust audio engine with modular DSP chain — FLAC, MP3, AAC (including HE-AAC), ALAC, Opus, Ogg Vorbis, WAV
- Gapless playback + crossfade with album-aware, time-based, and MixRamp modes
- Dual-deck architecture with seamless track transitions
- 10-band parametric EQ with built-in presets
- Preamp, postgain, and limiter DSP nodes
- Sleep timer

### Radio & Discovery
- Track Radio, Artist Radio, Plex Stations
- 6 DJ modes — Stretch, Gemini, Freeze, Twofer, Contempo, Groupie
- Internet radio via radio-browser.info with ICY metadata parsing

### Podcasts
- iTunes + Podcast Index search
- Top charts by category
- Subscribe & play episodes

### Visualizer
- **Compact** — waveform, spectrum, oscilloscope, VU meter
- **Fullscreen** — spectrum, oscilloscope, VU, starfield, Milkdrop (butterchurn)
- 395 unique Milkdrop presets with browser, favorites, and auto-cycle

### Library
- Home hubs & recommendations
- Playlists page with smart playlists and infinite scroll + virtual scrolling
- Liked tracks, albums, and artists
- Tag / genre browsing
- Draggable sidebar playlists
- Full-text search across tracks, albums, and artists
- Plex websocket for real-time library updates

### Metadata & Integrations
- **Last.fm** — scrobble, now-playing, love/unlove, metadata augment or replace mode
- **Deezer** — artist images, album covers, genres, fan counts
- **Apple / iTunes** — genres, release dates and album artwork
- **MusicBrainz, Wikidata and Cover Art Archive** — verified identities, artist information and approved album covers
- **Fanart.tv, HeyaMetadata, SoulSync and TheAudioDB** — optional configured enrichment sources; TheAudioDB requires a premium V2 key
- Artist, album and playlist editors with source attribution, independent poster/background choices, and reviewed Plex metadata changes
- Reviewed ListenBrainz playlist copies and opt-in bidirectional links, with ordered verification, conflict review and recovery. Repeated-song imports into Plex are blocked to avoid server deduplication.
- Explicit canonical MusicBrainz/Heya identity selection, Plex artwork uploads and editable tags/locks
- Read-only browsing of visited library pages saved in account-scoped SQLite snapshots
- Non-destructive comparison of album copies and track media versions
- Synced lyrics display with adjustable offset

See [metadata and editing](src/metadata/README.md) for source capabilities and [playlist copies](src/playlistSync/README.md) for matching and recovery behavior.

### Image Caching
- Custom `image://` URI scheme with on-disk cache
- Source priorities and per-item choices, with separate poster and background artwork

### Appearance
- 9 accent colors + custom hex picker with color picker
- Dark / light theme
- Font selection
- Card size slider
- Compact mode
- Reduced motion support
- Full-window artwork, sharp heroes with blurred continuation, shared translucent navigation and independent now-playing colors
- Background rotation every 45 seconds with pause/next controls
- Easter eggs

### Accessibility & Usability
- Global keyboard hotkeys with help modal
- Live announcer for screen readers
- Reduced motion preference
- i18n scaffolding (English)

### Platform
- OS media keys (macOS / Windows / Linux via souvlaki)
- Desktop notifications
- Auto-updater
- Plex.tv OAuth sign-in
- Local SQLite database
- Window state persistence

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 + TypeScript |
| Styling | Tailwind CSS v3 |
| Routing | Wouter |
| State | Zustand v5 |
| Desktop shell | Tauri v2 |
| Backend | Rust (Tauri commands) |
| Audio engine | CPAL + Symphonia, native Opus/AAC decoders, Rust DSP |
| Media keys | souvlaki |
| Database | rusqlite (SQLite, WAL mode) |
| Visualizer | butterchurn (Milkdrop) |
| Drag-and-drop | dnd-kit |
| Icons | Tabler Icons |
| Package manager | Bun |

## Download & Install

Grab the latest release for your platform from the [Releases page](https://github.com/karbowiak/hibiki/releases).

| Platform | File | Notes |
|---|---|---|
| **Windows** | `.exe` (NSIS installer) | Run the installer and follow the prompts |
| **macOS (Apple Silicon)** | `.dmg` (aarch64) | Drag Hibiki into Applications |
| **macOS (Intel)** | `.dmg` (x86_64) | Drag Hibiki into Applications |
| **Linux** | `.AppImage` / `.deb` / `.rpm` | See below |

### macOS — Security Warning

Hibiki is not currently code-signed or notarized with Apple, so macOS Gatekeeper will block it. Run this in Terminal after downloading to remove the quarantine flag:

```bash
# Remove quarantine from the downloaded .dmg
xattr -cr ~/Downloads/Hibiki_*.dmg
```

Then open the `.dmg` and drag Hibiki into Applications as usual. If macOS still shows a warning when launching the app:

```bash
# Remove quarantine from the installed app
xattr -cr /Applications/Hibiki.app
```

Alternatively, you can **right-click** the app in Applications, click **Open**, then click **Open** again in the dialog — macOS remembers your choice after the first time.

### Windows — SmartScreen Warning

Hibiki is not currently code-signed, so Windows SmartScreen may show a warning when you run the installer:

1. Click **More info**
2. Click **Run anyway**

### Linux

No special steps needed. For `.AppImage` files, make them executable first:

```bash
chmod +x Hibiki_*.AppImage
./Hibiki_*.AppImage
```

For `.deb` packages:

```bash
sudo dpkg -i hibiki_*.deb
```

### First Launch

You'll need a running Plex Media Server with a music library. On first launch, open Settings and enter your server URL (e.g. `https://192.168.1.100:32400`) and your [Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), or sign in with Plex.tv OAuth.

## Building from Source

```bash
git clone https://github.com/karbowiak/hibiki.git
cd hibiki
bun install --frozen-lockfile
```

```bash
bun run tauri dev   # development
bun run tauri build # production bundle
```

## Project Structure

```
.
├── src/                           # React/TypeScript frontend
│   ├── components/
│   │   ├── Pages/                 # Full-page views (Home, Artist, Album, Playlists, Search, Radio, Podcasts, …)
│   │   ├── Player.tsx             # Playback bar
│   │   ├── SideBar.tsx
│   │   ├── TopBar.tsx
│   │   ├── HotkeyHelpModal.tsx    # Keyboard shortcut reference
│   │   └── LiveAnnouncer.tsx      # Accessibility live region
│   ├── audio/
│   │   └── RustAudioEngine.ts     # Tauri bridge to the native audio engine
│   ├── stores/                    # Zustand stores
│   │   ├── playerStore.ts         #   Playback state machine, crossfade, queue
│   │   ├── libraryStore.ts        #   Playlists, hubs, recentlyAdded, prefetch
│   │   ├── eqStore.ts             #   10-band EQ state & presets
│   │   ├── radioStreamStore.ts    #   Internet radio streams
│   │   ├── sleepTimerStore.ts     #   Sleep timer
│   │   ├── visualizerStore.ts     #   Visualizer settings & presets
│   │   └── …                      #   More (accent, font, theme, compact, custom colors, …)
│   ├── backends/plex/             # Plex backend
│   │   ├── provider.ts            #   MusicProvider implementation
│   │   ├── connectionStore.ts     #   Server connection & settings
│   │   ├── websocket.ts           #   Real-time Plex notifications
│   │   └── …                      #   API, mappers, image URL, types
│   ├── metadata/                  # Metadata providers (enrichment, not playback)
│   │   ├── apple/                 #   iTunes image fallback
│   │   ├── deezer/                #   Artist images, genres, fan counts
│   │   └── lastfm/                #   Scrobbling, now-playing, love/unlove
│   ├── i18n/                      # Internationalization
│   ├── hooks/                     # Custom hooks (hotkeys, media image, reduced motion, …)
│   ├── lib/                       # Utilities (image URL, ICY parser, app menu)
│   └── types/                     # TypeScript interfaces
│
└── src-tauri/src/                 # Rust backend
    ├── main.rs                    # App setup, state, command registrations
    ├── commands.rs                # #[tauri::command] handlers
    ├── audio_engine/              # Native decode, playback, crossfade, DSP, loudness, FFT
    │
    ├── plex/                      # Plex API client
    │   ├── client.rs              #   HTTP client with retry/backoff
    │   ├── models.rs              #   Serde data types (Track, Album, Artist, Playlist, …)
    │   ├── library.rs             #   Browse sections, search, tags, on_deck, recently_added
    │   ├── playlist.rs            #   Playlist CRUD + smart playlists
    │   ├── playqueue.rs           #   PlayQueue management
    │   ├── discovery.rs           #   Hubs & recommendations
    │   ├── history.rs             #   Playback tracking & scrobbling
    │   ├── collection.rs          #   Collections & favorites
    │   ├── audio.rs               #   Sonic similarity, track/artist radio
    │   ├── lyrics.rs              #   Synced & plain lyrics
    │   ├── streaming.rs           #   Stream URL builders
    │   ├── server.rs              #   Server identity & info
    │   └── auth.rs                #   Settings persistence
    │
    ├── db/                        # Local SQLite database
    │   ├── schema.rs              #   Migration runner
    │   ├── kv.rs                  #   Key-value store
    │   ├── artists.rs             #   Artist CRUD + locations + tags
    │   ├── albums.rs              #   Album CRUD + tags + reviews
    │   ├── tracks.rs              #   Track CRUD + media chain + lyrics
    │   ├── playlists.rs           #   Playlist CRUD + membership
    │   └── migrations/            #   SQL migration files
    │
    ├── itunes_throttle.rs         # iTunes rate limiter
    ├── podcast.rs                 # Podcast RSS feed parser
    ├── podcastindex.rs            # Podcast Index API
    ├── radiobrowser.rs            # radio-browser.info API
    ├── mediasession.rs            # OS media key integration (souvlaki)
    └── plextv.rs                  # Plex.tv OAuth authentication
```

## Running Tests

```bash
bun run build      # TypeScript checks and production frontend build
bun run test:frontend # Frontend regressions with synthetic data
bun run test:unit  # Rust unit tests; no Plex server required
```

Builds require Bun, a stable Rust toolchain, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Set `PI_KEY` and `PI_SECRET` for Podcast Index, or use empty values when testing without that integration. `bun run test` also runs the live Plex integration tests, which require `PLEX_URL` and `PLEX_TOKEN` and can modify the server's playlists and playback history.

The renderer security check builds production assets and exercises MilkDrop, radio playback and pause, artwork, fonts, Plex notification WebSockets, and CSP enforcement in isolated Chromium and WebKit profiles:

```bash
bunx --no-install playwright install chromium webkit
bun run test:renderer
```

On Linux, install browser system dependencies with `playwright install --with-deps chromium webkit`. To use an existing Chrome binary with a fresh test profile, set `HIBIKI_CHROME_CHANNEL=chrome`. The fixture supplies synthetic font, image, media, and IPC responses; it does not use saved browser sessions or Plex servers. Screenshots are saved under `.tmp/renderer-checks/`.

Production CSP blocks inline and remote scripts, frames, objects, injected base URLs, and form submissions. MilkDrop's bundled preset compiler requires `unsafe-eval`; inline styles support the current dynamic UI styling. HTTP(S) artwork and streams and WS(S) Plex notifications remain supported, and Circular fonts use the existing `encore.scdn.co` origin. Development CSP additionally permits the Vite React refresh preamble; the WebSocket rules also support local hot reload. Tauri's automatic script nonce/hash handling remains enabled.

On Linux, CI builds a debug AppImage and validates its relocated desktop entry, icons, AppStream metadata, embedded update channel, and `.zsync` companion. Release builds validate the same properties again from the uploaded draft assets before publication:

```bash
# Requires appstream, desktop-file-utils and zsync from your distribution.
python3 scripts/check-appimage.py --prepare-zsync src-tauri/target/release/bundle/appimage/*.AppImage
```

The Linux before-bundle hook generates `app.hibiki.client.metainfo.xml` with the package version, source commit date, MIT license, `Hibiki.desktop` launchable and repository screenshots. Tauri includes it in AppImage, DEB and RPM packages. `appstreamcli validate --no-net` is mandatory for AppImages.

AppImage bundling embeds `gh-releases-zsync|karbowiak|hibiki|latest|Hibiki_*_amd64.AppImage.zsync` before Tauri signs the installer. The companion is generated from the final installer without changing its bytes, uploaded with it, and checked against the complete SHA-1 and every rolling/MD4 block checksum. AppImageUpdate's delta-update metadata supplements the application's cryptographically verified Tauri updater; it does not replace updater signatures.

Tauri CLI 2.12.1 also fixes the absolute icon and desktop symlinks reported by the [AppImage catalogue](https://github.com/AppImage/appimage.github.io/pull/7937). The catalogue entry is merged; version 0.6.0 includes the new AppStream metadata and AppImageUpdate companions.

Release tags must point to a commit with successful CI from a push to `main`. If CI is still running, wait for it to pass and retry the release workflow with the existing tag. Packaging uses that exact commit, and a changed tag or newer failed CI run blocks publication. Existing drafts can be resumed; published versions cannot be rebuilt, even when a stale draft shares their tag.

Before publishing, `scripts/check-release.cjs` checks all macOS ARM/Intel, Linux and Windows updater targets, the matching release URLs and uploaded installers. Beginning with 0.6.0, this includes all nine installers: the seven updater bundles and both macOS DMGs. macOS verifies each disk image with `hdiutil` before signing it; publication verifies every installer's complete streamed BLAKE2b-512 digest and minisign signature, including the signed comment and uploaded `.sig` companion. Signatures bind the release version, and DMG signatures also bind the exact filename. The application requires version-bound update signatures. Historical release verification remains compatible. This signing is separate from Apple notarization and Windows code signing described above.

The dependency refresh keeps Tailwind 3 and the current native audio APIs. `bun audit` still reports [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) in Tailwind's build-time `braces` dependency; no patched version is available. The selector-parser override uses the patched 7.1.6 release, and Vite 8 removes the affected esbuild dependency.

The unused `ringbuf` dependency was removed to clear [RUSTSEC-2026-0293](https://rustsec.org/advisories/RUSTSEC-2026-0293.html). `cargo audit` still warns about [glib's VariantStrIter](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) and [unmaintained proc-macro-error](https://rustsec.org/advisories/RUSTSEC-2024-0370.html), both pulled in by Tauri's GTK 3 stack. The current Tauri release still uses glib 0.18; replacing it with glib 0.20 requires a compatible upstream GTK/Tauri update.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
