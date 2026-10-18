These fixtures are generated tones at 48 kHz. They contain no recordings or user media. The stereo AAC fixtures use 431 Hz on the left and 719 Hz on the right.

AAC-LC (FFmpeg's native AAC encoder):

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.25*sin(2*PI*431*t)|0.2*sin(2*PI*719*t):s=48000:d=1.5' -c:a aac -b:a 128k -map_metadata -1 aac-lc-stereo.m4a
```

HE-AAC (macOS AudioToolbox; numeric profile 4 selects HE-AAC):

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.25*sin(2*PI*431*t)|0.2*sin(2*PI*719*t):s=48000:d=1.5' -c:a aac_at -profile:a 4 -b:a 64k -map_metadata -1 he-aac-stereo.m4a
```

HE-AACv2 adds parametric stereo (numeric profile 28):

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.25*sin(2*PI*431*t)|0.2*sin(2*PI*719*t):s=48000:d=1.5' -c:a aac_at -profile:a 28 -b:a 32k -map_metadata -1 he-aac-v2-stereo.m4a
```

The checked-in encoded bytes keep codec regressions independent of FFmpeg availability or encoder variations on CI. Tests compare repeated seeks with a freshly initialized decoder and with continuous decoding of the same fixture.

5.1 AAC-LC uses the same independently identifiable speakers as the surround Opus fixture:

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.2*sin(2*PI*211*t)|0.2*sin(2*PI*307*t)|0.2*sin(2*PI*401*t)|0.2*sin(2*PI*79*t)|0.2*sin(2*PI*503*t)|0.2*sin(2*PI*607*t):s=48000:d=1.5:c=5.1' -c:a aac -b:a 320k -map_metadata -1 aac-surround.m4a
```

The ADTS versions preserve the encoded access units while changing the container:

```sh
ffmpeg -i aac-lc-stereo.m4a -c copy -f adts aac-lc-stereo.aac
ffmpeg -i he-aac-stereo.m4a -c copy -f adts he-aac-stereo.aac
ffmpeg -i he-aac-v2-stereo.m4a -c copy -f adts he-aac-v2-stereo.aac
```

Changing stereo chirps also exercise HE-AACv2 stereo parameters beyond steady tones:

```sh
ffmpeg -f lavfi -i 'aevalsrc=(0.15+0.10*sin(2*PI*2.3*t))*sin(2*PI*(431*t+50*t*t))|(0.12+0.08*cos(2*PI*1.7*t))*sin(2*PI*(719*t+30*t*t)):s=48000:d=3' -c:a aac_at -profile:a 28 -b:a 32k -map_metadata -1 he-aac-v2-changing-stereo.m4a
```

AAC regressions verify named 5.1 channels, first-packet output rates/layouts, finite PCM, bounded invalid-input rejection, reset recovery, prefix streaming, and forward/backward seeks before and after initial decoding. The ADTS reader preserves the header's profile and recognizes MPEG-2/MPEG-4 with or without CRC bytes; it does not verify CRCs or currently accept PCE layouts and multi-block ADTS frames. These unsupported variants fail explicitly rather than being decoded with an assumed stereo AAC-LC configuration.

AAC-LC/HE-AAC seeks discard 160 ms of decoded history. Parametric stereo needs earlier delta-coded spatial parameters, so its worker rebuilds state from the beginning before returning the target samples. This can take longer on long tracks, and the decode loop checks cancellation/new seeks between packets. The changing-chirp fixture verifies that a shorter fixed preroll is insufficient; another regression interrupts that replay and replaces it with a backward seek.

Stereo and 5.1 Opus:

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.2*sin(2*PI*431*t)|0.15*sin(2*PI*719*t):s=48000:d=1.5' -c:a libopus -b:a 128k -map_metadata -1 opus-stereo.ogg
ffmpeg -f lavfi -i 'aevalsrc=0.2*sin(2*PI*211*t)|0.2*sin(2*PI*307*t)|0.2*sin(2*PI*401*t)|0.2*sin(2*PI*79*t)|0.2*sin(2*PI*503*t)|0.2*sin(2*PI*607*t):s=48000:d=1.5:c=5.1' -c:a libopus -b:a 320k -map_metadata -1 opus-surround.ogg
ffmpeg -f lavfi -i 'sine=frequency=431:sample_rate=48000:duration=0.25' -c:a libopus -b:a 64k -map_metadata -1 opus-mono-short.ogg
```

The surround frequencies identify FL, FR, center, LFE, rear left, and rear right independently of the decoder's channel mapping. The short mono file has only one audio page, exposing initial-delay versus final-padding errors. Tests modify header gain/pre-skip and recompute the Ogg CRC; seek output is compared with linear decoding at the requested PCM offset.

The prefix-streaming corpus uses the same stereo source with FLAC, MP3, native Vorbis, and a front-indexed AAC container:

```sh
ffmpeg -f lavfi -i 'aevalsrc=0.2*sin(2*PI*431*t)|0.15*sin(2*PI*719*t):s=48000:d=1.5' -c:a flac -map_metadata -1 flac-stereo.flac
ffmpeg -f lavfi -i 'aevalsrc=0.2*sin(2*PI*431*t)|0.15*sin(2*PI*719*t):s=48000:d=1.5' -c:a libmp3lame -b:a 192k -map_metadata -1 mp3-stereo.mp3
ffmpeg -f lavfi -i 'aevalsrc=0.2*sin(2*PI*431*t)|0.15*sin(2*PI*719*t):s=48000:d=1.5' -c:a vorbis -strict experimental -b:a 128k -map_metadata -1 vorbis-stereo.ogg
ffmpeg -i aac-lc-stereo.m4a -c copy -movflags +faststart -map_metadata -1 aac-lc-faststart.m4a
```

Both declared-length and chunked-style sources must produce their first batch before the remaining bytes arrive, then yield the same full PCM as cached decoding.

`opus-stereo.webm` remuxes the same generated stereo Opus packets, without
re-encoding, to exercise YouTube's WebM path and forward/backward decoder seeks:

```sh
ffmpeg -i opus-stereo.ogg -c copy -map_metadata -1 opus-stereo.webm
```
