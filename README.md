# Plexify

A Spotify-inspired desktop music client for [Plex](https://www.plex.tv/), built with Tauri 2 and React 19. Browse your library, play tracks with a native audio engine, manage playlists, explore radio & DJ modes, discover podcasts, scrobble to Last.fm, enjoy visualizers, and more — all from a fast, frameless desktop app.

> Frontend layout and design based on [tauri-spotify-clone](https://github.com/agmmnn/tauri-spotify-clone) by [@agmmnn](https://github.com/agmmnn).

## Features

### Playback
- Native Rust audio engine (Symphonia) — FLAC, MP3, AAC, ALAC, Ogg Vorbis, WAV, PCM
- Gapless playback + crossfade with 3 curve options
- 10-band parametric EQ with built-in presets
- ReplayGain / album gain normalization
- Output device selection
- BPM analysis
- Audio disk cache for instant replay
- Sleep timer

### Radio & Discovery
- Track Radio, Artist Radio, Plex Stations
- 6 DJ modes — Stretch, Gemini, Freeze, Twofer, Contempo, Groupie
- Internet radio via radio-browser.info

### Podcasts
- iTunes + Podcast Index search
- Top charts by category
- Subscribe & play episodes

### Visualizer
- **Compact** — waveform, spectrum, oscilloscope, VU meter
- **Fullscreen** — spectrum, oscilloscope, VU, starfield, Milkdrop (butterchurn)
- 555 Milkdrop presets with browser, favorites, and auto-cycle

### Library
- Home hubs & recommendations
- Smart playlists with infinite scroll + virtual scrolling
- Liked tracks, albums, and artists
- Tag / genre browsing
- Draggable sidebar playlists
- Full-text search across tracks, albums, and artists

### Metadata & Integrations
- **Last.fm** — scrobble, now-playing, love/unlove, metadata augment or replace mode
- **Deezer** — artist images, album covers, genres, fan counts
- **iTunes** — image fallback
- Synced lyrics display

### Image Caching
- Custom `image://` URI scheme with on-disk cache
- Multi-provider fallback: Plex → Deezer → iTunes

### Appearance
- 9 accent colors + custom hex picker
- Dark / light theme
- Font selection
- Card size slider
- Easter eggs

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
| State | Zustand v5 (28 stores) |
| Desktop shell | Tauri v2 |
| Backend | Rust (140 Tauri commands) |
| Audio decode | Symphonia 0.5 (FLAC, MP3, AAC, ALAC, Ogg, WAV, PCM) |
| Audio output | cpal 0.15 (CoreAudio / WASAPI / ALSA) |
| Audio resampling | rubato |
| Media keys | souvlaki |
| Database | rusqlite (SQLite, WAL mode) |
| Visualizer | butterchurn (Milkdrop) |
| Drag-and-drop | dnd-kit |
| Icons | Tabler Icons |
| Package manager | Bun |

## Download & Install

Grab the latest release for your platform from the [Releases page](https://github.com/karbowiak/plexify/releases).

| Platform | File | Notes |
|---|---|---|
| **Windows** | `.exe` (NSIS installer) | Run the installer and follow the prompts |
| **macOS (Apple Silicon)** | `.dmg` (aarch64) | Drag Plexify into Applications |
| **macOS (Intel)** | `.dmg` (x86_64) | Drag Plexify into Applications |
| **Linux** | `.AppImage` / `.deb` | See below |

### macOS — Security Warning

Plexify is not currently code-signed or notarized with Apple, so macOS Gatekeeper will block it. Run this in Terminal after downloading to remove the quarantine flag:

```bash
# Remove quarantine from the downloaded .dmg
xattr -cr ~/Downloads/Plexify_*.dmg
```

Then open the `.dmg` and drag Plexify into Applications as usual. If macOS still shows a warning when launching the app:

```bash
# Remove quarantine from the installed app
xattr -cr /Applications/Plexify.app
```

Alternatively, you can **right-click** the app in Applications, click **Open**, then click **Open** again in the dialog — macOS remembers your choice after the first time.

### Windows — SmartScreen Warning

Plexify is not currently code-signed, so Windows SmartScreen may show a warning when you run the installer:

1. Click **More info**
2. Click **Run anyway**

### Linux

No special steps needed. For `.AppImage` files, make them executable first:

```bash
chmod +x Plexify_*.AppImage
./Plexify_*.AppImage
```

For `.deb` packages:

```bash
sudo dpkg -i plexify_*.deb
```

### First Launch

You'll need a running Plex Media Server with a music library. On first launch, open Settings and enter your server URL (e.g. `https://192.168.1.100:32400`) and your [Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), or sign in with Plex.tv OAuth.

## Building from Source

```bash
git clone https://github.com/karbowiak/plexify.git
cd Plexify
bun install
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
│   │   ├── Pages/                 # Full-page views (Home, Artist, Album, Playlist, Search, Radio, Podcasts, …)
│   │   ├── Player.tsx             # Playback bar
│   │   ├── SideBar.tsx
│   │   └── TopBar.tsx
│   ├── stores/                    # 28 Zustand stores
│   │   ├── playerStore.ts         #   Playback state machine, crossfade, queue
│   │   ├── libraryStore.ts        #   Playlists, hubs, recentlyAdded, prefetch
│   │   ├── connectionStore.ts     #   Server connection & settings
│   │   ├── eqStore.ts             #   10-band EQ state & presets
│   │   ├── radioStreamStore.ts    #   Internet radio streams
│   │   ├── sleepTimerStore.ts     #   Sleep timer
│   │   ├── visualizerStore.ts     #   Visualizer settings & presets
│   │   └── …                      #   21 more (accent, font, theme, search, ui, …)
│   ├── backends/                  # Provider abstraction layer
│   │   ├── registry.ts            #   Provider registry (Plex, Last.fm, Deezer, Apple, Podcast)
│   │   ├── types.ts               #   Backend interfaces
│   │   └── init.ts                #   Bootstrap
│   ├── lib/
│   │   └── plex.ts                # TypeScript wrappers around Tauri invoke() commands
│   └── types/
│       └── plex.ts                # TypeScript interfaces mirroring Rust models
│
└── src-tauri/src/                 # Rust backend
    ├── main.rs                    # App setup, state, 140 command registrations
    ├── commands.rs                # All #[tauri::command] handlers
    │
    ├── plex/                      # Plex API client (14 modules)
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
    ├── audio/                     # Native audio engine (14 modules)
    │   ├── engine.rs              #   AudioEngine — orchestrates decode + output threads
    │   ├── decoder.rs             #   HTTP fetch → Symphonia decode → ringbuf
    │   ├── output.rs              #   cpal output stream (CoreAudio/WASAPI/ALSA)
    │   ├── crossfade.rs           #   Crossfade with 3 curve options
    │   ├── eq.rs                  #   10-band parametric equalizer
    │   ├── normalization.rs       #   ReplayGain / album gain
    │   ├── resampler.rs           #   Sample-rate conversion (rubato)
    │   ├── analyzer.rs            #   Audio analysis (waveform, spectrum)
    │   ├── bpm.rs                 #   BPM detection
    │   ├── cache.rs               #   Disk-backed audio cache
    │   ├── state.rs               #   Shared playback state
    │   ├── commands.rs            #   Audio Tauri commands
    │   └── types.rs               #   AudioCommand / AudioEvent enums
    │
    ├── db/                        # Local SQLite database (7 modules)
    │   ├── schema.rs              #   Migration runner
    │   ├── kv.rs                  #   Key-value store
    │   ├── artists.rs             #   Artist CRUD + locations + tags
    │   ├── albums.rs              #   Album CRUD + tags + reviews
    │   ├── tracks.rs              #   Track CRUD + media chain + lyrics
    │   ├── playlists.rs           #   Playlist CRUD + membership
    │   └── migrations/            #   SQL migration files
    │
    ├── lastfm.rs                  # Last.fm API (scrobble, love, metadata)
    ├── deezer.rs                  # Deezer public API (images, genres, fan counts)
    ├── itunes.rs                  # iTunes Search API (image fallback)
    ├── itunes_throttle.rs         # iTunes rate limiter
    ├── podcast.rs                 # Podcast RSS feed parser
    ├── podcastindex.rs            # Podcast Index API
    ├── radiobrowser.rs            # radio-browser.info API
    ├── mediasession.rs            # OS media key integration (souvlaki)
    └── plextv.rs                  # Plex.tv OAuth authentication
```

## Running Tests

The test suite includes 28 SQLite unit tests and 52 Plex integration tests. Integration tests hit a live Plex server — set your server address in `src-tauri/src/plex/` test helpers before running.

```bash
bun run test
# or directly:
cd src-tauri && cargo test
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
