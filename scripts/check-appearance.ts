import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"
import { chromium, webkit } from "playwright"
import { podcastFeedPath } from "../src/lib/podcastRoute"
import { artworkContrast } from "../src/lib/artworkTone"

// Real components and stores, disposable preferences and playback, no account I/O.
const root = resolve(import.meta.dir, "..")
const output = await mkdtemp(join(tmpdir(), "hibiki-appearance-"))
const artifacts = resolve(root, ".tmp/appearance-checks")
await mkdir(artifacts, { recursive: true })
const previousPlatform = process.env.TAURI_ENV_PLATFORM
// Browser fixtures exercise Tauri's supported HTTP image transport; native Mac is reviewed separately.
process.env.TAURI_ENV_PLATFORM = "windows"
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
          `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="${path.includes("replacement") ? "#0891b2" : path.includes("next") ? "#f97316" : "#7c3aed"}"/></svg>`,
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
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        if (url.hostname === "image.localhost") {
          const src = url.searchParams.get("src")
          if (src && new URL(src).origin === origin) {
            const response = await fetch(src)
            return route.fulfill({
              status: response.status,
              headers: {
                "Content-Type": "image/svg+xml",
                "Access-Control-Allow-Origin": "*",
              },
              body: Buffer.from(await response.arrayBuffer()),
            })
          }
          return route.abort()
        }
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
          "/playlist/fixture-playlist-0",
          "/podcasts",
          "/internet-radio",
          podcastFeedPath("https://synthetic.invalid/music.xml")!,
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
          if (route === "/podcasts" || route === "/internet-radio") {
            const card = page.locator(".broadcast-card").first()
            const title = await card.locator(".media-card__title").innerText()
            await card.locator(".media-card__primary").click({ button: "right" })
            const menu = page.getByRole("dialog", { name: `${title} actions`, exact: true })
            await menu.waitFor()
            assert.ok(await menu.getByRole("button").count() >= 1, `${slug}: public card actions missing`)
            await page.keyboard.press("Escape")
            await menu.waitFor({ state: "detached" })
            await card.locator(".media-card__primary").focus()
            await page.keyboard.press("Shift+F10")
            await menu.waitFor()
            await page.keyboard.press("Control+k")
            await menu.waitFor({ state: "detached" })
            assert.equal(await page.getByRole("combobox", { name: "Search your music library" }).evaluate(element => element === document.activeElement), true, `${slug}: search failed from public card menu`)
            await page.keyboard.press("Escape")
          }
          if (route.startsWith("/artist") || route.startsWith("/album")) {
            const sharp = page.locator(
              ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp"
            )
            assert.equal(
              await sharp
                .locator("img")
                .evaluate((element) => getComputedStyle(element).filter),
              "none",
              `${slug}/${route}: hero artwork must remain sharp`
            )
            const geometry = () =>
              page.evaluate(() => {
                const hero = document
                  .querySelector(".media-detail-hero")!
                  .getBoundingClientRect()
                const band = document.querySelector<HTMLElement>(
                  ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-sharp"
                )!
                const rect = band.getBoundingClientRect()
                const clip =
                  parseFloat(band.style.clipPath.split(" ")[2] ?? "0") || 0
                const ambient = document
                  .querySelector(
                    ".app-artwork-frame:not(.app-artwork-frame--retiring) .app-artwork-ambient"
                  )!
                  .getBoundingClientRect()
                return {
                  seam: rect.bottom - clip - Math.min(innerHeight, hero.bottom),
                  left: rect.left,
                  width: rect.width - innerWidth,
                  ambientTop: ambient.top,
                  ambientHeight: ambient.height - innerHeight,
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
              name: /^Edit .+ artwork sources$/,
            })
            await opener.focus()
            await page.waitForFunction(
              () =>
                document.activeElement?.classList.contains(
                  "artwork-edit-trigger"
                ) && getComputedStyle(document.activeElement).opacity === "1"
            )
            assert.equal(
              await opener.evaluate(
                (element) => getComputedStyle(element).opacity
              ),
              "1",
              `${slug}: focused edit pen hidden`
            )
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
      // Real shell: stable pool, full-window pixels, palette contrast and image transitions.
      await page.evaluate(() => {
        ;(window as any).fixtureAppearance.panel(null)
        ;(window as any).fixtureAppearance.apply({})
        ;(window as any).fixtureAppearance.route("/search")
      })
      const active = page.locator(
        ".app-artwork-frame:not(.app-artwork-frame--retiring)"
      )
      await active.waitFor()
      await page.waitForTimeout(700)
      const firstSource = await active
        .locator("img")
        .first()
        .getAttribute("src")
      await page
        .getByRole("combobox", { name: "Search your music library" })
        .fill("synthetic")
      await page.waitForTimeout(300)
      assert.equal(
        await active.locator("img").first().getAttribute("src"),
        firstSource,
        `${name}: typing rotates artwork`
      )
      await page
        .getByRole("combobox", { name: "Search your music library" })
        .fill("")
      for (const settings of [
        { theme: "dark" },
        { theme: "light" },
        { theme: "dark", custom: true },
      ]) {
        await page.evaluate(
          (value) => (window as any).fixtureAppearance.apply(value),
          settings
        )
        await page.waitForTimeout(550)
        const colors = await page.evaluate(() => {
          const shell =
            document.querySelector<HTMLElement>(".app-artwork-shell")!
          const style = getComputedStyle(shell)
          const rgb = (value: string) => {
            const canvas = document.createElement("canvas")
            canvas.width = canvas.height = 1
            const context = canvas.getContext("2d")!
            context.fillStyle = value
            context.fillRect(0, 0, 1, 1)
            return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
          }
          const play = document.querySelector<HTMLElement>(
            ".app-playbar .shell-control-primary"
          )!
          const ps = getComputedStyle(play)
          return {
            text: rgb(style.getPropertyValue("--artwork-accent-text")),
            base: rgb(style.getPropertyValue("--bg-base")),
            ink: rgb(ps.color),
            primary: rgb(ps.backgroundColor),
            bars: [
              ...document.querySelectorAll<HTMLElement>(
                ".shell-artwork-surface"
              ),
            ].map((e) => getComputedStyle(e).backgroundColor),
            rect: document
              .querySelector(".app-artwork-background")!
              .getBoundingClientRect()
              .toJSON(),
          }
        })
        assert.ok(
          artworkContrast(colors.text as any, colors.base as any) >= 6.99,
          `${name}: artwork text lacks contrast`
        )
        assert.ok(
          artworkContrast(colors.ink as any, colors.primary as any) >= 4.5,
          `${name}: play button lacks contrast`
        )
        assert.equal(
          new Set(colors.bars).size,
          1,
          `${name}: shell tints differ`
        )
        assert.ok(
          colors.rect.width === 1440 &&
            colors.rect.height === 900 &&
            colors.rect.x === 0 &&
            colors.rect.y === 0,
          `${name}: backdrop excludes part of the app`
        )
      }
      const stablePlayback = await page
        .locator(".playback-palette")
        .evaluate((e) =>
          getComputedStyle(e).getPropertyValue("--artwork-primary")
        )
      const stableCreate = await page
        .getByRole("button", { name: "Create Playlist", exact: true })
        .evaluate((e) =>
          getComputedStyle(e).getPropertyValue("--artwork-primary")
        )
      await page.evaluate(() =>
        (window as any).fixtureArtwork.replace("replacement.svg")
      )
      await page.waitForFunction(() =>
        document
          .querySelector<HTMLImageElement>(
            ".app-artwork-frame:not(.app-artwork-frame--retiring) img"
          )
          ?.src.includes("replacement.svg")
      )
      const layers = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".app-artwork-frame")].map(
          (e) => ({
            old: e.classList.contains("app-artwork-frame--retiring"),
            opacity: Number(getComputedStyle(e).opacity),
            animation: getComputedStyle(e).animationName,
          })
        )
      )
      assert.equal(
        layers.length,
        2,
        `${name}: prior artwork disappears before image fade`
      )
      assert.equal(
        layers.find((e) => e.old)?.opacity,
        1,
        `${name}: transition fades through empty background`
      )
      assert.equal(layers.find((e) => !e.old)?.animation, "artwork-fade-in")
      await page.waitForTimeout(700)
      assert.equal(await page.locator(".app-artwork-frame").count(), 1)
      await page.screenshot({
        path: join(artifacts, `${name}-artwork-shell.png`),
      })
      assert.equal(
        await page
          .locator(".playback-palette")
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("--artwork-primary")
          ),
        stablePlayback,
        `${name}: page changed the playing album palette`
      )
      assert.equal(
        await page
          .getByRole("button", { name: "Create Playlist", exact: true })
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("--artwork-primary")
          ),
        stableCreate,
        `${name}: page changed Create Playlist color`
      )
      assert.notEqual(
        await page
          .locator(".app-artwork-shell")
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("--artwork-primary")
          ),
        stablePlayback,
        `${name}: fixture did not exercise different page and playback palettes`
      )
      await page.evaluate(() => (window as any).fixtureArtwork.multiple())
      await page
        .getByRole("button", { name: "Next background image", exact: true })
        .click()
      await page.waitForFunction(() =>
        document
          .querySelector<HTMLImageElement>(
            ".app-artwork-frame:not(.app-artwork-frame--retiring) img"
          )
          ?.src.includes("next.svg")
      )
      assert.equal(
        await page
          .locator(".playback-palette")
          .evaluate((e) =>
            getComputedStyle(e).getPropertyValue("--artwork-primary")
          ),
        stablePlayback
      )
      await page
        .getByRole("button", {
          name: "Resume background rotation",
          exact: true,
        })
        .click()
      await page
        .getByRole("button", { name: "Pause background rotation", exact: true })
        .click()
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/library")
      )
      await page.keyboard.press("Control+k")
      const searchBox = page.getByRole("combobox", {
        name: "Search your music library",
      })
      await page.waitForFunction(
        () =>
          document.querySelector('[role="combobox"]') === document.activeElement
      )
      assert.equal(await searchBox.getAttribute("aria-expanded"), "true")
      await page.keyboard.press("Escape")
      const menuCard = page.locator("main .media-card__primary").first()
      await menuCard.click({ button: "right" })
      await page.getByRole("dialog", { name: / actions$/ }).waitFor()
      await page.keyboard.press("Control+k")
      await page.waitForFunction(
        () =>
          document.querySelector('[role="combobox"]') === document.activeElement
      )
      assert.equal(
        await page.getByRole("dialog", { name: / actions$/ }).count(),
        0
      )
      await page.keyboard.press("Escape")
      await page.setViewportSize({ width: 800, height: 850 })
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/playlist/fixture-playlist-0")
      )
      const tableScroll = page.getByRole("region", {
        name: "Song table",
        exact: true,
      })
      await tableScroll.waitFor()
      await page.evaluate(() =>
        (window as any).fixtureAppearance.resetInteractions()
      )
      await tableScroll.focus()
      await page.keyboard.press("ArrowRight")
      await page.waitForTimeout(150)
      assert.ok(
        await tableScroll.evaluate((e) => e.scrollLeft > 0),
        `${name}: wide song table cannot be scrolled by keyboard`
      )
      assert.equal(
        (
          await page.evaluate(() =>
            (window as any).fixtureAppearance.interactions()
          )
        ).length,
        0,
        `${name}: table scroll changed playback`
      )
      const seek = page.getByRole("slider", { name: "Seek", exact: true })
      await page.evaluate(() =>
        (window as any).fixtureAppearance.resetInteractions()
      )
      await seek.focus()
      await page.keyboard.press("ArrowRight")
      assert.equal(
        (
          await page.evaluate(() =>
            (window as any).fixtureAppearance.interactions()
          )
        ).at(-1)?.action,
        "seek",
        `${name}: waveform changes broke keyboard seeking`
      )
      await page.evaluate(() =>
        (window as any).fixtureAppearance.apply({ background: false })
      )
      assert.equal(await page.locator(".app-artwork-frame").count(), 0)
      const opaque = await page
        .locator(".app-playbar")
        .evaluate((e) => getComputedStyle(e).backgroundColor)
      assert.ok(
        !opaque.includes("rgba") && !opaque.includes("0.76"),
        `${name}: disabled background leaves transparent playbar`
      )
      await page.evaluate(() =>
        (window as any).fixtureAppearance.apply({ background: true })
      )
      await active.waitFor()
      await page.evaluate(() => (window as any).fixtureArtwork.retire())
      assert.equal(
        await page.locator(".app-artwork-frame").count(),
        0,
        `${name}: old account image remains visible`
      )
      assert.equal(
        await page
          .locator(".app-artwork-shell")
          .getAttribute("data-artwork-colors"),
        "off"
      )
      assert.deepEqual(errors, [], `${name}: application errors`)
      console.log(
        `${name}: appearance, full-window artwork, palette contrast, fades, seeking, detail actions and panels passed`
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
