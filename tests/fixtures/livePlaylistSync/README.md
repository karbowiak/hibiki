# Controlled live playlist QA

This ignored, test-only runner is never loaded by Hibiki or CI. Ordinary tests use a synthetic bridge. Native service credentials stay in the Rust process; the Bun driver receives a one-run loopback nonce and opaque account identities only.

Read-only `prepare`, `resolve`, and `resolve-track` modes retain a private manifest under `.tmp/linked-sync-live/<run UUID>/manifest.json`. Source candidates are limited to one 25-track page of the specifically approved Tracks playlist. Generic `mbid://` references are not treated as recordings. Exact MusicBrainz release-track relationships and canonical recording detail establish the three accepted mappings without heuristic matching.

The execute mode additionally requires `HIBIKI_QA_REVIEWED_RUN` to exactly match the reviewed UUID. Do not set it until root has reviewed the source and private manifest and authorized execution. Execute refuses manifests with existing remote IDs, prior creation intents, or a non-prepared phase. Never rerun execute after any create intent: an unconfirmed create may already exist.

Planned remote writes:

1. Create one fresh regular Plex audio playlist named `Hibiki QA <UUID>` with `[A, B, A]`. Persist its returned ID immediately, and verify the exact duplicate order and library ownership.
2. On that new playlist only, write a temporary title and disposable summary using one non-retrying request. Read and prove both values. Restore the original QA title using one request and prove it.
3. Create one fresh private ListenBrainz playlist with `[A, B, A]`; persist its ID immediately and prove creator, privacy, identity, and order.
4. Append C on Plex, then use the production linked execution planner/adapters to propagate it to ListenBrainz.
5. Move C on ListenBrainz, then propagate the new order to Plex.
6. Make one controlled append on each side and prove the production planner pauses on conflict without another automatic write.
7. Explicitly review the library sequence, apply the remaining ListenBrainz change, then deliberately suppress the verified frontend acknowledgement to exercise an unknown receipt. Reconciliation reads only and proves no second mutation.

The five driver stages perform exactly seven occurrence writes (three Plex, four ListenBrainz). No occurrence delete, remote-object delete, existing-library metadata edit, audio, playback, scrobble, or background app startup path is exposed. Every mutation has a durable private intent and current native account/settings fence; fresh GET checks selected QA name, ID, ownership, and allowed tracks. Any transport, proof, persistence, timeout, or ownership failure halts. Objects and all journal/proof evidence remain for root-reviewed cleanup. Unknown-result recovery is a simulated frontend acknowledgement loss after a real verified write, clearly distinguished from an actual network failure.

This does not prove external atomicity: services can be edited between preflight and commit. Such changes halt proof and require review; the runner never blindly retries.

The first approved live attempt exposed a production create contract defect: joining repeated complete library URIs returned a known empty playlist. The corrected contract uses one URI ending in an ordered comma-separated ID list, as current PythonPlexAPI `_create` does. That old QA object and its read-only snapshot remain retained. There is no retry/resume/recovery-write mode. `prepare-reviewed-copy` can only create a new local manifest after revalidating previously reviewed mappings and native identities; it performs no remote writes and requires a separate execute review.

The second isolated create proved the corrected URI returns `[A,B]`: this Plex server deduplicates input at creation. A separately reviewed one-time `setup-append-and-execute` path is restricted to that exact QA run, a retained known `[A,B]` snapshot, no prior setup intent, zero occurrence mutations, no metadata intent, and no LB ID. It rechecks fresh `[A,B]`, retains an unconfirmed setup intent, appends A once through the production prepare/commit/proof helper, and halts if `[A,B,A]` is not proven. It cannot replay a setup intent or resume an unknown operation. The original workflow then has an explicit budget of eight total occurrence writes (one setup + seven workflow). Ordinary create does not add hidden writes.

The separately approved setup append also returned an unchanged `[A,B]` on this server. Its request/unknown receipt and read-only snapshot are retained; that setup-append execution path has been removed. There is no duplicate-write retry. The current `prepare-distinct` mode reads only and records a new review plan for this same test-created object. `reviewed-distinct-execute` requires its own matching reviewed-run environment value, an unchanged known `[A,B]` proof, and no prior continuation intent. It retains the old setup receipt and records the explicit reviewed-not-applied decision before admitting new work.

The distinct workflow starts with `[A,B]` on the existing Plex QA playlist and one newly created private LB QA playlist. Append new C on Plex and propagate `[A,B,C]` to LB; move C to the front on LB and propagate `[C,A,B]` to Plex. Conflict uses two different reorderings, `[A,C,B]` on Plex and `[C,B,A]` on LB. The explicit recovery choice uses one move to align LB with Plex, deliberately loses only the frontend acknowledgement, and performs read-only reconciliation. This remains five stages and seven workflow mutations (three Plex/four LB), plus the already retained one failed duplicate-setup request. Server-side duplicate rejection is an observed limitation; this mode makes no duplicate-preservation claim.
