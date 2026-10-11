Upstream: symphonia-format-ogg 0.5.5, Project Symphonia commit `6d533f26150953a882a6a111ebd13f0abf7129d5`. Source headers and MPL-2.0 license are retained. The original normalized manifest and its source manifest are included.

Hibiki changes:

- `physical.rs`: scan two maximum-sized pages per logical stream when probing the tail, since encoder padding needs both the final and preceding granule positions.
- `logical.rs`: infer EOS padding during sequential playback when the file tail was unavailable at probe time; use explicit Opus header pre-skip rather than interpreting a short EOS page's final padding as initial delay.
- `mappings/opus.rs`: convert granules to presentation timestamps by subtracting header pre-skip; read all six bits of the code-3 frame count.
- `demuxer.rs`: seek safely while the complete byte extent is unavailable, and discover binary-seek bounds once a streaming spool finishes.

Application regressions in `audio_engine/deck/decode.rs` cover gapless duration, named surround channels, initial playback from an incomplete HTTP-length spool, and seeks before/after that spool finishes. Keep these regressions when removing this patch for a later upstream release.
