import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"
import { chromium, webkit } from "playwright"
const root = resolve(import.meta.dir, ".."),
  output = await mkdtemp(join(tmpdir(), "hibiki-information-")),
  artifacts = resolve(root, ".tmp/information-checks")
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
        input: resolve(root, "tests/fixtures/libraryLayout/index.html"),
      },
    },
  })
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (path.startsWith("/synthetic-artwork/"))
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#345"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      const file = resolve(output, "." + path)
      return file.startsWith(output + "/") && (await Bun.file(file).exists())
        ? new Response(Bun.file(file))
        : new Response("Not found", { status: 404 })
    },
  })
  for (const [name, type] of [
    ["chrome", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({ headless: true })
    try {
      const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
        }),
        errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(
        `http://127.0.0.1:${server.port}/tests/fixtures/libraryLayout/index.html?appearance=1&information=1`
      )
      await page.waitForFunction(() => (window as any).visualFixtureReady)
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/playlist/123")
      )
      const info = page.getByRole("button", {
        name: "Playlist information",
        exact: true,
      })
      await info.waitFor()
      assert.equal(
        await page
          .locator(".playlist-detail-page .media-detail-eyebrow")
          .count(),
        0
      )
      const more = page.getByRole("button", { name: "More", exact: true })
      const ib = await info.boundingBox(),
        mb = await more.boundingBox()
      assert.ok(
        ib && mb && ib.x > mb.x && Math.abs(ib.y - mb.y) < 2,
        `${name}: Info is not beside More`
      )
      const began = performance.now()
      await info.hover()
      const tooltip = page.getByRole("tooltip")
      await tooltip.waitFor({ timeout: 1000 })
      assert.ok(performance.now() - began < 1000, `${name}: tooltip was slow`)
      assert.match(await tooltip.innerText(), /download issues/)
      await tooltip.hover()
      assert.equal(await tooltip.isVisible(), true)
      await page.keyboard.press("Escape")
      await tooltip.waitFor({ state: "hidden" })
      await info.click()
      const dialog = page.getByRole("dialog", {
        name: "The weekend collection",
        exact: true,
      })
      await dialog.waitFor()
      await dialog.getByText("Evening Static", { exact: false }).waitFor()
      assert.match(await dialog.innerText(), /Fixture Artist/)
      assert.match(await dialog.innerText(), /damaged frames/)
      for (const theme of ["dark", "light"]) {
        await page.evaluate(
          (theme) => (window as any).fixtureAppearance.apply({ theme }),
          theme
        )
        await page.screenshot({ path: join(artifacts, `${name}-${theme}.png`) })
        const b = await dialog.boundingBox()
        assert.ok(
          b &&
            b.x >= 0 &&
            b.y >= 0 &&
            b.x + b.width <= 1440 &&
            b.y + b.height <= 900
        )
        const color = await dialog
          .getByRole("button", { name: "Retry downloads", exact: true })
          .evaluate((element) => getComputedStyle(element).color)
        const rgb = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
        assert.ok(
          theme === "light" ? Math.max(...rgb) < 100 : Math.min(...rgb) > 160,
          `${name}: ${theme} dialog button is not using readable overlay text`
        )
      }
      await page.keyboard.press("Escape")
      await dialog.waitFor({ state: "hidden" })
      assert.equal(
        await info.evaluate((element) => document.activeElement === element),
        true,
        `${name}: modal lost focus return`
      )
      await more.click()
      assert.equal(
        await page.getByText(/The audio file contains damaged frames/).count(),
        0,
        `${name}: an error paragraph leaked into the action menu`
      )
      await page.keyboard.press("Escape")
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/settings/cache")
      )
      await page
        .getByText("/Users/listener/Music/Hibiki", { exact: true })
        .waitFor()
      assert.equal(
        await page
          .getByRole("heading", { name: "Downloads", exact: true })
          .count(),
        1
      )
      const change = page.getByRole("button", {
        name: "Change folder…",
        exact: true,
      })
      const open = page.getByRole("button", {
        name: "Open folder",
        exact: true,
      })
      for (const [width, theme] of [
        [1440, "dark"],
        [800, "light"],
      ] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(
          (theme) => (window as any).fixtureAppearance.apply({ theme }),
          theme
        )
        await page.waitForTimeout(600)
        assert.equal(
          await page
            .locator(".settings-main")
            .evaluate(
              (element) => element.scrollWidth <= element.clientWidth + 1
            ),
          true
        )
        await page.screenshot({
          path: join(artifacts, `${name}-${width}-downloads.png`),
        })
      }
      await page.evaluate(() => (window as any).fixtureDownloadStorage.hold())
      await change.click()
      await page
        .getByRole("button", { name: "Moving downloads…", exact: true })
        .waitFor()
      assert.equal(await open.isDisabled(), true)
      await page.evaluate(() =>
        (window as any).fixtureDownloadStorage.release()
      )
      await page
        .getByText("/Volumes/Music collection/Hibiki", { exact: true })
        .waitFor()
      await page.evaluate(() =>
        (window as any).fixtureDownloadStorage.failNext()
      )
      await change.click()
      await page
        .getByRole("alert")
        .filter({ hasText: "Check free space" })
        .waitFor()
      assert.equal(await change.isEnabled(), true)
      await page.getByRole("button", { name: "Try again", exact: true }).click()
      await page
        .getByRole("alert")
        .filter({ hasText: "Check free space" })
        .waitFor({ state: "hidden" })
      assert.deepEqual(errors, [], `${name}: renderer errors`)
      console.log(
        `${name}: Info, named issues, quick hovers, download folder controls, moving/error/retry and both themes passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  server?.stop(true)
  await rm(output, { recursive: true, force: true })
}
