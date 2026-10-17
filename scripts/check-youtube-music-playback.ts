import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, webkit, type Locator } from "playwright"
import { fixtureBuild, fixtureFile, disposeFixture, launchFixtureBrowser } from "./lib/browserFixtures"

const output = await fixtureBuild(["tests/fixtures/libraryLayout/index.html"], "windows")
const artifacts = resolve(import.meta.dir, "../.tmp/youtube-music-playback-checks")
await mkdir(artifacts, { recursive: true })
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch: request => fixtureFile(output, new URL(request.url).pathname) })
const values = (panel: Locator) => panel.locator(".track-info-values > div").evaluateAll(rows =>
  Object.fromEntries(rows.map(row => [row.querySelector("dt")!.textContent, row.querySelector("dd")!.textContent])))
try {
  for (const type of [chromium, webkit]) {
    const browser = await launchFixtureBrowser(type)
    try {
      for (const [width, theme] of [[1280, "dark"], [800, "light"]] as const) {
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        await page.route("https://**", route => route.abort())
        await page.goto(`http://127.0.0.1:${server.port}/tests/fixtures/libraryLayout/index.html?appearance=1&player=1`)
        await page.waitForFunction(() => (window as any).visualFixtureReady)
        await page.evaluate(({ theme }) => {
          const fixture = (window as any).fixtureAppearance
          fixture.apply({ theme })
          fixture.youtubePreview()
          fixture.panel("queue", true)
        }, { theme })
        const badges = page.locator('.queue-track-row [data-music-source="ytmusic"]')
        await badges.nth(2).waitFor()
        assert.deepEqual(await badges.allTextContents(), ["YTM", "YTM", "YTM"])
        const plex = page.locator('[data-queue-index="2"]')
        assert.equal(await plex.locator('[data-music-source="plex"]').count(), 1)
        const transport = page.getByRole("group", { name: "Playback controls", exact: true })
        assert.equal(await transport.locator('[data-music-source="ytmusic"]').innerText(), "YTM")
        const sourceBox = await transport.locator('[data-music-source]').boundingBox()
        const shuffleBox = await transport.getByRole("button", { name: "Shuffle", exact: true }).boundingBox()
        assert.ok(sourceBox && shuffleBox && sourceBox.x + sourceBox.width <= shuffleBox.x)
        await page.screenshot({ path: `${artifacts}/${type.name()}-${width}-queue.png` })
        await page.getByRole("button", { name: "Track info", exact: true }).click()
        const info = page.getByRole("dialog", { name: "Track info", exact: true })
        await info.getByText("YouTube Music stream", { exact: true }).waitFor()
        const rows = await values(info)
        assert.equal(rows.Source, "YouTube Music")
        assert.equal(rows.Codec, "AAC")
        assert.equal(rows["Sample Rate"], "44.1 kHz")
        assert.equal(rows.Channels, "Stereo")
        assert.equal(rows.Normalization, "-3.0 dB")
        assert.equal(rows["YouTube ID"], "abcdefghijk")
        assert.equal(rows["Loudness Analysis"], undefined)
        assert.equal(rows["Bit Depth"], undefined)
        await page.screenshot({ path: `${artifacts}/${type.name()}-${width}-track-info.png` })
        await page.evaluate(() => (window as any).fixtureAppearance.youtubePreview("cache"))
        await info.getByText("Audio cache", { exact: true }).waitFor()
        await page.evaluate(() => (window as any).fixtureAppearance.youtubePreview("saved"))
        await info.getByText("Audio details appear when playback starts.").waitFor()
        assert.equal((await values(info)).Normalization, undefined)
        assert.equal((await values(info)).Codec, undefined)
        assert.deepEqual(await page.evaluate(() => (window as any).fixtureAppearance.youtubeMetadataCalls()), [])
        await page.evaluate(() => (window as any).fixtureAppearance.youtubePreview("plex"))
        await info.getByText("Loudness Analysis", { exact: true }).waitFor()
        assert.equal(await transport.locator('[data-music-source="plex"]').innerText(), "Plex")
        assert.equal(await transport.locator('[data-music-source="ytmusic"]').count(), 0)
        assert.equal((await values(info)).Source, undefined)
        await page.getByRole("button", { name: "Close track info", exact: true }).click()
        const polls = await page.evaluate(() => (window as any).fixtureDiagnostics.calls())
        await page.waitForTimeout(650)
        assert.equal(await page.evaluate(() => (window as any).fixtureDiagnostics.calls()), polls)
        assert.deepEqual(errors, [])
        await page.close()
      }
      console.log(`${type.name()}: mixed-queue source logos and transport labels, native audio details, cache, paused restore and Plex isolation passed`)
    } finally { await browser.close() }
  }
} finally { server.stop(true); await disposeFixture(output) }
