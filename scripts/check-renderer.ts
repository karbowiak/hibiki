import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join, relative } from "node:path"
import { build } from "vite"
import { chromium, webkit } from "playwright"

const root = resolve(import.meta.dir, "..")
const output = await mkdtemp(join(tmpdir(), "hibiki-renderer-"))
const config = await Bun.file(resolve(root, "src-tauri/tauri.conf.json")).json()
const policy = config.app.security.csp
const csp =
  typeof policy === "string"
    ? policy
    : Object.entries(policy ?? {})
        .map(
          ([directive, sources]) =>
            `${directive} ${Array.isArray(sources) ? sources.join(" ") : sources}`
        )
        .join("; ")
const artifactDir = resolve(root, ".tmp/renderer-checks")
await mkdir(artifactDir, { recursive: true })

// A small silent PCM fixture exercises the actual radio player without any server
// account, Plex integration, or audible output.
const samples = 44100 * 10
const wav = Buffer.alloc(44 + samples * 2)
wav.write("RIFF", 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write("WAVEfmt ", 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(44100, 24)
wav.writeUInt32LE(44100 * 2, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write("data", 36)
wav.writeUInt32LE(samples * 2, 40)
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#748ac7"/></svg>'
const modalArtwork =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#d946ef"/><stop offset="1" stop-color="#385c99"/></linearGradient></defs><rect width="512" height="512" rx="12" fill="url(#bg)"/><circle cx="256" cy="215" r="100" fill="#ffffff" fill-opacity=".15"/><text x="256" y="375" text-anchor="middle" fill="white" font-family="sans-serif" font-size="42">Hibiki</text></svg>'
const font = await Bun.file(
  resolve(
    root,
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
  )
).bytes()
const unexpectedRequests: string[] = []

try {
  await build({
    root,
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: output,
      emptyOutDir: true,
      sourcemap: false,
      rolldownOptions: {
        input: [
          resolve(root, "index.html"),
          resolve(root, "tests/fixtures/renderer/index.html"),
        ],
      },
    },
  })
  const certificate = join(output, "fixture-cert.pem")
  const key = join(output, "fixture-key.pem")
  const certificateProcess = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdout: "ignore", stderr: "ignore" }
  )
  assert.equal(
    await certificateProcess.exited,
    0,
    "Could not generate an ephemeral fixture certificate"
  )
  const socketOptions = {
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, server: any) {
      const url = new URL(request.url)
      if (
        url.pathname === "/:/websockets/notifications" &&
        url.searchParams.get("X-Plex-Token") === "synthetic-renderer-token" &&
        server.upgrade(request)
      )
        return
      return new Response(null, { status: 404 })
    },
    websocket: { message() {} },
  }
  const wsServer = Bun.serve(socketOptions)
  const wssServer = Bun.serve({
    ...socketOptions,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/renderer-fixture.json")
        return Response.json({
          ws: `http://127.0.0.1:${wsServer.port}`,
          wss: `https://127.0.0.1:${wssServer.port}`,
        })
      if (url.pathname === "/radio.wav")
        return new Response(wav, { headers: { "Content-Type": "audio/wav" } })
      if (url.pathname.includes("untrusted-"))
        unexpectedRequests.push(url.pathname)
      const path = resolve(
        output,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`
      )
      if (relative(output, path).startsWith(".."))
        return new Response(null, { status: 400 })
      const file = Bun.file(path)
      if (!(await file.exists())) return new Response(null, { status: 404 })
      const headers: Record<string, string> = {}
      if (path.endsWith(".html") && csp)
        headers["Content-Security-Policy"] = csp
      return new Response(file, { headers })
    },
  })
  try {
    for (const name of (
      process.env.HIBIKI_RENDERERS ?? "chromium,webkit"
    ).split(",")) {
      assert.ok(
        name === "chromium" || name === "webkit",
        `Unknown renderer ${name}`
      )
      const browser = await (name === "chromium" ? chromium : webkit).launch({
        headless: true,
        // CI has no physical GPU. Exercise WebGL through Chromium's software GL
        // driver, only in these isolated fixtures; the desktop app uses its GPU.
        ...(name === "chromium" && process.env.LIBGL_ALWAYS_SOFTWARE === "1"
          ? { args: ["--use-gl=angle", "--use-angle=swiftshader"] }
          : {}),
        ...(name === "chromium" && process.env.HIBIKI_CHROME_CHANNEL
          ? { channel: process.env.HIBIKI_CHROME_CHANNEL }
          : {}),
      })
      try {
        const context = await browser.newContext({
          viewport: { width: 1400, height: 890 },
          // Trust only the context's synthetic TLS test. Native certificate
          // verification remains covered by Rust tests and is not changed here.
          ignoreHTTPSErrors: true,
        })
        const origin = `http://127.0.0.1:${server.port}`
        await context.route("**/*", (route) => {
          if (new URL(route.request().url()).origin === origin)
            return route.continue()
          unexpectedRequests.push("unexpected external request")
          return route.abort()
        })
        // Each renderer gets a fresh temporary browser profile and synthetic-only
        // endpoints. Never attach to the user's browser or read saved credentials.
        // Preserve the existing Circular font origin without depending on its CDN
        // being reachable: deliver a bundled, redistributable font as fixture bytes.
        await context.route("https://encore.scdn.co/fonts/**", (route) =>
          route.fulfill({
            contentType: "font/woff2",
            body: Buffer.from(font),
            headers: { "Access-Control-Allow-Origin": "*" },
          })
        )
        const artworkAttempts = new Map<string, number>()
        await context.route("http://image.localhost/**", (route) => {
          const path = new URL(route.request().url()).pathname
          const count = (artworkAttempts.get(path) ?? 0) + 1
          artworkAttempts.set(path, count)
          if (
            path.endsWith("/failure-fixture") ||
            (path.endsWith("/retry-fixture") && count < 3)
          ) {
            return route.fulfill({
              status: 503,
              body: "Busy",
              headers: {
                "Retry-After": "1",
                "Access-Control-Allow-Origin": "*",
              },
            })
          }
          return route.fulfill({
            contentType: "image/svg+xml",
            body: path.endsWith("/modal-fixture") ? modalArtwork : svg,
            headers: { "Access-Control-Allow-Origin": "*" },
          })
        })
        await context.route("http://ipc.localhost/**", (route) =>
          route.fulfill({
            contentType: "text/plain",
            body: "fixture IPC",
            headers: { "Access-Control-Allow-Origin": "*" },
          })
        )
        await context.route("http://untrusted.localhost/**", (route) => {
          unexpectedRequests.push("untrusted external request")
          return route.fulfill({
            contentType: "application/javascript",
            body: "window.remoteScriptRan = true",
          })
        })
        const page = await context.newPage()
        await page.goto(origin)
        await page
          .getByRole("heading", { name: "Open the Hibiki desktop app" })
          .waitFor()
        const fonts = await page.evaluate(async () => {
          await document.fonts.ready
          return [...document.fonts].filter((font) => font.status === "loaded")
            .length
        })
        assert.ok(fonts > 0, `${name}: bundled fonts were not loaded`)
        await page.screenshot({ path: join(artifactDir, `${name}-app.png`) })
        await page.goto(`${origin}/tests/fixtures/renderer/index.html`)
        await page
          .getByRole("button", { name: "Start renderer checks" })
          .click()
        await page.waitForFunction(
          () => {
            const state = (window as any).rendererCheck
            return state?.ready || state?.error
          },
          undefined,
          { timeout: 30000 }
        )
        const state = await page.evaluate(() => (window as any).rendererCheck)
        assert.equal(state.error, "", `${name}: ${state.error}`)
        assert.equal(state.ready, true)
        assert.ok(state.presetCount > 0, `${name}: no preset pack metadata`)
        assert.equal(state.frames, 5)
        assert.equal(state.artwork, true)
        assert.equal(state.focalPoint, true)
        assert.equal(state.ipc, true)
        assert.deepEqual(
          state.violations,
          [],
          `${name}: CSP blocked a supported feature`
        )
        await page.waitForFunction(
          () => (window as any).rendererCheck.radioPlaying,
          undefined,
          { timeout: 5000 }
        )
        await page.waitForFunction(
          () => {
            const state = (window as any).rendererCheck
            return state.plexWs && state.plexWss
          },
          undefined,
          { timeout: 5000 }
        )
        assert.deepEqual(
          await page.evaluate(() => (window as any).rendererCheck.violations),
          []
        )
        await page.evaluate(() => (window as any).pauseRadio())
        await page.waitForFunction(
          () => (window as any).rendererCheck.radioPaused
        )
        assert.equal(
          await page.evaluate(() => (window as any).rendererCheck.radioError),
          ""
        )
        await page.screenshot({
          path: join(artifactDir, `${name}-milkdrop.png`),
        })
        await page.evaluate(() => (window as any).mountArtworkViewer())
        await page.evaluate(() => (window as any).mountArtworkRetry())
        await page.waitForFunction(
          () => {
            const state = (window as any).artworkRetry
            return state?.recovered && state?.failed
          },
          null,
          { timeout: 10000 }
        )
        assert.equal(
          artworkAttempts.get("/album/retry-fixture"),
          3,
          `${name}: transient artwork did not retry twice`
        )
        assert.equal(
          artworkAttempts.get("/album/failure-fixture"),
          3,
          `${name}: permanent artwork did not stop retrying`
        )
        assert.equal(
          await page.getByAltText("Failed cover").count(),
          0,
          `${name}: permanent artwork leaves a broken image`
        )
        await page.evaluate(() => (window as any).unmountArtworkRetry())

        await page.evaluate(() => (window as any).mountPlaylistCreator())
        const playlistTrigger = page.getByRole("button", {
          name: "Create fixture playlist",
        })
        await playlistTrigger.focus()
        await page.keyboard.press("Enter")
        const creator = page.getByRole("dialog", {
          name: "Create playlist",
          exact: true,
        })
        await creator.waitFor()
        assert.equal(
          await creator.evaluate((element) => element.matches(":modal")),
          true,
          `${name}: playlist creator is not native modal`
        )
        const creatorBounds = await creator.boundingBox()
        assert.ok(
          creatorBounds &&
            creatorBounds.width >= 1399 &&
            creatorBounds.height >= 889,
          `${name}: playlist creator is clipped by transformed host`
        )
        const playlistName = creator.getByLabel("Playlist name")
        assert.equal(
          await playlistName.evaluate(
            (element) => element === document.activeElement
          ),
          true,
          `${name}: playlist name did not receive focus`
        )
        for (const key of ["Tab", "Shift+Tab", "Tab", "Tab", "Tab", "Tab"]) {
          await page.keyboard.press(key)
          assert.equal(
            await creator.evaluate((element) =>
              element.contains(document.activeElement)
            ),
            true,
            `${name}: ${key} escaped playlist creator`
          )
        }
        await page.keyboard.press("Escape")
        await creator.waitFor({ state: "hidden" })
        assert.equal(
          await playlistTrigger.evaluate(
            (element) => element === document.activeElement
          ),
          true,
          `${name}: Escape did not restore playlist trigger focus`
        )
        await playlistTrigger.click()
        await creator.waitFor()
        await playlistName.fill("  Fixture playlist  ")
        await page.evaluate(() => {
          ;(window as any).playlistCreator.fail = true
        })
        await creator
          .getByRole("button", { name: "Create", exact: true })
          .click()
        await creator
          .getByRole("alert")
          .filter({ hasText: "Synthetic playlist failure" })
          .waitFor()
        assert.equal(
          await playlistName.inputValue(),
          "  Fixture playlist  ",
          `${name}: failed creation lost the entered name`
        )
        await page.screenshot({
          path: join(artifactDir, `${name}-playlist-create.png`),
        })
        await page.evaluate(() => {
          ;(window as any).playlistCreator.fail = false
        })
        await creator
          .getByRole("button", { name: "Create", exact: true })
          .click()
        await creator
          .getByRole("status")
          .filter({ hasText: "Playlist created!" })
          .waitFor()
        assert.equal(
          await page.evaluate(() => (window as any).playlistCreator.created),
          "Fixture playlist",
          `${name}: playlist callback did not receive trimmed title`
        )
        await creator.waitFor({ state: "hidden" })
        assert.equal(
          await playlistTrigger.evaluate(
            (element) => element === document.activeElement
          ),
          true,
          `${name}: successful creation did not restore focus`
        )
        assert.equal(
          await page.evaluate(() => (window as any).playlistCreator.calls),
          2,
          `${name}: creation retry made duplicate requests`
        )
        await page.evaluate(() => (window as any).unmountPlaylistCreator())

        const artworkTrigger = page.getByRole("button", {
          name: "View fixture artwork",
        })
        await artworkTrigger.focus()
        await page.keyboard.press("Enter")
        const viewer = page.getByRole("dialog", { name: "Fixture album cover" })
        await viewer.waitFor({ timeout: 3000 })
        assert.equal(
          await viewer.evaluate((element) => element.matches(":modal")),
          true,
          `${name}: artwork viewer is not modal`
        )
        const bounds = await viewer.boundingBox()
        assert.ok(
          bounds && bounds.width >= 1399 && bounds.height >= 889,
          `${name}: artwork viewer is clipped by its parent`
        )
        const closeImage = viewer.getByRole("button", { name: "Close image" })
        assert.equal(
          await closeImage.evaluate(
            (element) => element === document.activeElement
          ),
          true,
          `${name}: artwork viewer did not take focus`
        )
        for (const key of ["Tab", "Shift+Tab"]) {
          await page.keyboard.press(key)
          assert.equal(
            await page.evaluate(
              () => !!document.activeElement?.closest("dialog")
            ),
            true,
            `${name}: ${key} left the artwork viewer`
          )
        }
        await page
          .getByRole("button", { name: "Background control" })
          .evaluate((element: HTMLElement) => element.focus())
        assert.equal(
          await closeImage.evaluate(
            (element) => element === document.activeElement
          ),
          true,
          `${name}: background control took modal focus`
        )
        await viewer.getByRole("img").click()
        assert.equal(
          await viewer.isVisible(),
          true,
          `${name}: clicking artwork dismissed it`
        )
        assert.equal(
          await page.evaluate(
            () => !!document.elementFromPoint(700, 850)?.closest("dialog")
          ),
          true,
          `${name}: player overlay covers artwork viewer`
        )
        await page.screenshot({
          path: join(artifactDir, `${name}-artwork-viewer.png`),
        })
        await page.keyboard.press("Escape")
        await viewer.waitFor({ state: "detached" })
        assert.equal(
          await artworkTrigger.evaluate(
            (element) => element === document.activeElement
          ),
          true,
          `${name}: closing artwork did not restore focus`
        )
        await artworkTrigger.click()
        await closeImage.click()
        await viewer.waitFor({ state: "detached" })
        await artworkTrigger.click()
        await viewer.click({ position: { x: 10, y: 10 } })
        await viewer.waitFor({ state: "detached" })
        // Exercise the older system-WebKit path without attaching to a real
        // user profile or requiring an obsolete browser in CI.
        const backgroundBeforeFallback = await page.evaluate(() => {
          const player = document.getElementById("fixture-player-overlay")!
          player.setAttribute("aria-hidden", "false")
          Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
            configurable: true,
            value: undefined,
          })
          return document.body.style.overflow
        })
        for (const dismissal of ["Escape", "button", "backdrop"]) {
          await artworkTrigger.click()
          await viewer.waitFor()
          assert.equal(
            await viewer.evaluate((element) => element.matches(":modal")),
            false
          )
          assert.equal(
            await closeImage.evaluate(
              (element) => element === document.activeElement
            ),
            true
          )
          await page.keyboard.press("Shift+Tab")
          assert.equal(
            await closeImage.evaluate(
              (element) => element === document.activeElement
            ),
            true
          )
          await page
            .locator("section button")
            .last()
            .evaluate((element: HTMLElement) => element.focus())
          assert.equal(
            await closeImage.evaluate(
              (element) => element === document.activeElement
            ),
            true
          )
          assert.deepEqual(
            await page.evaluate(() => ({
              overflow: document.body.style.overflow,
              backgroundHidden: document
                .getElementById("fixture-player-overlay")!
                .getAttribute("aria-hidden"),
              topmost: !!document.elementFromPoint(700, 850)?.closest("dialog"),
            })),
            { overflow: "hidden", backgroundHidden: "true", topmost: true }
          )
          if (dismissal === "Escape") {
            await page.screenshot({
              path: join(artifactDir, `${name}-artwork-viewer-fallback.png`),
            })
            await page.keyboard.press("Escape")
          } else if (dismissal === "button") await closeImage.click()
          else await viewer.click({ position: { x: 10, y: 10 } })
          await viewer.waitFor({ state: "detached" })
          assert.equal(
            await artworkTrigger.evaluate(
              (element) => element === document.activeElement
            ),
            true,
            `${name}: fallback ${dismissal} did not restore the focused artwork trigger`
          )
          assert.deepEqual(
            await page.evaluate(() => ({
              overflow: document.body.style.overflow,
              backgroundHidden: document
                .getElementById("fixture-player-overlay")!
                .getAttribute("aria-hidden"),
              backgroundInert: document
                .getElementById("fixture-player-overlay")!
                .hasAttribute("inert"),
            })),
            {
              overflow: backgroundBeforeFallback,
              backgroundHidden: "false",
              backgroundInert: false,
            }
          )
        }
        assert.deepEqual(
          await page.evaluate(() => (window as any).rendererCheck.violations),
          [],
          `${name}: artwork controls violated CSP`
        )
        await page.evaluate(() => (window as any).mountImageCacheControls())
        const clearCache = page.getByRole("button", {
          name: "Clear image cache",
        })
        const cacheStatus = page.getByRole("status")
        await cacheStatus.filter({ hasText: "2 files" }).waitFor()
        await clearCache.click()
        assert.equal(await clearCache.isDisabled(), true)
        assert.equal(await clearCache.textContent(), "Clearing...")
        await page.screenshot({
          path: join(artifactDir, `${name}-image-cache-pending.png`),
        })
        await page.evaluate(() => (window as any).finishImageCacheClear(true))
        await page
          .getByRole("alert")
          .filter({ hasText: "One artwork file could not be removed" })
          .waitFor()
        await cacheStatus.filter({ hasText: "1 file" }).waitFor()
        await page.screenshot({
          path: join(artifactDir, `${name}-image-cache-error.png`),
        })
        await page.getByRole("button", { name: "Retry" }).click()
        assert.equal(await clearCache.isDisabled(), true)
        assert.equal(
          await page.evaluate(() => (window as any).imageCacheClearCalls),
          2
        )
        await page.evaluate(() => (window as any).finishImageCacheClear())
        await cacheStatus.filter({ hasText: "0 B · 0 files" }).waitFor()
        assert.equal(await clearCache.isDisabled(), true)
        await page.screenshot({
          path: join(artifactDir, `${name}-image-cache-cleared.png`),
        })
        await page.evaluate(() => (window as any).tryUntrustedContent(true))
        await page.waitForTimeout(100)
        assert.equal(
          await page.evaluate(() => (window as any).inlineScriptRan),
          undefined,
          `${name}: inline script ran`
        )
        await page.evaluate(() => (window as any).tryUntrustedContent())
        await page.waitForTimeout(250)
        const security = await page.evaluate(() => ({
          inline: (window as any).inlineScriptRan,
          handler: (window as any).inlineHandlerRan,
          remote: (window as any).remoteScriptRan,
          base: document.baseURI,
          violations: (window as any).rendererCheck.violations,
        }))
        assert.equal(security.inline, undefined, `${name}: inline script ran`)
        assert.equal(
          security.handler,
          undefined,
          `${name}: inline event handler ran`
        )
        assert.equal(security.remote, undefined, `${name}: remote script ran`)
        assert.ok(
          security.base.startsWith(origin),
          `${name}: injected base URL was used`
        )
        for (const directive of [
          "script-src-elem",
          "script-src-attr",
          "frame-src",
          "object-src",
          "base-uri",
          "form-action",
        ]) {
          assert.ok(
            security.violations.includes(directive),
            `${name}: ${directive} was not enforced`
          )
        }
        assert.deepEqual(
          unexpectedRequests,
          [],
          `${name}: untrusted content reached the network`
        )
        await page.evaluate(() => (window as any).disposeRenderer())
        console.log(
          `${name}: app, MilkDrop, artwork analysis/viewer/cache controls, IPC, radio, Plex WS/WSS, and CSP enforcement passed`
        )
        await context.close()
      } finally {
        await browser.close()
      }
    }
  } finally {
    server.stop(true)
    wsServer.stop(true)
    wssServer.stop(true)
  }
} finally {
  await rm(output, { recursive: true, force: true })
}
