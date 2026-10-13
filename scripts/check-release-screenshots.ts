import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"
import { chromium } from "playwright"
import { demoArtwork } from "../tests/fixtures/releaseScreenshots/artwork"
const root = resolve(import.meta.dir, ".."),
  output = await mkdtemp(join(tmpdir(), "hibiki-release-preview-")),
  artifacts = resolve(root, ".tmp/release-screenshots")
const previous = process.env.TAURI_ENV_PLATFORM
process.env.TAURI_ENV_PLATFORM = "windows"
await mkdir(artifacts, { recursive: true })
let server: ReturnType<typeof Bun.serve> | undefined
try {
  await build({
    root,
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: output,
      emptyOutDir: true,
      rolldownOptions: {
        input: resolve(root, "tests/fixtures/releaseScreenshots/index.html"),
      },
    },
  })
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const art = path.match(/^\/demo-art\/(\d+)(-landscape)?\.svg$/)
      if (art)
        return new Response(demoArtwork(Number(art[1]), !!art[2]), {
          headers: { "Content-Type": "image/svg+xml" },
        })
      const filePath = resolve(output, `.${path}`)
      if (!filePath.startsWith(`${output}/`))
        return new Response(null, { status: 404 })
      const file = Bun.file(filePath)
      return (await file.exists())
        ? new Response(file)
        : new Response(null, { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`,
    browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      locale: "en-GB",
      colorScheme: "dark",
      reducedMotion: "reduce",
    })
    let blocked = 0
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      if (url.hostname === "image.localhost") {
        const raw = url.searchParams.get("src")
        if (raw && new URL(raw).origin === origin) {
          const source = await fetch(raw)
          return route.fulfill({
            status: source.status,
            headers: {
              "Content-Type": "image/svg+xml",
              "Access-Control-Allow-Origin": "*",
            },
            body: Buffer.from(await source.arrayBuffer()),
          })
        }
      }
      blocked++
      return route.abort()
    })
    const page = await context.newPage(),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${origin}/tests/fixtures/releaseScreenshots/index.html`)
    await page.waitForFunction(() => (window as any).releasePreview?.ready)
    for (const [name, path, title] of [
      ["main", "/", ""],
      ["artist", "/artist/demo-artist-0", "Aster Vale"],
      ["album", "/album/demo-album-0", "After the Blue Hour"],
      ["search", "/search", "Results for"],
    ] as const) {
      await page.evaluate(
        (value) => (window as any).releasePreview.route(value),
        path
      )
      await page.locator("main h1").waitFor()
      if (title)
        await page.locator("main h1").filter({ hasText: title }).waitFor()
      if (title)
        assert.ok(
          (await page.locator("main").innerText()).includes(title),
          `${name} did not render seeded data`
        )
      await page
        .locator('.app-artwork-shell[data-artwork-background="ready"]')
        .waitFor()
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("img")).every(
          (img) => img.complete
        )
      )
      const missing = await page
        .locator("img")
        .evaluateAll(
          (images) =>
            images.filter(
              (image) => (image as HTMLImageElement).naturalWidth === 0
            ).length
        )
      assert.equal(missing, 0, `${name} has a failed artwork image`)
      assert.equal(
        await page.locator("main").getByRole("alert").count(),
        0,
        `${name} contains a visible load error`
      )
      await page.screenshot({
        path: join(artifacts, `${name}.png`),
        animations: "disabled",
      })
    }
    assert.deepEqual(errors, [], "release fixture renderer errors")
    await writeFile(
      join(artifacts, "README.md"),
      `# Hibiki release preview fixture\n\nThese are isolated Chromium renderer previews, not screenshots of a user library or a connected native app. They use the actual ArtworkShell, SideBar, Page routes, and Player, the production Vite configuration and complete project CSS. All artists, albums, songs, mixes and playlists are synthetic. SVG artwork is original code-native geometry.\n\nTransport controls and native engine initialization are disabled; the player shows a seeded paused preview, not real playback. No Tauri IPC emulator, external account requests, native writes, or real audio output are used. Every external network request is blocked (${blocked} blocked resource attempts).\n\nDark theme, en-GB locale, 1440 × 1000 pixels, default Circular font setting. Circular assets are CDN-only and cannot load in this strictly offline fixture: the browser's normal sans-serif fallback renders instead. This font difference must be considered during release review.\n\nFiles: main.png (Home shelves), artist.png (artist hero and popular tracks), album.png (album detail and ordered tracks), search.png (actual search results). This directory is review-only; repository release screenshots were not replaced.\n`
    )
    console.log(`Release previews: ${artifacts}`)
  } finally {
    await browser.close()
  }
} finally {
  server?.stop(true)
  await rm(output, { recursive: true, force: true })
  if (previous === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = previous
}
