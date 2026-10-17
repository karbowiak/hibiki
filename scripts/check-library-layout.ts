import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fixtureBuild, disposeFixture, fixtureFile, launchFixtureBrowser } from "./lib/browserFixtures"
import { chromium, webkit } from "playwright"

const root = resolve(import.meta.dir, "..")
const output = await fixtureBuild(["tests/fixtures/libraryLayout/index.html"], "darwin")
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
const allGeometryFailures: string[] = []
const originalPlatform = process.env.TAURI_ENV_PLATFORM
process.env.TAURI_ENV_PLATFORM = "darwin"
let server: ReturnType<typeof Bun.serve> | undefined
try {

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith("/synthetic-artwork/"))
        return new Response(artwork, {
          headers: { "Content-Type": "image/svg+xml" },
        })
      return fixtureFile(output,pathname)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  for (const [name, type] of [
    ["chrome", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await launchFixtureBrowser(type)
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
      for (const [width, sidebar] of process.env.HIBIKI_LAYOUT_SCOPE === "home"
        ? []
        : ([
            [1440, 240],
            [800, 240],
            [800, 320],
          ] as const)) {
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
          // Lazy route imports can still be suspended on a busy CI worker.
          // Geometry is meaningful only after the real heading is painted.
          await page.locator("#layout-fixture main h1").first().waitFor({ state: "visible" })
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
                ? '#layout-fixture main .group:has(> a[href^="/playlist/"]) button[aria-label^="Play "]'
                : '#layout-fixture main button[aria-label^="Play "]'
            // Reach the control through keyboard navigation. Programmatic focus
            // after Tab can inherit a different focus-visible modality in WebKit.
            const target = page.locator(selector).first()
            await page.evaluate(() => {
              // Reset the sequential navigation start point after route changes.
              document.body.tabIndex = -1
              document.body.focus()
              document.body.removeAttribute("tabindex")
            })
            let reached = false
            for (let step = 0; step < 300; step++) {
              await page.keyboard.press(
                name === "webkit" && process.platform === "darwin"
                  ? "Alt+Tab"
                  : "Tab"
              )
              reached = await target.evaluate(
                (element) => document.activeElement === element
              )
              if (reached) break
            }
            assert.ok(
              reached,
              `${name}/${slug}/${width}/${sidebar}: Play control unreachable by Tab`
            )
            await page
              .waitForFunction(
                (query) => {
                  const element = document.querySelector(query)
                  if (!element || !element.matches(":focus-visible"))
                    return false
                  let current: Element | null = element
                  while (current) {
                    if (Number(getComputedStyle(current).opacity) < 0.99)
                      return false
                    current = current.parentElement
                  }
                  const style = getComputedStyle(element)
                  return (
                    style.boxShadow.includes("2px") ||
                    (style.outlineStyle !== "none" &&
                      parseFloat(style.outlineWidth) >= 2)
                  )
                },
                selector,
                { timeout: 3000 }
              )
              .catch(async (error) => {
                await page.screenshot({
                  path: join(
                    artifactDir,
                    `${name}-${slug}-${width}-${sidebar}-focus-failure.png`
                  ),
                })
                const focus = await target.evaluate((element) => ({
                  active: document.activeElement === element,
                  focusVisible: element.matches(":focus-visible"),
                  opacity: getComputedStyle(element).opacity,
                  ancestors: (() => {
                    const values: { tag: string; opacity: string }[] = []
                    let parent = element.parentElement
                    while (parent) {
                      values.push({
                        tag: parent.tagName,
                        opacity: getComputedStyle(parent).opacity,
                      })
                      parent = parent.parentElement
                    }
                    return values
                  })(),
                  boxShadow: getComputedStyle(element).boxShadow,
                }))
                throw new Error(
                  `${name}/${slug}/${width}/${sidebar}: hidden/unmarked focused Play control ${JSON.stringify(focus)}`,
                  { cause: error }
                )
              })
            await page.screenshot({
              path: join(
                artifactDir,
                `${name}-${slug}-${width}-${sidebar}-keyboard.png`
              ),
            })
          }
        }
      }
      const geometryFailures: string[] = []
      await page.goto(
        `${origin}/tests/fixtures/libraryLayout/index.html?player=1`
      )
      await page.waitForFunction(
        () => (window as any).visualFixtureReady === true
      )
      for (const scenario of [
        { width: 1920, count: 5, compact: false, theme: "dark" },
        { width: 1920, count: 6, compact: false, theme: "dark" },
        { width: 1920, count: 5, compact: true, theme: "dark" },
        {
          width: 1920,
          count: 6,
          compact: false,
          theme: "dark",
          activeModes: true,
        },
        {
          width: 1920,
          count: 5,
          compact: false,
          theme: "dark",
          expandedArt: true,
        },
        { width: 1440, count: 5, compact: false, theme: "dark" },
        {
          width: 1440,
          count: 6,
          compact: false,
          theme: "dark",
          activeModes: true,
        },
        { width: 1321, count: 5, compact: false, theme: "dark" },
        {
          width: 1321,
          count: 6,
          compact: false,
          theme: "dark",
          activeModes: true,
        },
        { width: 1100, count: 5, compact: false, theme: "dark" },
        {
          width: 1100,
          count: 5,
          compact: false,
          theme: "dark",
          activeModes: true,
        },
        { width: 800, count: 5, compact: false, theme: "dark" },
        {
          width: 800,
          count: 6,
          compact: true,
          theme: "light",
          activeModes: true,
        },
        {
          width: 800,
          count: 5,
          compact: true,
          theme: "light",
          activeModes: true,
          expandedArt: true,
        },
      ]) {
        const slug = `home-player-${scenario.width}-${scenario.count}-${scenario.compact ? "compact" : "normal"}-${scenario.theme}-${scenario.activeModes ? "active-modes" : "plain"}-${scenario.expandedArt ? "expanded" : "small-art"}`
        await page.setViewportSize({
          width: scenario.width,
          height: scenario.width === 800 ? 650 : 1080,
        })
        await page.evaluate(
          ({ count, compact, theme, activeModes, expandedArt }) => {
            ;(window as any).setFixtureSidebarWidth(240)
            ;(window as any).setFixtureHome(
              count,
              compact,
              theme,
              activeModes,
              expandedArt
            )
          },
          scenario
        )
        await page.waitForFunction(
          () =>
            document.querySelector(
              '#layout-fixture main a[href="/stations"]'
            ) !== null
        )
        await page.waitForTimeout(300)
        const metrics = await page.evaluate(() => {
          const host = document.querySelector<HTMLElement>("#layout-fixture")!
          const main = host.querySelector<HTMLElement>("main")!
          const scroller = main.querySelector<HTMLElement>(".overflow-auto")!
          const title = main.querySelector<HTMLElement>('a[href="/stations"]')!
          const row =
            title.closest("h2")?.parentElement?.parentElement ??
            title.parentElement!.parentElement!
          const cards = [
            ...row.querySelectorAll<HTMLElement>(".media-card"),
          ].filter((element) => element.querySelector("img"))
          const footer = host.querySelector<HTMLElement>(".player-body")!
          const bounds = (element: Element) => {
            const rect = element.getBoundingClientRect()
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              centerY: (rect.top + rect.bottom) / 2,
            }
          }
          const track = footer.querySelector<HTMLElement>(".player-track")!
          const groups = [
            track,
            footer.querySelector<HTMLElement>(".player-center-content")!,
            footer.querySelector<HTMLElement>(".player-tools")!,
          ].map(bounds)
          const buttons = [
            ...footer.querySelectorAll<HTMLElement>(
              'button,input[type="range"],[role="slider"]'
            ),
          ].filter((element) => {
            const rect = element.getBoundingClientRect()
            if (
              !rect.width ||
              !rect.height ||
              getComputedStyle(element).visibility === "hidden"
            )
              return false
            let parent: HTMLElement | null = element
            while (parent && parent !== footer) {
              // A transparent seek input is an intentional click target.
              if (
                Number(getComputedStyle(parent).opacity) < 0.99 &&
                parent.tagName !== "INPUT"
              )
                return false
              parent = parent.parentElement
            }
            return true
          })
          const overlaps: string[] = []
          for (let i = 0; i < buttons.length; i++) {
            for (let j = i + 1; j < buttons.length; j++) {
              const a = buttons[i],
                b = buttons[j]
              if (a.contains(b) || b.contains(a)) continue
              const ar = a.getBoundingClientRect(),
                br = b.getBoundingClientRect()
              if (
                Math.min(ar.right, br.right) - Math.max(ar.left, br.left) > 1 &&
                Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top) > 1
              )
                overlaps.push(
                  `${a.getAttribute("aria-label") ?? a.getAttribute("title") ?? a.tagName} / ${b.getAttribute("aria-label") ?? b.getAttribute("title") ?? b.tagName}`
                )
            }
          }
          const nav = host.querySelector<HTMLElement>(
            'nav[aria-label="Main navigation"]'
          )!
          const active = nav.querySelector<HTMLElement>(
            'a[aria-current="page"]'
          )!
          return {
            mixCount: cards.length,
            mixLeft: bounds(cards[0]).left,
            titleLeft: bounds(title).left,
            mainOverflow: scroller.scrollWidth - scroller.clientWidth,
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
            footer: bounds(footer),
            groups,
            overlaps,
            blockedTargets: buttons
              .filter((button) => {
                const r = button.getBoundingClientRect()
                const hit = document.elementFromPoint(
                  r.left + r.width / 2,
                  r.top + r.height / 2
                )
                return !hit || !button.contains(hit)
              })
              .map(
                (button) =>
                  button.getAttribute("aria-label") ??
                  button.getAttribute("title") ??
                  button.tagName
              ),
            offscreenTargets: buttons
              .filter((button) => {
                const r = bounds(button)
                return (
                  r.left < 0 ||
                  r.right > innerWidth + 1 ||
                  r.top < bounds(footer).top - 1 ||
                  r.bottom > innerHeight + 1
                )
              })
              .map(
                (button) =>
                  button.getAttribute("aria-label") ??
                  button.getAttribute("title") ??
                  button.tagName
              ),
            trackOverflow: track.scrollWidth - track.clientWidth,
            labels: [...track.querySelectorAll("h6,p")].map(bounds),
            activeHref: active?.getAttribute("href"),
            active: active ? bounds(active) : null,
            nav: bounds(nav),
          }
        })
        // Save the actual failing view as well as passing views for useful diagnosis.
        await page.screenshot({
          path: join(artifactDir, `${name}-${slug}.png`),
        })
        console.log(`${name}/${slug}: ${JSON.stringify(metrics)}`)
        try {
          assert.equal(
            metrics.mixCount,
            scenario.count,
            `${name}/${slug}: missing mix cards`
          )
          assert.ok(
            Math.abs(metrics.mixLeft - metrics.titleLeft) <= 1,
            `${name}/${slug}: short mixes centered away from title (${metrics.mixLeft - metrics.titleLeft}px)`
          )
          assert.ok(
            metrics.mainOverflow <= 1 && metrics.documentOverflow <= 1,
            `${name}/${slug}: horizontal overflow`
          )
          if (scenario.width >= 1400) {
            for (const group of metrics.groups) {
              assert.ok(
                Math.abs(group.centerY - metrics.footer.centerY) <= 2,
                `${name}/${slug}: complete player group not vertically centered (${group.centerY - metrics.footer.centerY}px)`
              )
            }
          }
          assert.deepEqual(
            metrics.overlaps,
            [],
            `${name}/${slug}: overlapping player click targets`
          )
          assert.deepEqual(
            metrics.blockedTargets,
            [],
            `${name}/${slug}: player controls covered or not hit-testable`
          )
          assert.deepEqual(
            metrics.offscreenTargets,
            [],
            `${name}/${slug}: clipped player click targets`
          )
          assert.ok(
            metrics.trackOverflow <= 1,
            `${name}/${slug}: long player information escapes its group`
          )
          assert.ok(
            metrics.labels.every(
              (label) =>
                label.width >= 60 &&
                label.left >= metrics.groups[0].left - 1 &&
                label.right <= metrics.groups[0].right + 1
            ),
            `${name}/${slug}: collapsed or escaping long labels`
          )
          assert.equal(
            metrics.activeHref,
            "/",
            `${name}/${slug}: Home navigation not active`
          )
          assert.ok(
            metrics.active &&
              metrics.active.left >= metrics.nav.left &&
              metrics.active.right <= metrics.nav.right + 1,
            `${name}/${slug}: active sidebar item escapes navigation`
          )
        } catch (error) {
          if (process.env.HIBIKI_LAYOUT_REPORT !== "1") throw error
          geometryFailures.push(String(error))
        }
      }
      console.log(
        `${name}: geometry failures ${JSON.stringify(geometryFailures)}`
      )
      allGeometryFailures.push(...geometryFailures)
      if (process.env.HIBIKI_LAYOUT_REPORT !== "1")
        assert.deepEqual(geometryFailures, [], `${name}: geometry failures`)
      assert.deepEqual(errors, [], `${name}: page errors`)
      console.log(
        `${name}: library routes/focus and real Home/Player geometry checked`
      )
    } finally {
      await browser.close()
    }
  }
  assert.deepEqual(allGeometryFailures, [], "Home/Player geometry failures")
} finally {
  if (originalPlatform === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = originalPlatform
  server?.stop(true)
  await disposeFixture(output)
}
