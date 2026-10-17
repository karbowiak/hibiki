Upstream: `tauri-plugin-updater 2.14.0`, Tauri plugins commit `44293a5722efcaf27060504e63b17aeba721b40f`. Original source, manifests and Apache-2.0/MIT licenses are retained.

Only the Windows ZIP dependency requirement changes, from `4` to `9.0.4`. The `ZipArchive::new` / `extract` API used by the updater is unchanged. This removes RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369 from the application dependency graph. Signature verification, installer selection, installation and relaunch code are untouched.

Remove this patch when the published updater adopts ZIP 9 or newer. Cross-platform CI must compile the Windows installer path before release.
