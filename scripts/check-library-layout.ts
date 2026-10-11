import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"
import { chromium, webkit } from "playwright"

const root = resolve(import.meta.dir, "..")
const output = await mkdtemp(join(tmpdir(), "hibiki-library-layout-"))
const artifactDir = resolve(root, ".tmp/library-layout-checks")
await mkdir(artifactDir, { recursive: true })
const artwork =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><defs><linearGradient id="g"><stop stop-color="#7c3aed"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs><rect width="480" height="480" fill="url(#g)"/><circle cx="240" cy="200" r="90" fill="white" fill-opacity=".18"/><text x="240" y="360" text-anchor="middle" fill="white" font-family="sans-serif" font-size="32">Fixture artwork</text></svg>'
const routes = [
  "/collection/playlists",
  "/library",
  "/artist/fixture-artist",
  "/album/fixture-album",
]
const originalPlatform = process.env.TAURI_ENV_PLATFORM
process.env.TAURI_ENV_PLATFORM = "darwin"
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
        input: resolve(root, "tests/fixtures/libraryLayout/index.html"),
      },
    },
  })
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith("/synthetic-artwork/"))
        return new Response(artwork, {
          headers: { "Content-Type": "image/svg+xml" },
        })
      const filename = resolve(output, "." + pathname)
      if (!filename.startsWith(output + "/"))
        return new Response("Not found", { status: 404 })
      const file = Bun.file(filename)
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  for (const [name, type] of [
    ["chrome", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({
      headless: true,
      ...(name === "chrome" && process.env.HIBIKI_CHROME_CHANNEL
        ? { channel: process.env.HIBIKI_CHROME_CHANNEL }
        : {}),
    })
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      })
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort()
      )
      const page = await context.newPage(),
        errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${origin}/tests/fixtures/libraryLayout/index.html`)
      await page.waitForFunction(
        () => (window as any).visualFixtureReady === true
      )
      for (const [width, sidebar] of [
        [1440, 240],
        [800, 240],
        [800, 320],
      ] as const) {
        await page.setViewportSize({ width, height: width === 800 ? 600 : 900 })
        await page.evaluate(
          (value) => (window as any).setFixtureSidebarWidth(value),
          sidebar
        )
        for (const route of routes) {
          await page.evaluate((path) => {
            history.pushState({}, "", path)
            dispatchEvent(new PopStateEvent("popstate"))
          }, route)
          await page.waitForTimeout(300)
          await page
            .locator("#layout-fixture main .overflow-auto")
            .evaluate((element) => {
              element.scrollTop = 0
            })
          const slug = route.startsWith("/collection")
            ? "playlists"
            : route.split("/")[1]
          const metrics = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>(
              "#layout-fixture main"
            )!
            const scroller = main.querySelector<HTMLElement>(".overflow-auto")!
            const title = main.querySelector<HTMLElement>(
              "h1,[class*='text-[76px]']"
            )!
            const settings = [
              ...main.querySelectorAll<HTMLButtonElement>("button"),
            ].find((element) => element.textContent?.trim() === "Settings")!
            const info = title.getBoundingClientRect(),
              button = settings.getBoundingClientRect()
            return {
              overflow: scroller.scrollWidth - scroller.clientWidth,
              titleWidth: info.width,
              titleOverflow: title.scrollWidth - title.clientWidth,
              settingsLeft: button.left,
              settingsRight: button.right,
            }
          })
          assert.ok(
            metrics.overflow <= 1,
            `${name}/${slug}/${width}/${sidebar}: main overflow ${metrics.overflow}`
          )
          assert.ok(
            metrics.titleWidth >= 160,
            `${name}/${slug}/${width}/${sidebar}: collapsed heading ${metrics.titleWidth}`
          )
          assert.ok(
            metrics.titleOverflow <= 1,
            `${name}/${slug}/${width}/${sidebar}: clipped title text`
          )
          assert.ok(
            metrics.settingsLeft >= 0 && metrics.settingsRight <= width + 1,
            `${name}/${slug}/${width}/${sidebar}: Settings offscreen`
          )
          await page.screenshot({
            path: join(artifactDir, `${name}-${slug}-${width}-${sidebar}.png`),
          })
          if (slug === "playlists" || slug === "artist") {
            const selector =
              slug === "playlists"
                ? '#layout-fixture main a[href^="/playlist/"] button'
                : '#layout-fixture main button[aria-label^="Play "]'
            // Keyboard modality plus actual focus exercises CSS focus visibility
            // on both browsers regardless of macOS Safari Tab preferences.
            await page.keyboard.press("Tab")
            await page.locator(selector).first().focus()
            await page.waitForTimeout(250)
            const visible = await page
              .locator(selector)
              .first()
              .evaluate((element) => {
                let current: Element | null = element
                while (current) {
                  if (getComputedStyle(current).opacity === "0") return false
                  current = current.parentElement
                }
                return (
                  element.matches(":focus-visible") &&
                  getComputedStyle(element).boxShadow.includes("2px")
                )
              })
            assert.ok(
              visible,
              `${name}/${slug}/${width}/${sidebar}: hidden/unmarked focused Play control`
            )
            await page.screenshot({
              path: join(
                artifactDir,
                `${name}-${slug}-${width}-${sidebar}-keyboard.png`
              ),
            })
          }
        }
      }
      assert.deepEqual(errors, [], `${name}: page errors`)
      console.log(
        `${name}: four real library routes fit desktop/800px and wider sidebar; focused Play controls visible`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  if (originalPlatform === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = originalPlatform
  server?.stop(true)
  await rm(output, { recursive: true, force: true })
}
