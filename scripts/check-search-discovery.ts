import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fixtureBuild, disposeFixture, fixtureFile, launchFixtureBrowser } from "./lib/browserFixtures"
import { chromium, webkit } from "playwright"

const root = resolve(import.meta.dir, "..")
const output = await fixtureBuild(["tests/fixtures/libraryLayout/index.html"], "darwin")
const artifacts = resolve(root, ".tmp/search-discovery-checks")
await mkdir(artifacts, { recursive: true })
const font = await Bun.file(
  resolve(
    root,
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
  )
).bytes()
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
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#7c3aed"/><circle cx="240" cy="240" r="110" fill="#c4b5fd"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      return fixtureFile(output,pathname)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await launchFixtureBrowser(type)
    try {
      const context = await browser.newContext()
      const requests: string[] = []
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin) return route.continue()
        if (
          url.hostname === "encore.scdn.co" &&
          /^\/fonts\/.*\.woff2?$/.test(url.pathname)
        )
          return route.fulfill({
            body: Buffer.from(font),
            contentType: "font/woff2",
          })
        requests.push(url.origin)
        return route.abort()
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(
        `${origin}/tests/fixtures/libraryLayout/index.html?discovery=1`
      )
      await page.waitForFunction(() => (window as any).visualFixtureReady)
      const recent = page.getByRole("region", {
        name: "Jump back in",
        exact: true,
      })
      const mixes = page.getByRole("region", {
        name: "Made for you",
        exact: true,
      })
      await mixes.waitFor()
      assert.equal(await recent.locator("a").count(), 6)
      assert.equal(await mixes.locator('a[href="/mix"]').count(), 6)
      assert.equal(
        await page
          .getByRole("heading", { name: "Recently Added", exact: true })
          .count(),
        0
      )
      for (const [width, sidebar, theme] of [
        [1440, 240, "dark"],
        [800, 240, "dark"],
        [800, 320, "light"],
      ] as const) {
        await page.setViewportSize({
          width,
          height: width === 800 ? 650 : 1000,
        })
        await page.evaluate(
          ({ sidebar, theme }) => {
            ;(window as any).setFixtureSidebarWidth(sidebar)
            ;(window as any).fixtureSearch.theme(theme)
          },
          { sidebar, theme }
        )
        // Palette changes animate on links/cards. Capture their settled colors.
        await page.waitForFunction((light) => {
          const tile = document.querySelector(
            'section[aria-label="Jump back in"] a'
          )!
          const card = document.querySelector(
            'section[aria-label="Made for you"] a'
          )!.parentElement!
          return (
            getComputedStyle(tile).color ===
              (light ? "rgb(13, 13, 13)" : "rgb(255, 255, 255)") &&
            getComputedStyle(card).backgroundColor ===
              (light ? "rgb(228, 228, 228)" : "rgb(40, 40, 40)")
          )
        }, theme === "light")
        await page.screenshot({
          path: join(artifacts, `${name}-${width}-${sidebar}-${theme}.png`),
        })
        const geometry = await page.evaluate(() => {
          const main = document.querySelector<HTMLElement>(
            '#layout-fixture main[role="main"]'
          )!
          const bounds = main.getBoundingClientRect()
          return {
            documentOverflow:
              document.documentElement.scrollWidth - window.innerWidth,
            mainOverflow: main.scrollWidth - main.clientWidth,
            sectionsContained: [...main.querySelectorAll("section")].every(
              (section) => {
                const rect = section.getBoundingClientRect()
                return (
                  rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
                )
              }
            ),
          }
        })
        assert.ok(
          geometry.documentOverflow <= 1,
          `${name}/${width}: document overflow`
        )
        assert.ok(geometry.mainOverflow <= 1, `${name}/${width}: main overflow`)
        assert.ok(
          geometry.sectionsContained,
          `${name}/${width}: discovery exceeds its column`
        )
        const lastMix = mixes.locator('a[href="/mix"]').nth(5)
        // A viewport resize leaves the previous link focused; focus it anew
        // from the search field to exercise the keyboard's reveal behavior.
        await page
          .getByRole("combobox", { name: "Search your music library" })
          .focus()
        await lastMix.focus()
        const focusBounds = await lastMix.evaluate((element) => {
          const parent = element.parentElement!
          const row = parent.getBoundingClientRect()
          const card = element.getBoundingClientRect()
          return {
            rowLeft: row.left,
            rowRight: row.right,
            cardLeft: card.left,
            cardRight: card.right,
            scrollLeft: parent.scrollLeft,
            clientWidth: parent.clientWidth,
            focused: document.activeElement === element,
          }
        })
        assert.ok(
          focusBounds.cardLeft >= focusBounds.rowLeft - 1 &&
            focusBounds.cardRight <= focusBounds.rowRight + 1,
          `${name}/${width}: keyboard focus does not reveal the last mix ${JSON.stringify(focusBounds)}`
        )
        // Full Search deliberately uses its page results rather than a popup.
        // Exercise the navbar dropdown from Home, then return to discovery.
        await page.evaluate(() => { history.pushState({}, "", "/"); dispatchEvent(new PopStateEvent("popstate")) })
        const input = page.getByRole("combobox", { name: "Search your music library" })
        await input.focus()
        await input.click()
        const popup = page.getByRole("listbox")
        await popup.waitFor()
        const panelGeometry = async () => popup.evaluate(element => {
          const rect = element.getBoundingClientRect()
          const pane = element.closest(".app-page")!.getBoundingClientRect()
          const scroll = element.querySelector<HTMLElement>("[data-search-scroll]")!
          const footer = element.querySelector<HTMLElement>("[data-search-footer]")!.getBoundingClientRect()
          return { top: rect.top, bottom: rect.bottom, height: rect.height, available: Math.min(innerHeight, pane.bottom) - rect.top - 12,
            scrollBottom: scroll.getBoundingClientRect().bottom, footerTop: footer.top, scrollOverflow: scroll.scrollHeight - scroll.clientHeight }
        })
        const before = await panelGeometry()
        assert.ok(Math.abs(before.height - before.available) <= 2, `${name}/${width}: dropdown does not fill its available height ${JSON.stringify(before)}`)
        assert.ok(before.scrollBottom <= before.footerTop + 1, `${name}: results overlap the fixed footer`)
        await input.fill("Opening")
        await popup.locator('[role="option"]').filter({ hasText: "Opening Track" }).waitFor()
        const after = await panelGeometry()
        assert.ok(Math.abs(after.height - before.height) <= 2, `${name}: short search changed panel height`)
        if (width === 1440) await page.screenshot({ path: join(artifacts, `${name}-search-panel.png`) })
        await page.keyboard.press("Escape")
        await page.evaluate(() => {
          ;(window as any).fixtureSearch.clear()
          history.pushState({}, "", "/search"); dispatchEvent(new PopStateEvent("popstate"))
        })
        await mixes.waitFor()
      }
      await mixes.locator('a[href="/mix"]').nth(5).press("Enter")
      await page
        .getByRole("heading", { name: "Discovery artist 6 Mix", exact: true })
        .waitFor()
      await page.evaluate(() => {
        history.pushState({}, "", "/search")
        dispatchEvent(new PopStateEvent("popstate"))
      })
      await mixes.waitFor()
      await page.evaluate(() => (window as any).fixtureSearch.query("Opening"))
      await page
        .getByRole("heading", { name: "Results for “Opening”", exact: true })
        .waitFor()
      assert.equal(
        await mixes.count(),
        0,
        `${name}: discovery remains over active search results`
      )
      await page.evaluate(() => (window as any).fixtureSearch.clear())
      await mixes.waitFor()
      await page.evaluate(() => (window as any).fixtureSearch.connected(false))
      await page
        .getByRole("link", { name: "Connect a library", exact: true })
        .waitFor()
      assert.equal(
        await recent.count(),
        0,
        `${name}: disconnected view exposes prior listening`
      )
      assert.equal(
        await mixes.count(),
        0,
        `${name}: disconnected view exposes prior mixes`
      )
      assert.deepEqual(requests, [], `${name}: unexpected public requests`)
      assert.deepEqual(errors, [], `${name}: renderer errors`)
      console.log(
        `${name}: discovery geometry, keyboard mix selection, query transitions and account retirement passed`
      )
      await context.close()
    } finally {
      await browser.close()
    }
  }
} finally {
  server?.stop(true)
  if (originalPlatform === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = originalPlatform
  await disposeFixture(output)
}
