# Explicit playlist copies

Supported integration: ListenBrainz list/read and private create-copy import/export through the current native account. Last.fm playlist APIs are **unsupported**, as stated in its [official playlist documentation](https://www.last.fm/api/playlists). Copy workflows remain independent from the explicitly enabled linked synchronization below.

[ListenBrainz API](https://listenbrainz.readthedocs.io/en/latest/users/api/playlist.html) uses JSPF recording identifiers. [The actual server validator](https://github.com/metabrainz/listenbrainz-server/blob/master/listenbrainz/webserver/views/playlist_api.py) additionally requires a `public` extension. Copies always send `public: false`. No collaborators or third-party service credentials are accepted. Remote descriptions/artwork are not copied; title and ordered recording identifiers are. Ordinary tests use synthetic transports; the explicitly reviewed, ignored live QA runner operates only on its freshly created disposable playlists.

## UI contract

1. Capture `listenBrainzPlaylistAdapter(await nativeListenBrainzPlaylists.account())` and `providerPlaylistAdapter(provider)`. Keep a view ownership predicate covering the provider reference, scope/session, and authenticated account.
2. Read the selected source. Preview `planPlaylistCopy(source, targetAccount, {direction, title, candidates})`.
3. Show all ordered rows, including duplicates. Imports use exact MBID or conservative metadata matching; ambiguous/missing matches block admission. Exports require recording MBIDs. Explicitly reviewed rows can be resolved with `resolvePlaylistOccurrence`; never silently omit an unavailable track. An existing best-match MusicBrainz lookup alone is not proof that it identified the exact recording.
4. Only after explicit user approval, run `executePlaylistCopy(new PlaylistCopyApproval(plan), sourceAdapter, targetAdapter, playlistAttemptJournal, isCurrent)`. One approval cannot be submitted twice. Both accounts and source content are checked again before admission.
5. Refresh the current destination list only if the view still owns its connection. Server order/duplicate loss leaves a `reconcile` receipt. A copy cannot be called successful until full ordered identities and title are verified.

Plex's current URI-based create path collapses repeated track IDs. Imports whose
resolved Plex IDs repeat are disabled before approval is consumed, receipts are
written or a playlist is created. Every occurrence remains visible in the preview;
Hibiki never silently removes repeats. ListenBrainz exports retain repeated
recording IDs. Unknown adapters keep their existing behavior and still require
full ordered post-read proof.

Live QA also found singleton append left an existing repeated ID unchanged on the
tested server. Future work: investigate documented play-queue-based creation and
require actual ordered proof plus durable destination/step receipts before enabling
duplicate imports. Neither [Plex's API](https://developer.plex.tv/pms/) nor
[PythonPlexAPI's playlist implementation](https://python-plexapi.readthedocs.io/en/latest/_modules/plexapi/playlist.html)
documents a duplicate-preserving create flag; no unsupported query flag is sent.

The limit is 1,000 occurrences per playlist and 100 records per page. Automatic import previews check at most 30 distinct artist/title queries with three concurrent requests and at most 50 candidates per query; remaining rows use explicit bounded local searches. They never scan all library tracks. This limit is explicit; larger playlists are rejected rather than truncated. Local page gaps, repeated occurrence IDs, changing totals and unavailable account scopes reject the preview. Neither service offers a cross-service atomic read-and-create transaction: admission checks happen before the write, and the copy uses precisely the reviewed frozen input. A source edit after admission cannot be silently merged into that copy.

## Retention/recovery

IndexedDB must acknowledge a token-free `admitting` receipt before a remote create. On remote timeout or malformed acknowledgement, the original receipt remains `reconcile`; no blind retry occurs. A new identical unknown copy is blocked across reconnects/restarts. At most 64 unresolved receipts are admitted, and 32 settled receipts are retained. Unknown receipts are never evicted.

`PlaylistCopyError.attempt` retains a known destination ID even when local storage fails after creation. Keep the view open and retry `playlistAttemptJournal.save(error.attempt)`; do not re-create the remote playlist. `reconcilePlaylistAttempt` explicitly reads a known or user-selected destination, checks every ordered occurrence/title under the same real account, and marks that original receipt verified. Renewed credentials for the same account can inspect it; another account cannot. Reconciliation never submits remote writes. An unknown/no-ID receipt may also be explicitly dismissed locally after an unchecked-by-default acknowledgement that the copy may already exist and retrying may create a duplicate. `dismissUnknownPlaylistAttempt` verifies the current real account and authentication revision before saving the original receipt as `dismissed`, with reason, timestamp and reviewed-account provenance. It never deletes the receipt/remote playlist or retries a create. Failed local dismissal retention leaves the unknown blocker in place and can be retried locally. Receipts without an ID require manual destination inspection; title similarity alone cannot prove which playlist an uncertain request created.

The local adapter captures a runtime connection/session fence separately from the stable opaque account/server/library scope used in retained receipts. ListenBrainz uses the native private username/auth revision binding; tokens never enter plans, receipts or frontend storage. Once a request is admitted it can finish under its captured original credentials. Retired views cannot redirect it to a new login or publish its results into that login.


## Explicit linked synchronization

Updates into Plex pause for review if the desired ordered IDs contain repeats
and the current destination does not already match. Existing duplicates remain
untouched; an already equal destination can be verified without a write. This
conservative boundary also pauses reorderings of duplicate sequences. Updates
into ListenBrainz retain their existing occurrence-preserving behavior.

Linked sync is opt-in for one regular Plex music playlist and one owned ListenBrainz playlist. Preview both ordered versions, resolve every occurrence, choose initial order, and confirm enabling before retaining a link. Recording suggestions require explicit verification; duplicate occurrences remain independent. Names, descriptions, privacy, and collaborators are not synchronized.

One-sided verified changes propagate; changes on both sides pause for review. The app checks eligible links every two minutes while online, with at most 20 occurrence mutations per cycle. Each append/move/delete has a durable admission record, exact preflight, one non-retrying authenticated request, and ordered post-read proof. No playlist-wide clear or unreviewed replacement is used. Providers do not expose transactional compare-and-swap: an external editor can race the final preflight. This limitation is explicit, and failed postproof stops further writes as an unknown outcome.

Unknown outcomes are never blindly retried. Read recovery verifies an applied update; otherwise the user must inspect and retain the current destination before a new preview. Historical intentions remain in a bounded journal. Local retention failure stops background writes. Pause/disable stops new admissions; an already admitted request can finish and remains recoverable. Polling also stops for offline connections and retired accounts.

Links retain opaque ownership, never credentials. ListenBrainz username is durable identity, with a fresh native authentication lease for each run. Plex scope currently includes connection credentials: changing token/server/library pauses an existing link. Explicit rebind requires the original playlist to be visible in the current connection and a reviewed snapshot, retains previous scope provenance, and never rebinds an unresolved mutation. Future work: verified Plex user identity could permit safe normal token rotation without manual rebind; do not reduce ownership to server/library alone.

Limits: 16 retained links, 1,000 ordered songs per playlist, last 64 resolved step receipts per link, paged 50-item ListenBrainz browse. Disabled links remain retained. Tests use synthetic adapters and local HTTP servers only.
