import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"
import { chromium, webkit } from "playwright"

// Real components and stores, disposable preferences and playback, no account I/O.
const root = resolve(import.meta.dir, "..")
const output = await mkdtemp(join(tmpdir(), "hibiki-appearance-"))
const artifacts = resolve(root, ".tmp/appearance-checks")
await mkdir(artifacts, { recursive: true })
const previousPlatform = process.env.TAURI_ENV_PLATFORM
process.env.TAURI_ENV_PLATFORM = "darwin"
const fallbackFont = await Bun.file(
  resolve(
    root,
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
  )
).bytes()
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
      const path = new URL(request.url).pathname
      if (path.startsWith("/synthetic-artwork/"))
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#7c3aed"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      const filePath = resolve(output, `.${path}`)
      if (!filePath.startsWith(`${output}/`))
        return new Response(null, { status: 404 })
      const file = Bun.file(filePath)
      return (await file.exists())
        ? new Response(file)
        : new Response(null, { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({ headless: true })
    try {
      const context = await browser.newContext()
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        if (url.hostname === "encore.scdn.co" && /\.woff2?$/.test(url.pathname))
          return route.fulfill({
            body: Buffer.from(fallbackFont),
            contentType: "font/woff2",
          })
        return route.abort()
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(
        `${origin}/tests/fixtures/libraryLayout/index.html?appearance=1&player=1&discovery=1`
      )
      await page.waitForFunction(() => (window as any).visualFixtureReady)
      for (const scenario of [
        {
          width: 1440,
          sidebar: 240,
          font: "circular",
          cardSize: 160,
          theme: "dark",
          compact: false,
          custom: false,
          textSize: 16,
        },
        {
          width: 800,
          sidebar: 320,
          font: "jetbrains-mono",
          cardSize: 280,
          theme: "light",
          compact: true,
          custom: false,
          textSize: 18,
        },
        {
          width: 1100,
          sidebar: 240,
          font: "montserrat",
          cardSize: 140,
          theme: "dark",
          compact: false,
          custom: true,
          textSize: 16,
        },
      ]) {
        const slug = `${name}-${scenario.width}-${scenario.font}-${scenario.theme}`
        await page.setViewportSize({ width: scenario.width, height: 850 })
        await page.evaluate((value) => {
          ;(window as any).fixtureAppearance.apply(value)
          ;(window as any).setFixtureSidebarWidth(value.sidebar)
        }, scenario)
        await page.evaluate(() => document.fonts.ready)
        for (const route of [
          "/search",
          "/collection/playlists",
          "/artist/fixture-artist",
          "/album/fixture-album",
        ]) {
          await page.evaluate(
            (path) => (window as any).fixtureAppearance.route(path),
            route
          )
          await page.locator("main h1").waitFor()
          await page
            .locator("#layout-fixture main .overflow-auto")
            .evaluate((element) => {
              element.scrollTop = 0
            })
          await page.waitForTimeout(350) // CSS palette/layout transitions must settle.
          const metrics = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>(
              "#layout-fixture main"
            )!
            const scroller = main.querySelector<HTMLElement>(".overflow-auto")!
            const title = main.querySelector<HTMLElement>("h1")!
            const r = title.getBoundingClientRect()
            const family = getComputedStyle(document.body).fontFamily
            const rowTitle = main.querySelector<HTMLElement>(
              "tbody tr:nth-child(2) td:nth-child(2) > div, section .group span.truncate"
            )
            return {
              overflow: scroller.scrollWidth - scroller.clientWidth,
              documentOverflow:
                document.documentElement.scrollWidth - innerWidth,
              titleOverflow: title.scrollWidth - title.clientWidth,
              titleWidth: r.width,
              family,
              rowColor: rowTitle ? getComputedStyle(rowTitle).color : null,
            }
          })
          if (metrics.overflow > 1) {
            await page.screenshot({
              path: join(
                artifacts,
                `${slug}-${route.split("/")[1]}-overflow.png`
              ),
            })
            console.log(
              await page.locator("main").evaluate((main) => {
                const r = main.getBoundingClientRect()
                return [...main.querySelectorAll("*")]
                  .filter(
                    (e) =>
                      e.getBoundingClientRect().right > r.right + 1 &&
                      e.getBoundingClientRect().width > 0
                  )
                  .slice(0, 12)
                  .map((e) => ({
                    tag: e.tagName,
                    class: e.className,
                    text: e.textContent?.slice(0, 80),
                    right: e.getBoundingClientRect().right,
                  }))
              })
            )
          }
          assert.ok(
            metrics.overflow <= 1 && metrics.documentOverflow <= 1,
            `${slug}/${route}: page overflow ${JSON.stringify(metrics)}`
          )
          assert.ok(
            metrics.titleWidth >= 160 && metrics.titleOverflow <= 1,
            `${slug}/${route}: heading clipped`
          )
          if (scenario.font === "jetbrains-mono")
            assert.ok(
              metrics.family.includes("JetBrains"),
              `${slug}: selected font missing`
            )
          if (route.startsWith("/album") && scenario.theme === "light")
            assert.equal(
              metrics.rowColor,
              "rgb(13, 13, 13)",
              `${slug}: album track ignores light palette`
            )
          await page.screenshot({
            path: join(artifacts, `${slug}-${route.split("/")[1]}.png`),
          })
          if (route.startsWith("/artist") || route.startsWith("/album")) {
            const sharp = page.locator(".media-backdrop__sharp")
            assert.equal(
              await sharp
                .locator("img")
                .evaluate((element) => getComputedStyle(element).filter),
              "none",
              `${slug}/${route}: hero artwork must remain sharp`
            )
            await page.waitForFunction(
              () =>
                getComputedStyle(
                  document.querySelector(".media-backdrop__sharp")!
                ).position === "fixed"
            )
            const geometry = () =>
              page.evaluate(() => {
                const hero = document
                  .querySelector(".media-detail-hero")!
                  .getBoundingClientRect()
                const band = document.querySelector<HTMLElement>(
                  ".media-backdrop__sharp"
                )!
                const rect = band.getBoundingClientRect()
                const clip =
                  parseFloat(band.style.clipPath.split(" ")[2] ?? "0") || 0
                const area = document
                  .querySelector<HTMLElement>(
                    "#layout-fixture main .overflow-auto"
                  )!
                  .getBoundingClientRect()
                const ambient = document
                  .querySelector(".media-backdrop__ambient")!
                  .getBoundingClientRect()
                return {
                  seam: rect.bottom - clip - hero.bottom,
                  left: rect.left - area.left,
                  width: rect.width - area.width,
                  ambientTop: ambient.top - area.top,
                  ambientHeight: ambient.height - area.height,
                }
              })
            for (const amount of [0, 120]) {
              await page
                .locator("#layout-fixture main .overflow-auto")
                .evaluate((element, value) => {
                  element.scrollTop = value
                }, amount)
              await page.waitForTimeout(100)
              const aligned = await geometry()
              assert.ok(
                Object.values(aligned).every((value) => Math.abs(value) <= 1),
                `${slug}/${route}: artwork crop/seam is not aligned ${JSON.stringify(aligned)}`
              )
            }
            await page
              .locator("#layout-fixture main .overflow-auto")
              .evaluate((element) => {
                element.scrollTop = 0
              })
            await page.evaluate(() =>
              (window as any).fixtureAppearance.resetInteractions()
            )
            const play = page.getByRole("button", {
              name: "Play A Long Opening Track Title for the Midnight Ensemble",
              exact: true,
            })
            await play.focus()
            await page.keyboard.press("Enter")
            await page.keyboard.press("Space")
            const calls = await page.evaluate(() =>
              (window as any).fixtureAppearance.interactions()
            )
            assert.deepEqual(
              calls.map((call: any) => call.action),
              ["play", "play"],
              `${slug}/${route}: keyboard plays exactly once`
            )
            const queue = page.getByRole("button", {
              name: "Add A Long Opening Track Title for the Midnight Ensemble to queue",
              exact: true,
            })
            await queue.focus()
            await page.waitForTimeout(250)
            assert.equal(
              await queue.evaluate(
                (element) => getComputedStyle(element).opacity
              ),
              "1",
              `${slug}/${route}: focused action hidden`
            )
            await page.keyboard.press("Enter")
            assert.equal(
              (
                await page.evaluate(() =>
                  (window as any).fixtureAppearance.interactions()
                )
              ).at(-1).action,
              "queue"
            )
            const opener = page.getByRole("button", {
              name: "Artwork sources",
              exact: true,
            })
            await opener.click()
            const dialog = page.getByRole("dialog", { name: "Choose artwork" })
            await dialog.waitFor()
            const bounds = await dialog.evaluate((element) => {
              const r = element.getBoundingClientRect()
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                overflow: element.scrollWidth - element.clientWidth,
              }
            })
            assert.ok(
              bounds.left >= 0 &&
                bounds.right <= scenario.width + 1 &&
                bounds.top >= 0 &&
                bounds.bottom <= 851 &&
                bounds.overflow <= 1,
              `${slug}: artwork dialog clipped ${JSON.stringify(bounds)}`
            )
            await page.screenshot({
              path: join(
                artifacts,
                `${slug}-${route.split("/")[1]}-artwork.png`
              ),
            })
            await page.keyboard.press("Escape")
            await dialog.waitFor({ state: "detached" })
            assert.equal(
              await opener.evaluate(
                (element) => element === document.activeElement
              ),
              true,
              `${slug}: artwork focus not restored`
            )
          }
        }
      }
      // A wide pinned panel and narrow overlay both remain readable and independent.
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.evaluate(() => {
        ;(window as any).fixtureAppearance.apply({
          font: "jetbrains-mono",
          custom: true,
        })
        ;(window as any).setFixtureSidebarWidth(240)
        ;(window as any).fixtureAppearance.route("/search")
      })
      for (const panel of ["queue", "lyrics"] as const) {
        await page.evaluate(
          (value) => (window as any).fixtureAppearance.panel(value, true),
          panel
        )
        const close = page.getByRole("button", {
          name: `Close ${panel}`,
          exact: true,
        })
        await close.waitFor()
        await page.waitForTimeout(350)
        const region = close.locator(
          "xpath=ancestor::div[contains(@class,'relative')][1]"
        )
        const handle = region.locator(".cursor-ew-resize").first()
        const box = await handle.boundingBox()
        assert.ok(box, `${name}/${panel}: resize handle missing`)
        await page.mouse.move(box.x + 2, box.y + 50)
        await page.mouse.down()
        await page.mouse.move(box.x - 150, box.y + 50)
        await page.mouse.up()
        await page.waitForTimeout(350)
        const width = await region.evaluate(
          (element) => element.getBoundingClientRect().width
        )
        assert.ok(
          width >= 460 && width <= 480,
          `${name}/${panel}: resize failed (${width})`
        )
        await page.screenshot({
          path: join(artifacts, `${name}-${panel}-pinned-resized.png`),
        })
        if (panel === "queue") {
          const play = page.getByRole("button", {
            name: "Play Synthetic track 2",
            exact: true,
          })
          await play.focus()
          await page.keyboard.press("Space")
          assert.equal(
            (
              await page.evaluate(() =>
                (window as any).fixtureAppearance.interactions()
              )
            ).at(-1).action,
            "jump"
          )
        } else {
          for (const [mode, text] of [
            ["idle", "Play a track to see its lyrics"],
            ["loading", "Loading lyrics…"],
            ["empty", "No lyrics available"],
          ]) {
            await page.evaluate(
              (value) => (window as any).fixtureAppearance.lyrics(value),
              mode
            )
            await page.getByRole("status").filter({ hasText: text }).waitFor()
          }
          await page.evaluate(() =>
            (window as any).fixtureAppearance.lyrics("ready")
          )
          await page
            .getByRole("button", { name: /^Seek to Synthetic lyric/ })
            .click()
          assert.equal(
            (
              await page.evaluate(() =>
                (window as any).fixtureAppearance.interactions()
              )
            ).at(-1).action,
            "seek"
          )
        }
        await close.click()
        await page.waitForTimeout(350)
        assert.equal(
          await close.count(),
          0,
          `${name}/${panel}: closed controls accessible`
        )
      }
      assert.deepEqual(errors, [], `${name}: application errors`)
      console.log(
        `${name}: appearance, detail keyboard actions, artwork modal, pinned panels, resizing and lyric states passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  if (previousPlatform === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = previousPlatform
  server?.stop(true)
  await rm(output, { recursive: true, force: true })
}
