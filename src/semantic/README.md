# Local semantic discovery

Local discovery uses actual normalized 384-dimensional MiniLM text embeddings and
cosine similarity. It is not a title/keyword filter and does not analyze audio.
Its evidence is the titles, descriptions, genres, moods and styles already saved
while browsing the current Plex account/server/library. Full visited detail
responses take precedence over sparse home-page cards. Unvisited music is absent.

The feature is disabled by default. The Settings action explicitly downloads and
SHA256-verifies the fixed model/tokenizer/runtime manifest (about 48 MiB). Partial
or failed downloads never count as installed, and verified assets can be reused
when retrying. Assets are public model data stored in a separate IndexedDB store;
private metadata and vectors are never uploaded. The model revision is pinned to
`751bff37182d3f1213fa05d7196b954e230abad9` and Transformers.js to `4.3.1`.

Inference runs in one lazy browser worker with remote fetching disabled. The
verified WASM binary is injected directly; executable glue comes from the bundled
same-origin package. The tokenizer limit is explicitly set and checked at 256.
Batches are at most 32 documents (indexing uses 16), the worker queue at most four,
and texts at most 12,000 characters. Logout/account/library changes terminate the
worker and retire pending index/search results.

SQLite V3 stores vectors under account/library scope + exact model + item identity
+ SHA256 metadata text revision. The native layer accepts at most 32 vectors per
write and validates that each belongs to currently cached metadata. Changed or
removed metadata excludes old vectors from search. Limits are 2,000 vectors per
scope and 8,000 globally. No legacy unscoped Plex database rows are imported.

The general English text model understands descriptions rather than music audio;
ranking quality depends on the saved metadata. Scores are similarity, not verified
facts about a song. Keyword search remains separate. Reconnect to load unvisited
pages; model installation alone does not scan or download a library.

`check-semantic-discovery.ts` verifies the production download/worker in fresh
Chromium and WebKit profiles using local pinned public assets; it never downloads
models itself. Supply `HIBIKI_SEMANTIC_FIXTURE_ASSETS` with the manifest files and
`runtime.wasm`. The fixture verifies no download before consent, every integrity
check, real paraphrase ranking, normalized vectors, the long-input bound and no
unexpected inference requests.

A separate incognito macOS QA app also verified the unchanged production worker
through Tauri's packaged `tauri:` protocol, using only locally packaged, pinned
public files and synthetic descriptions. The explicit run verified all five
asset hashes, 384 dimensions, five normalized vectors, all five paraphrase
rankings and the long-input bound in 1,887 ms. No network, account data, personal
settings or audio were used. This proves packaged worker/runtime execution on
macOS; it does not claim Windows/Linux webview execution or ranking quality over
an entire personal library. The real app uses ONNX's external-WASM entry, so the
runtime is downloaded only on explicit installation, rather than also shipping a
duplicate runtime in the application bundle.

Primary implementation references:
- https://huggingface.co/docs/transformers.js/en/pipelines
- https://huggingface.co/Xenova/all-MiniLM-L6-v2
- https://sbert.net/examples/sentence_transformer/applications/semantic-search/README.html
