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
| SoulSync | Library biography and matched supplemental metadata | Matched library descriptions, genres, dates and label | Not supported by this adapter |
| TheAudioDB | Biography, genres, origin, dates and identifiers | Description, genres, year, label and identifiers | Verified portraits, covers and separate fanart; premium V2 key required |

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

Fanart.tv, HeyaMetadata, SoulSync and TheAudioDB are optional desktop integrations configured
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
GETs can cause Heya to refresh/materialize data internally. Automatic lookups do
not submit discovery or download requests. The separate identity editor offers
explicit discovery and candidate resolution, which can create canonical data
and jobs on that server before the user reviews and applies a local choice. Its artwork follows
verified opaque image references through Hibiki's managed image cache; the UI
does not receive a private server credential.

SoulSync uses its existing library API. Its `/api/v1/request` endpoint schedules
downloads and is deliberately separate from metadata lookup.

TheAudioDB uses its fixed official premium V2 endpoint with a private header key,
one request per second, a 60-second rate-limit cooldown and a bounded 15-second
lookup. Unique artist/title and exact returned detail identity are verified;
reviewed MusicBrainz IDs cannot fall back to names. Positive metadata is held in
a bounded memory-only six-hour cache, negative results for one minute. No key is
included in image or entity links. Public images use the managed image cache and
show TheAudioDB attribution. Config/account changes retire pending results;
unconfigured or disabled services are excluded from metadata/artwork options.

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

The editor now provides separate Plex poster/background inventories, reviewed
selection and validated raster uploads, additional supported fields/tags and
individual lock controls. Current PMS JSON `Metadata` and legacy `Photo`
inventories are supported; local resource previews are bound to the exact native
inventory choice rather than a general authenticated file-route exception.
The selected section comes from the global library roster: the section-specific
endpoint is a browsing interstitial, not a section identity record.

Identity selection explicitly searches MusicBrainz or the configured Heya server,
shows canonical names, aliases and evidence, and requires review before applying
a scoped local choice. Heya discovery is capability-gated and only starts on an
explicit user action, because discovery/resolution can create canonical service
data and jobs. Background polling is bounded; ambiguous results require selection
and exact review. Canonical choices do not rename Plex items automatically.
SoulSync also supplies conservatively matched album/track metadata without
requesting downloads. Failed or unconfirmed Plex writes require a reload rather
than an automatic retry. Playlist integration is described in
[the playlist guide](../playlistSync/README.md).

## Direct-provider review

Reviewed against primary documentation on 2026-10-13. TheAudioDB is implemented
as an optional direct adapter; Discogs, Spotify and TIDAL remain deferred. Availability through a configured Heya server
depends on that server's providers and credentials; aggregation does not remove
the original provider's attribution, licensing or retention requirements.

### Discogs

The catalogue covers artist names/notes/aliases and releases/masters with dates,
credits, labels, identifiers and track listings. Tracks are release track-list
entries, not a standalone recording identity API. Artist and release images are
available, but have different rights from catalogue text. Search requires
authentication; the official, now deprecated client documents user tokens and
OAuth 1.0a. See the [API reference](https://www.discogs.com/developers/) and
[official client documentation](https://github.com/discogs/discogs_client).

The current [API terms](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use)
classify listed catalogue facts as CC0, images as Restricted Data, require linked
attribution and an application disclaimer, prohibit displaying data more than
six hours out of date, and limit storage to what the service needs. Restricted
Data cannot be transferred to third parties or used commercially under those
terms. A text-only direct adapter is technically feasible after endpoint/auth
revalidation, release-versus-master identity review, response-header rate pacing
and six-hour freshness enforcement. Artwork and Heya redistribution need a
separate rights assessment. The developer reference returned 403 during this
review, so current numeric quotas/image-auth rules remain unverified; do not
ship assumptions from the archived client.

### Spotify

The Web API supplies artist names/images, album names/dates/covers/track lists
and track artist credits/duration/ISRC. It is not a biography or lyrics source.
See the [artist](https://developer.spotify.com/documentation/web-api/reference/get-an-artist),
[album](https://developer.spotify.com/documentation/web-api/reference/get-an-album)
and [track](https://developer.spotify.com/documentation/web-api/reference/get-track)
references. [OAuth](https://developer.spotify.com/documentation/web-api/concepts/authorization)
is mandatory; application-only catalogue access uses client credentials, which
cannot safely be embedded as a shared desktop secret.

[Development-mode restrictions](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
remove artist followers/popularity and album label/popularity; endpoint fields
must not be promised merely because extended-mode documentation lists them.
[Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
require a Premium app owner and allow five authenticated development users;
extended access has substantial organisation/scale eligibility requirements.
[Terms](https://developer.spotify.com/terms) permit only necessary temporary
metadata/cover caching, not indefinite storage. [Policy](https://developer.spotify.com/policy)
requires branding and source links and restricts content transfers.
[Artwork guidelines](https://developer.spotify.com/documentation/design) forbid
cropping and text/image overlays. Consequently, neither a direct adapter nor
Heya-derived Spotify artwork should enter Hibiki's current ambient hero/cache
pipeline without an approved use case, attribution UI and separate retention
policy. Handle rate-limit and quota-exhaustion responses distinctly.

### TIDAL

The [current public reference](https://tidal-music.github.io/tidal-api-reference/)
documents artists, biography relationships, albums, tracks and artwork resources
(including album cover art and artist profile art). Catalogue matching must
retain country context and reviewed identities rather than use private legacy
API endpoints. [OAuth 2.1 authorization](https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization)
supports client credentials for non-user resources and authorization-code flow
for user resources. A registered application and secure token lifecycle are
required.

An optional direct catalogue adapter is technically plausible, but its desktop
credential model, attribution and artwork-use policy must first be checked
against the [developer terms](https://developer.tidal.com/documentation/guidelines/guidelines-developer-terms)
and [guidelines](https://developer.tidal.com/documentation/guidelines/guidelines-developer-guidelines).
Those pages did not expose their full current text to this review tool; no
unlimited cache licence, numeric rate ceiling or permission to use art behind
Plex playback is established here. Keep this integration deferred until those
boundaries are verified; Heya is not a substitute for that verification.

### TheAudioDB

The [official API documentation](https://www.theaudiodb.com/free_music_api)
offers artist/album/track search and ID/MusicBrainz lookups, descriptive metadata
and artwork. Field completeness varies by record; verify returned MBIDs and
artist credits before projecting biographies, genre/style or images. V1 puts
the key in the URL; premium V2 uses a header and is the maintained API. Documented
budgets are 30/100/120 requests per minute for free/premium/business, with a
one-minute wait after exceeding them.

[Terms](https://www.theaudiodb.com/docs_terms_of_use.php) permit API content reuse
and modification subject to retained notices, require source attribution for
paid custom artwork, and require a paid subscription for app-store publication.
They do not specify an unlimited retention licence or a numeric cache TTL.
The optional direct adapter uses a user-configured native premium key, V2 GET-only
transport, conservative gate/backoff, bounded identity-verified fields/images,
linked provenance and bounded freshness/eviction. Protocol tests use local servers;
live account-tier verification requires a configured premium key. Heya aggregation can avoid duplicate key management
when its configured provider supplies these fields with usable provenance.

Before enabling any of these sources, add capability/configuration gating,
reviewed-ID matching, account/service-revision retirement, provider-specific
retention/attribution and offline fixtures for ambiguity, 401/403, 429 and stale
responses. Do not expose an unsupported source tile or automatically reuse
another application's credentials.
