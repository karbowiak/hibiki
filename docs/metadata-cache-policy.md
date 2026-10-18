# Native metadata caching

Plex and YouTube Music use one native metadata store, `metadata_cache::CACHE`.
Moka 0.12 manages bounded memory caches, expiry and single-flight initialization.
SQLite stores parsed provider data and timestamps in `metadata/metadata.sqlite`
under the application cache directory. This is disposable browsing data; explicit
audio downloads, playlist history and the compact Plex matching index remain
separate.

The request flow is:

1. The client requests a provider operation.
2. The provider implementation checks its native SWR policy and shared cache.
3. A fresh entry returns immediately. A stale entry returns immediately and
   admits one background refresh. A miss waits for the upstream request.
4. Successful refreshes persist their result. Changed results notify the client;
   identical results do not. A failed refresh leaves usable stale data intact.
5. Client mappers and page controllers compose the returned provider data into
   the existing music/page models.

The TypeScript offline wrapper no longer decides online freshness or runs SWR.
Its snapshots support offline projection and network-failure fallback. Artist
and album page snapshots preserve rendered content while the native provider
answers; their assembly timestamps do not grant upstream freshness. Native
notifications update the current page without remounting it or resetting its
scroll, selection, table sort or player.

## Freshness and retention

Defaults apply only when upstream headers do not specify a restriction.
`Cache-Control`, `Age`, `Date` and `Expires` override defaults. `no-store` removes
the corresponding stored entry; `no-cache` requires a new response, and
`must-revalidate` prevents serving beyond the allowed lifetime unless an explicit
stale window is supplied. Request credentials and signed playback URLs are never
stored. Provider request methods that verify playlist writes, matching-index
evidence, downloads and play queues bypass the browse cache.

| Provider/data | Default fresh lifetime |
| --- | --- |
| Plex track, album, artist facts | 15 minutes |
| Plex lists, relationships and hubs | 2 minutes |
| Plex search | 30 seconds |
| YTM artist data, biographies and discography | 6 hours |
| YTM albums and recording metadata, recent/unknown date | 24 hours |
| YTM albums/recordings whose known years all precede the previous calendar year | 30 days |
| Other YTM collections, search and mixes | Existing operation-specific fallback, at most 15 minutes |

An old release is never permanently immutable. Freshness expiry retains a
snapshot for SWR. Total metadata retention is at most 90 days from the fetch,
subject to earlier upstream restrictions and capacity eviction. Reads preserve
the persisted fetch/freshness times across restarts. Expired retention and corrupt
or unknown-schema rows are discarded and fetched again on demand.

The shared store allows 2 MiB per entry, 2,000 entries/32 MiB per owner and
8,000 entries/128 MiB globally. SQLite evicts least recently used rows during
writes and removes expired rows on reads/writes. Moka limits retained and fresh
memory caches to 16 MiB each. No background full-library crawl is introduced.
The previous YTM JSON cache is not read by this schema; it warms from requested
pages after the upgrade. Existing explicit downloads remain independent.

## Invalidation and ownership

Plex keys include the account/server/library scope and complete query path.
YTM keys hash its native account owner, parser version, destination, parameters
and continuation. No account cookies or tokens form a serialized cache payload.
Every SQLite owner has a persistent invalidation epoch. A fetch may publish only
under the epoch it captured; invalidation during a request rejects its older
write. Connection/account revisions also fence returned data and notifications.

The existing scoped websocket path coalesces Plex scan events, including state 1
processing completion. Metadata events expire the changed entities, cached
parents and visited relationship/list summaries. Missing parents use at most
eight requested metadata lookups; overflow, deletions with unknown parents and
reconnect gaps conservatively expire visited data. Expiration retains payloads;
confirmed deletions remove the obsolete provider references and repair list
counts. Explicit downloads and Hibiki playlist history are unaffected.

Background provider refreshes share Butler's two-slot refresh lane, per-key admission,
retry delays and native request rate limiting. Both providers use exponential backoff with per-key jitter. YTM also retains
its shared API/extractor rate limiter. Changed Plex notifications are coalesced for 200 ms before updating
visible models. Successful local mutations retire outstanding reads and clear
affected native browse ownership before later reads. Explicit page refresh and
the existing scoped clear command also invalidate native freshness/storage.
The settings redesign and expanded usage controls remain #43 work.

## Validation evidence

Native tests cover restart/age preservation, expiry versus retention, corrupt
rows, provider/account isolation, credential rejection, count bounds, concurrent
misses, and invalidation during a delayed request. Provider tests cover YTM
likes, playlist invalidation, disconnect fencing and HTTP restrictions.

In the controlled local test, 2,001 writes with capacity enforcement took about
1.29 s, the first reopened SQLite read took 0.57 ms, and 1,000 memory reads took
1.53 ms total. These are synthetic metadata-store timings, not remote service
latency measurements. A delayed initializer test verifies that 20 simultaneous
misses issue exactly one fetch.

Moka documentation: <https://docs.rs/moka/0.12.16/moka/future/struct.Cache.html>.

## Search audio preference

Search remains Plex-first. Artist/album deduplication requires actual association
evidence; recording matching also guards edition, explicitness and duration.
Matched results retain both source identities, and actions use the selected
result's own provider identity.

YTM can replace a matched Plex recording only after a native availability/decode
probe supplies a recent actual format ID, codec and bitrate. All usable Plex
versions must be known and clearly inferior. Lossless, unknown, equal-quality,
ambiguous and truncated media evidence keep Plex. Same-codec replacement needs
at least 50% and 64 kbps improvement, with YTM at least 128 kbps; cross-codec
replacement requires YTM at least 192 kbps and Plex MP3 at most 128 kbps or other
supported lossy codecs at most 96 kbps. These deliberately wide margins are not
a universal perceptual codec ranking. At most three verified low-quality
candidates are probed serially per search, with account-scoped 30-minute proofs.

Native extraction selects the best reachable supported AAC/Opus/Vorbis audio,
checks candidate availability and reports the actual selected encoding. A new
automatic audio-cache identity prevents old forced-M4A entries pinning playback
to an inferior stream. WebM Opus has progressive-start and repeated-seek decode
tests. The vendored Symphonia MKV change restores iterator/cluster state before
each seek and avoids waiting for tail cues before progressive playback starts.
