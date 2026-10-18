# Hibiki patch

Based on Symphonia `symphonia-format-mkv` 0.6.1 (MPL-2.0; see LICENSE).

The demuxer checkpoints the first cluster's EBML iterator state. Each seek starts
from that checkpoint, clears queued frames, and restores the old iterator,
cluster and frame queue if seeking fails. This repairs repeated/backward seeks,
including seeks after EOF and progressive streams without tail cues.

Opening a progressive source with unknown total length skips the speculative
SeekHead lookup of tail metadata. The demuxer can return its first audio packet
from the available prefix instead of waiting for the entire song.

Regression coverage lives in `src/audio_engine/deck/decode.rs` using the small
`opus-stereo.webm` fixture. It checks decoded PCM after repeated seeks against
fresh decoders and requires progressive decoding before tail bytes arrive.
