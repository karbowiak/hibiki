.PHONY: release dev build

dev:
	bun run tauri dev

build:
	bun run tauri build

release:
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make release VERSION=0.5.0"; \
		exit 1; \
	fi
	@echo "Tagging v$(VERSION) and pushing..."
	git tag -a "v$(VERSION)" -m "Release v$(VERSION)"
	git push origin "v$(VERSION)"
	@echo "Creating GitHub release with auto-generated notes..."
	gh release create "v$(VERSION)" \
		--title "Hibiki v$(VERSION)" \
		--generate-notes \
		--notes-start-tag "$$(git tag --sort=-v:refname | sed -n '2p')" \
		--draft
	@echo "Draft release created. The CI workflow will build and attach binaries."
	@echo "Once builds complete, the release will be published automatically."
