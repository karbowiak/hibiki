import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { fixtureBuild, disposeFixture, fixtureFile, launchFixtureBrowser } from "./lib/browserFixtures"
const output = await fixtureBuild(["tests/fixtures/libraryLayout/index.html"], "darwin")
const artifacts = resolve(".tmp/playlist-management")
await mkdir(artifacts, { recursive: true })
const font = await Bun.file("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2").bytes()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname
  if (pathname.startsWith("/synthetic-artwork/")) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#685386"/><circle cx="240" cy="240" r="110" fill="#cebfe3"/></svg>', { headers: { "Content-Type": "image/svg+xml" } })
  return fixtureFile(output, pathname)
} })
const browser = await launchFixtureBrowser(chromium)
try {
  for (const [theme, width, height] of [["dark", 1400, 900], ["light", 960, 620]] as const) {
    const context = await browser.newContext({ viewport: { width, height } })
    const origin = `http://127.0.0.1:${server.port}`
    await context.route("**/*", route => {
      if (route.request().url().startsWith(origin)) return route.continue()
      if (/\.woff2?(?:\?|$)/.test(route.request().url())) return route.fulfill({ body: Buffer.from(font), contentType: "font/woff2" })
      return route.abort()
    })
    const page = await context.newPage(), errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(`${origin}/tests/fixtures/libraryLayout/index.html?appearance=1`)
    await page.waitForFunction(() => (window as any).visualFixtureReady)
    await page.evaluate(theme => { const f = (window as any).fixtureAppearance; f.apply({ theme }); f.route("/server-library") }, theme)
    await page.getByRole("heading", { name: "Explore artists" }).waitFor()
    assert.equal(await page.getByRole("navigation", { name: "Server library categories" }).getByRole("link").count(), 3)
    assert.equal(await page.locator('a[href="/server-library"][aria-current="page"]').count(), 1)
    await page.getByRole("button", { name: "Collapse Server Library" }).click()
    assert.equal(await page.locator("#sidebar-server-library-links").count(), 0)
    await page.getByRole("button", { name: "Expand Server Library" }).click()
    assert.equal(await page.locator("#sidebar-server-library-links a").count(), 3)
    await page.screenshot({ path: `${artifacts}/overview-${theme}.png` })
    await page.evaluate(async () => { const f = (window as any).fixtureAppearance; f.route("/collection/playlists"); await f.playlistManagement() })
    const linked = page.locator(".media-card").filter({ has: page.locator('a[href="/mixed-playlist/mixed%3Abadge-both"]') })
    await linked.waitFor()
    assert.equal(await linked.locator("[data-music-source]").count(), 2)
    assert.equal(await page.locator('.media-card').filter({ has: page.locator('a[href="/mixed-playlist/mixed%3Amerge-first"]') }).locator('[title="Hibiki · saved on this device"]').count(), 1)
    if (theme === "dark") { await linked.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${artifacts}/cards-dark.png` }) }
    await page.getByRole("button", { name: "Merge playlists", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Merge playlists", exact: true })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "First playlist")
    await dialog.getByRole("combobox", { name: "First playlist", exact: true }).click()
    await page.getByRole("option", { name: "First collection", exact: true }).click()
    await dialog.getByRole("combobox", { name: "Second playlist", exact: true }).click()
    await page.getByRole("option", { name: "Second collection", exact: true }).click()
    await dialog.getByRole("combobox", { name: "Merge destination" }).click()
    await page.getByRole("option", { name: "Plex only", exact: true }).click()
    await dialog.getByRole("button", { name: "Review merge", exact: true }).click()
    await dialog.getByRole("heading", { name: "6 songs in the new playlist" }).waitFor()
    assert.equal(await dialog.getByRole("list", { name: "Merged song order" }).locator("li").count(), 6)
    const name = dialog.getByRole("textbox", { name: "Playlist name", exact: true })
    await name.fill("")
    assert.equal(await dialog.getByRole("button", { name: "Create merged playlist" }).isDisabled(), true)
    await name.fill("Reviewed merged playlist")
    await dialog.locator(".playlist-editor").evaluate(element => { element.scrollTop = 0 })
    await dialog.screenshot({ path: `${artifacts}/merge-${theme}.png` })
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), "dialog horizontal overflow")
    await dialog.getByRole("button", { name: "Create merged playlist" }).click()
    await page.getByRole("heading", { name: "Reviewed merged playlist", exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureAppearance.drafts.snapshot().some((item: any) => item.merge && item.providers.plex && !item.write))
    const created = await page.evaluate(() => (window as any).fixtureAppearance.drafts.snapshot().find((item: any) => item.merge))
    assert.equal(created.items.length, 6)
    assert.deepEqual(created.destinations, ["plex"])
    assert.equal(created.providers.ytmusic, undefined)
    assert.equal(created.aliases.includes("mixed:merge-first"), false)
    assert.deepEqual(errors, [])
    console.log(`${theme} ${width}x${height}: overview, disclosure, source badges, merge review and creation passed`)
    await context.close()
  }
} finally { await browser.close(); server.stop(true); await disposeFixture(output) }
