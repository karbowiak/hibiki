Upstream: `symphonia-format-isomp4 0.6.1`, Project Symphonia commit `ee35874b571a35a9a6e15d3bc9a3aaf8f11fbeee`. Original source headers, manifests and MPL-2.0 license are retained.

Hibiki changes:

- `demuxer.rs`: use the optional byte extent rather than seeking to the end during initial parsing. Front-indexed playback must start before the download completes.
- Preserve the pending media-data atom at indexed EOF, so seeking after completion can read packets again.

Stopping at front-indexed `mdat` is now provided upstream. Application regressions in `audio_engine/deck/decode.rs` compare prefix playback and AAC cold/repeated/after-EOF seeking with linear PCM. Retain those checks when removing the patch.
