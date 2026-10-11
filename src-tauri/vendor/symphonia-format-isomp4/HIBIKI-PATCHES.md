Upstream: symphonia-format-isomp4 0.5.5, Project Symphonia commit `6d533f26150953a882a6a111ebd13f0abf7129d5`. Source headers and MPL-2.0 license are retained.

Hibiki changes in `demuxer.rs`:

- A seekable spool can have an incomplete or unknown extent; do not reject a known front-indexed movie solely because its total byte length is unavailable.
- Stop initial scanning at media data once the file type and movie index are parsed. Incremental segment reading handles the remaining stream; optional tail metadata must not delay first playback. Movies with their index at the tail still require reading that index.

The application prefix-streaming regression compares front-indexed AAC output with cached decoding, without requiring the full body before the first PCM batch.
