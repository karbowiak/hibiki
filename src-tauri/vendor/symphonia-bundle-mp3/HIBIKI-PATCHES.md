# symphonia-bundle-mp3 0.5.5

Source: published Project Symphonia 0.5.5. Original source headers, manifest and
MPL-2.0 license are retained.

`layer3/mod.rs`: classify unavailable preceding reservoir bytes as debug-level
warm-up until the first complete reservoir fill following initialization or
reset. Accurate MP3 seeks deliberately supply preceding reference packets; the
first of those packets can itself refer to older bytes. That is not evidence
of corruption. Underflows after the reservoir is primed still warn, and all
underflow recovery, returned counts, decoded samples and fatal errors remain
unchanged. No global warning filter is applied.

The unit regression exercises multiple initial underflows, successful priming,
a later damaged-frame underflow, and reset. Application regressions compare
cold/repeated MP3 seeks with linear decoding. Retain these checks if the patch
is removed after an upstream update.
