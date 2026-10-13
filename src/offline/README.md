# Scoped saved-library browsing

SQLite V2 browsing snapshots are separate from the legacy globally keyed Plex
metadata tables. A snapshot belongs to the protected account/server/library digest
and an exact method + argument key, including pagination offset/size and filters.
Repeated playlist occurrences, server totals and album alternate IDs are preserved.
The cache records only already requested pages; it performs no library-wide scan.

Online read methods save successful credential-free DTOs. Transport unavailability
can return an exact saved page while the same provider/session/library still owns
the request. Authentication/permission/not-found failures do not become cached
success. Storage failure leaves online browsing usable. Mutation, queue and playback
methods never execute from saved data. Accepted writes invalidate the relevant
cached method/item prefixes, preserving unrelated visited detail pages.

The explicit “Browse saved library” entry resets/revokes the previous connection
and asks native code to restore a trusted identity from protected saved settings.
It cannot select an arbitrary previous frontend account. Its provider reports
`isOffline=true`, `isConnected=false` and read-only capabilities; uncached pages
remain unavailable. This feature makes no cached-audio playback guarantee.

Each page is at most 1 MiB, each scope at most 2,000 pages/32 MiB, globally at most
8,000 pages/128 MiB. Writes and eviction are atomic. SQL migrations and schema
version changes commit together. DTOs exclude opaque provider data, stream URLs,
credential fields and URL credentials (including nested image source URLs).
