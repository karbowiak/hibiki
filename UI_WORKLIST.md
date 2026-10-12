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
