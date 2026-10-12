# Hibiki visual polish

## Active goal

Make artwork and its colors carry through the entire application while preserving readable controls, appearance preferences, playback and seeking.

- [x] Extend the active image across the full application, behind navigation and the playbar.
- [x] Keep artist and album heroes sharp, with an aligned blurred continuation beneath the content.
- [x] Make the top bar, sidebar and playbar semi-transparent, with adjustable opacity and readable light/custom themes.
- [x] Pick stable random library artwork on non-artist/album pages, respecting the current account and artwork source preferences.
- [x] Derive primary and secondary action colors site-wide from the actual background image.
- [x] Adapt the playbar waveform to Heya's symmetric vertical bars, retaining seeking, hover feedback and the other visualization modes.
- [x] Verify native rendering and isolated Chromium/WebKit behavior at different widths, fonts, card sizes and palettes; commit locally.

Use existing cached library artwork without large background library scans. Missing artwork, disabled background settings and reduced-transparency preferences must retain a usable interface. Do not push or release this batch.

The bars share one semantic tint. The toolbar has balanced padding, controls have subtle hover states, and the previous image stays visible underneath the incoming fade. Artwork colors are scoped to the app; disabling them restores the saved accent. Hero metadata and small accent text retain readable contrast.

Validation: 606 frontend tests; both TypeScript projects and production build; Chromium and WebKit appearance, artwork transitions, palette contrast, seek controls, account retirement, library/player geometry, search discovery, notifications and renderer/CSP checks. Native screenshots reviewed sharp album/artist heroes, glass surfaces, toolbar spacing and live waveform rendering. No audio-engine changes in this visual batch.

## Follow-up polish

- [x] Give playback controls, popovers and waveform an independent now-playing artwork palette, with saved-accent fallback.
- [x] Keep Create Playlist on the saved accent as page backgrounds change.
- [x] Make media context menus and Cmd/Ctrl+K consistent across library, collection and detail routes; support keyboard focus and account retirement.
- [x] Give podcast and internet-radio cards the shared square artwork layout, with independent open/play and favorite actions and shared context menus.
- [x] Replace playlist color boxes with sharp full-window artwork heroes, a blurred continuation, labeled actions and a songs/runtime ledger.
- [x] Rotate eligible cached backgrounds every 45 seconds, with pause and next-image controls; pause automatic rotation in hidden windows and exclude artist/album pages.
- [x] Replace persistent artwork-source buttons with accessible hover/focus edit pens.
- [x] Keep wide song tables within their own scroll region and keep keyboard scrolling separate from playback shortcuts.
- [x] Hide broken-image indicators during bounded retries and use the native image cache for radio artwork.

Validation: 611 frontend tests; both TypeScript projects and production build; Chromium and WebKit appearance and real-card context menus across dark/light/custom palettes, fonts, sizes and narrow windows. Shell, library/player geometry, search discovery, notifications and renderer/CSP checks passed in both browsers. Native review covered the small ❤️ Tracks playlist hero, independent playback colors, library shortcuts, shared context menus and podcast/radio layouts. No playback-engine or Rust changes.

The ignored local `TODO.md` records metadata-provider expansion, optional SoulSync, Plex metadata editing and playlist synchronization. It also records a native radio-directory lookup failure seen during final review: direct public HTTP requests succeeded, so the native client error still needs diagnosis. This batch is committed locally without pushing or releasing.
