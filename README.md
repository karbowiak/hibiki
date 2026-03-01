# Plexify

A Spotify-inspired desktop music client for [Plex](https://www.plex.tv/), built with Tauri 2 and React 19. Browse your Plex music library, play tracks with a native audio engine, manage playlists, and explore artists and albums — all from a fast, frameless desktop app.

> Frontend layout and design based on [tauri-spotify-clone](https://github.com/agmmnn/tauri-spotify-clone) by [@agmmnn](https://github.com/agmmnn).

## Features

- **Native audio engine** — Rust-based decoder (Symphonia) + CoreAudio output (cpal); supports FLAC, MP3, AAC, Ogg
- **Library browsing** — Home feed, Recently Added, Hubs/recommendations
- **Artist & Album pages** — Popular tracks, discography, singles, related artists
- **Playlists** — Browse, create, and play smart playlists with infinite scroll and virtual scrolling for large libraries
- **Search** — Full-text search across tracks, albums, and artists
- **Liked Tracks** — Quick access to your starred/rated tracks
- **Image caching** — Custom `pleximg://` URI scheme with on-disk cache for instant artwork
- **Settings persistence** — Plex server URL and token saved between sessions
- **Activity indicator** — Background prefetch progress shown in the top bar

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 + TypeScript |
| Styling | Tailwind CSS v3 |
| Routing | Wouter |
| State | Zustand v5 |
| Desktop shell | Tauri v2 |
| Backend | Rust |
| Audio decode | Symphonia 0.5 |
| Audio output | cpal 0.15 (CoreAudio) |
| Package manager | Bun |

## Getting Started

```bash
git clone <repo>
cd plexmusicclient
bun install
```

```bash
bun run tauri dev   # development
bun run tauri build # production bundle
```

You'll need a running Plex Media Server with a music library. On first launch, open Settings and enter your server URL (e.g. `https://192.168.1.100:32400`) and your [Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

## Project Structure

```
.
├── src/                     # React/TypeScript frontend
│   ├── components/
│   │   ├── Pages/           # Full-page views (Home, Artist, Album, Playlist, Search, …)
│   │   ├── Player.tsx       # Playback bar
│   │   ├── SideBar.tsx
│   │   └── TopBar.tsx
│   ├── stores/              # Zustand stores (connection, library, player, search, ui)
│   ├── lib/
│   │   └── plex.ts          # TypeScript wrappers around Tauri invoke() commands
│   └── types/
│       └── plex.ts          # TypeScript interfaces mirroring Rust models
│
└── src-tauri/src/           # Rust backend
    ├── main.rs              # App setup, Tauri state, command registration
    ├── commands.rs          # All #[tauri::command] handlers (35+ commands)
    ├── plex/                # Plex API client library
    │   ├── client.rs        # HTTP client with retry/backoff
    │   ├── models.rs        # Serde data types (Track, Album, Artist, Playlist, …)
    │   ├── library.rs       # Browse sections, search, on_deck, recently_added
    │   ├── playlist.rs      # Playlist CRUD + smart playlists
    │   ├── playqueue.rs     # PlayQueue management
    │   ├── discovery.rs     # Hubs & recommendations
    │   ├── history.rs       # Playback tracking & scrobbling
    │   ├── collection.rs    # Collections & favorites
    │   ├── streaming.rs     # Stream URL builders
    │   ├── server.rs        # Server identity & info
    │   └── auth.rs          # Settings persistence
    └── audio/               # Native audio engine
        ├── engine.rs        # AudioEngine — spawns decoder + event emitter threads
        ├── decoder.rs       # HTTP fetch → Symphonia decode → ringbuf
        ├── output.rs        # cpal CoreAudio output stream
        └── types.rs         # AudioCommand / AudioEvent enums
```

## Running Tests

Integration tests hit a live Plex server. Set your server address in `src-tauri/src/plex/` test helpers before running.

```bash
bun run test
# or directly:
cd src-tauri && cargo test
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
