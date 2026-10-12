# Metadata and artwork

Hibiki keeps Plex as the library and playback backend. Metadata sources enrich
that library; they do not rename its items or create library entries automatically.

## Sources

| Source | Artist metadata | Album metadata | Artwork |
|---|---|---|---|
| Plex | Library name, description, genres | Library name, description, date, tags | Poster and background are separate |
| Deezer | Image, fan count, link | Genres, label, date, fan count, link | Artist images and album covers |
| Apple / iTunes Search | Genre and link | Genre, date, track count, link | Album covers |
| Last.fm | Biography, tags, listeners, plays, similar artists | Description and tags | Existing library artwork is preferred |
| MusicBrainz | Identifier, type, origin, tags, dates, links | Identifier, date and tags | Identity anchor for other sources |
| Wikidata | Short description and Wikipedia link | — | — |
| Cover Art Archive | — | — | Approved front covers for a verified MusicBrainz release group |
| Fanart.tv | — | — | Multiple artist portraits/backgrounds and matched album covers; project API key required |
| HeyaMetadata | Canonical biography, genres, tags and type | Canonical description, genres, tags and date | Canonical image references from the configured server |
| SoulSync | Library biography and matched supplemental metadata | Not supported by this adapter yet | Not supported by this adapter yet |

Wikidata descriptions are short identity descriptions, not biographies. Sources
that aggregate other providers keep the underlying field provenance visible.
The Apple adapter uses the public iTunes Search API, not Apple Music subscription
access. Last.fm also contributes track descriptions, tags and listening counts.

## Choices and matching

Settings controls the global source order. An item's **Edit metadata and sources**
dialog can override individual fields. Returning a field to **Automatic** restores
that order. Choices belong to the current account/library and stable item ID, so
an item rename keeps its preferences.

Exact returned names, album artist credits and supported identifiers are checked
before using enrichment. Ambiguous records stay unavailable for automatic
selection. Name matching alone cannot prove which artist with the same name was
intended; the dialog exposes that limitation rather than inventing confidence.
MusicBrainz identifiers anchor Wikidata, Cover Art Archive and Fanart lookups.
Heya verifies a known identifier in both its search result and canonical detail,
or requires one exact artist/title match when no identifier is available.

Poster and Background have independent preferences. A selected image stores its
source and opaque candidate ID, never a credential or an arbitrary image URL.
The ID must still appear in the current source response before it can be used.
Background choices distinguish actual background art from reused portraits/covers.
**Refresh choices** checks source metadata; **Refresh image** invalidates the
selected image's cached bytes. Both operations leave unrelated images cached.

## Optional configured sources

Fanart.tv, HeyaMetadata and SoulSync are optional desktop integrations configured
in Settings. Server URLs and public configuration revisions can reach the UI;
API keys remain in private native settings files. Changing a protected server URL
or path requires entering its key again. Disabling or changing a source retires
pending lookups and rejects old cached results. Credentials are sent in headers,
with automatic redirects disabled.

The editor only offers configured, enabled optional sources. Last.fm also needs
its configured API key. Missing matches and temporary network errors do not hide
an otherwise configured source, and hiding a disabled service preserves its saved
item preferences for later use.

HeyaMetadata uses canonical search and detail GETs. Normal stale reads and image
GETs can cause Heya to refresh/materialize data internally. Hibiki does not submit
new-entity discovery, catalog changes or download requests. Its artwork follows
verified opaque image references through Hibiki's managed image cache; the UI
does not receive a private server credential.

SoulSync uses its existing library API. Its `/api/v1/request` endpoint schedules
downloads and is deliberately separate from metadata lookup.

## Editing Plex

The dialog currently edits artist/album titles and descriptions, album release
dates, and editable playlist titles/descriptions. Source and artwork choices are
local Hibiki preferences. Selecting external text for a Plex description only
fills the draft; a separate review and save are required to write it.

Before saving, the native artist/album writer verifies the current library,
entity type and changed-field baseline, then sends one scoped update without
automatic retries. Saved Plex fields are locked against metadata refresh.
Preflight conflict detection is not a server-side atomic compare-and-swap: a
concurrent change can still race the request. A timeout or unconfirmed result
requires reloading the current values before another save. Account changes retire
the dialog and prevent a late response from changing another library's UI.

## Extending the system

`core/types.ts` defines field capabilities, snapshots, identity, provenance and
lookup outcomes. `core/existingProviders.ts` registers adapters; transports own
their request budgets and credentials. `useMetadataSnapshot` retires work on
account/source changes. Page consumers resolve fields through the same interface.
Artwork hooks additionally own candidate membership, failure fallback and scoped
cache revisions.

Additional keyed providers, Heya discovery/ambiguity selection, the full Plex
poster/background inventory and additional editable fields remain separate work.
Playlist integration is described in [the playlist-copy guide](../playlistSync/README.md).
