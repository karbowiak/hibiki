Upstream: `symphonia-bundle-flac 0.6.1`, Project Symphonia commit `ee35874b571a35a9a6e15d3bc9a3aaf8f11fbeee`. Original headers, manifests and MPL-2.0 license are retained.

`parser.rs`: recognize a trailing 128-byte ID3v1 tag after the final FLAC frame. Only accept the boundary when the preceding frame has a valid CRC16, valid header/sequence, and ends at STREAMINFO's declared sample count when available. This preserves the short final block during cached and progressive playback. Invalid or truncated audio retains the original error/warning path.

Application regressions in `audio_engine/deck/decode.rs` compare tagged cached/prefix-streamed PCM against the untagged fixture and reject truncated/corrupt tagged tails. Never replace this with a blanket log filter.
