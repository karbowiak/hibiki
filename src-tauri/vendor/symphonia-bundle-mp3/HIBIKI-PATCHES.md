Upstream: `symphonia-bundle-mp3 0.6.1`, Project Symphonia commit `ee35874b571a35a9a6e15d3bc9a3aaf8f11fbeee`. Original source headers, manifests and MPL-2.0 license are retained.

Hibiki changes:

- `layer3/mod.rs`: report missing reservoir bytes at debug level until the first complete fill after construction/reset. Later underflows still warn. Recovery counts, decoded PCM and error propagation are unchanged.

The crate unit regression covers repeated warm-up underflows, priming, a later damaged frame and reset. Application regressions compare cold/repeated seeks with linear PCM and preserve discarded synthesis pre-roll.
