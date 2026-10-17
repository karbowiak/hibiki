Upstream: `symphonia-format-ogg 0.6.1`, Project Symphonia commit `ee35874b571a35a9a6e15d3bc9a3aaf8f11fbeee`. Original source headers, manifests and MPL-2.0 license are retained.

Hibiki changes:

- `physical.rs`: scan two maximum-sized pages per stream so the end probe sees both final granule positions.
- `logical.rs`: retain explicit Opus pre-skip for single-page timing. Sequential EOS padding inference is now provided upstream.
- `mappings/opus.rs`: subtract header pre-skip when converting granules to presentation timestamps; use all six bits for the code-3 frame count.
- `demuxer.rs`: seek linearly inside an incomplete spool, and discover bisection bounds when the spool finishes.

Application regressions in `audio_engine/deck/decode.rs` compare gapless duration, surround channel order, prefix streaming and cold/repeated seeks against linear PCM. A mapper unit test covers 32- and 48-frame Opus packets. Retain these checks when removing the patch.
