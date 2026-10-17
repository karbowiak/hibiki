import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fixtureBuild, disposeFixture, fixtureFile, launchFixtureBrowser } from "./lib/browserFixtures"
import { chromium, webkit } from "playwright"

const root = resolve(import.meta.dir, "..")
const output = await fixtureBuild(["tests/fixtures/libraryLayout/index.html"], "darwin")
const artifactDir = resolve(root, ".tmp/notification-checks")
await mkdir(artifactDir, { recursive: true })
const artwork =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7c3aed"/></svg>'
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
      await page.goto(
        `${origin}/tests/fixtures/libraryLayout/index.html?notifications=1`
      )
      await page.waitForFunction(
        () => (window as any).visualFixtureReady === true
      )
      await page.evaluate(() => {
        ;(window as any).setFixtureHome(5)
        ;(window as any).fixtureNotifications.seed()
      })
      const bell = page.getByRole("button", { name: /^Notifications/ })
      await bell.waitFor({ timeout: 10000 })
      assert.equal(
        await bell.getAttribute("aria-label"),
        "Notifications, 2 unread",
        `${name}: unread badge missing`
      )
      const snapshot = () =>
        page.evaluate(() => (window as any).fixtureNotifications.snapshot())
      const warning = () =>
        snapshot().then((entries) =>
          entries.find((entry: any) => entry.id === "fixture-warning")
        )
      await page
        .getByRole("button", {
          name: "Dismiss notification: Fixture listening sync requires attention",
        })
        .click()
      const original = await warning()
      assert.equal(original.active, true)
      assert.equal(original.toastVisible, false)
      await page.evaluate(() => (window as any).fixtureNotifications.poll())
      assert.equal(
        (await warning()).toastVisible,
        false,
        `${name}: repeated persistent poll re-toasted`
      )
      assert.equal((await warning()).toastRevision, original.toastRevision)
      await bell.click()
      const panel = page.getByRole("dialog", {
        name: "Notifications",
        exact: true,
      })
      await panel.waitFor()
      await page.waitForFunction(() =>
        (window as any).fixtureNotifications
          .snapshot()
          .every((entry: any) => !entry.unread)
      )
      assert.equal(
        await panel
          .getByText("Still waiting after the next synthetic status poll.")
          .count(),
        1
      )
      assert.equal(await bell.getAttribute("aria-label"), "Notifications")
      await page.screenshot({
        path: join(artifactDir, `${name}-desktop-history.png`),
      })
      await panel
        .getByRole("button", { name: "Clear history", exact: true })
        .click()
      assert.equal(
        (await snapshot()).length,
        1,
        `${name}: clear history did not retain only the active issue`
      )
      assert.equal((await warning()).active, true)
      await page.keyboard.press("Escape")
      await panel.waitFor({ state: "hidden" })
      assert.equal(
        await bell.evaluate((element) => document.activeElement === element),
        true,
        `${name}: Escape did not restore bell focus`
      )
      await page.evaluate(() => (window as any).fixtureNotifications.recur())
      await page
        .getByRole("button", { name: "Retry fixture", exact: true })
        .waitFor()
      // Two synchronous UI activations exercise panel/toast shared dedup before React paints pending state.
      await page
        .getByRole("button", { name: "Retry fixture", exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click()
          button.click()
        })
      await page.waitForFunction(
        () => (window as any).fixtureNotifications.retryCalls() === 1
      )
      const toast = page
        .getByRole("status")
        .filter({ hasText: "Fixture listening sync requires attention" })
      assert.equal(
        await toast
          .getByRole("button", { name: "Working…", exact: true })
          .isDisabled(),
        true
      )
      await bell.click()
      await panel.waitFor()
      assert.equal(
        await panel
          .getByRole("button", { name: "Working…", exact: true })
          .isDisabled(),
        true
      )
      await page.waitForFunction(() =>
        (window as any).fixtureNotifications
          .snapshot()
          .every((entry: any) => !entry.toastVisible)
      )
      await page
        .getByRole("status")
        .filter({ hasText: "Fixture" })
        .waitFor({ state: "hidden" })
      assert.equal(
        await page.getByRole("status").filter({ hasText: "Fixture" }).count(),
        0,
        `${name}: opening history did not acknowledge toasts`
      )
      await page.evaluate(() =>
        (window as any).fixtureNotifications.finishRetry()
      )
      await page.waitForFunction(
        () =>
          !(window as any).fixtureNotifications
            .snapshot()
            .find((entry: any) => entry.id === "fixture-warning").active
      )
      assert.equal(
        await panel
          .getByRole("button", { name: "Retry fixture", exact: true })
          .count(),
        0
      )
      assert.equal(
        await toast.count(),
        0,
        `${name}: resolved retry toast remained visible`
      )
      assert.equal(
        (await snapshot()).length,
        1,
        `${name}: resolution erased history`
      )
      await panel
        .getByRole("button", { name: "Clear history", exact: true })
        .click()
      assert.equal(
        await panel.getByText("You’re all caught up", { exact: true }).count(),
        1
      )
      await page.keyboard.press("Escape")
      await page.setViewportSize({ width: 800, height: 600 })
      await page.evaluate(() => {
        ;(window as any).setFixtureSidebarWidth(320)
        ;(window as any).fixtureNotifications.theme("light")
        ;(window as any).fixtureNotifications.seed()
      })
      await bell.click()
      await panel.waitFor()
      const geometry = await panel.evaluate((element) => {
        const r = element.getBoundingClientRect()
        const close = element.querySelector<HTMLButtonElement>(
          'button[aria-label="Close notifications"]'
        )!
        const b = close.getBoundingClientRect(),
          hit = document.elementFromPoint(
            b.left + b.width / 2,
            b.top + b.height / 2
          )
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          overflow: element.scrollWidth - element.clientWidth,
          closeUsable: !!hit && close.contains(hit),
        }
      })
      assert.ok(
        geometry.left >= 0 &&
          geometry.right <= 800 &&
          geometry.top >= 0 &&
          geometry.bottom <= 600,
        `${name}: narrow panel offscreen ${JSON.stringify(geometry)}`
      )
      assert.ok(
        geometry.overflow <= 1 && geometry.closeUsable,
        `${name}: narrow panel overflow or close button covered`
      )
      assert.equal(
        await bell.evaluate((element) => {
          const r = element.getBoundingClientRect()
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2
          )
          return !!hit && element.contains(hit)
        }),
        true,
        `${name}: notification panel covers toolbar bell`
      )
      // Real keyboard traversal from dialog focus reaches its close action in both engines.
      await panel.focus()
      let reached = false
      for (let step = 0; step < 12; step++) {
        await page.keyboard.press(
          name === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab"
        )
        reached = await panel
          .getByRole("button", { name: "Close notifications" })
          .evaluate((element) => document.activeElement === element)
        if (reached) break
      }
      assert.equal(
        reached,
        true,
        `${name}: panel close action unreachable by keyboard`
      )
      await page.screenshot({
        path: join(artifactDir, `${name}-narrow-light-history.png`),
      })
      await page.keyboard.press("Escape")
      await panel.waitFor({ state: "hidden" })
      await page.evaluate(() => {
        ;(window as any).fixtureNotifications.recur()
        ;(window as any).fixtureNotifications.seed()
      })
      await page
        .getByRole("status")
        .filter({ hasText: "Fixture" })
        .first()
        .waitFor()
      const toasts = page.getByRole("status").filter({ hasText: "Fixture" })
      assert.equal(await toasts.count(), 2)
      await page.screenshot({
        path: join(artifactDir, `${name}-narrow-light-toasts.png`),
      })
      const stack = toasts.first().locator("..")
      const stackBounds = await stack.boundingBox()
      assert.ok(
        stackBounds &&
          stackBounds.y >= 0 &&
          stackBounds.y + stackBounds.height <= 600,
        `${name}: toast stack outside viewport`
      )
      for (const notification of await toasts.all()) {
        await notification.scrollIntoViewIfNeeded()
        const dismiss = notification.getByRole("button", {
          name: /^Dismiss notification:/,
        })
        assert.equal(
          await dismiss.evaluate((element) => {
            const r = element.getBoundingClientRect()
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2
            )
            return !!hit && element.contains(hit)
          }),
          true,
          `${name}: scrolled toast dismissal is covered`
        )
      }
      await page.screenshot({
        path: join(artifactDir, `${name}-narrow-light-toasts.png`),
      })
      assert.deepEqual(errors, [], `${name}: notification page errors`)
      console.log(
        `${name}: unread/history, persistent dedup, atomic retry, clear/resolve, Escape/focus and narrow light geometry passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  if (originalPlatform === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = originalPlatform
  server?.stop(true)
  await disposeFixture(output)
}
