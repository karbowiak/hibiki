These fixtures are generated stereo tones, with 431 Hz on the left and 719 Hz on the right, at 48 kHz. They contain no recordings or user media.

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

The checked-in encoded bytes keep codec regressions independent of FFmpeg availability or encoder variations on CI. Tests compare repeated seeks with a freshly initialized decoder rather than requiring identical lossy output across encoder versions.
