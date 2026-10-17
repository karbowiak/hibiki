import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, webkit } from "playwright"
import {
  fixtureBuild,
  fixtureFile,
  disposeFixture,
  launchFixtureBrowser,
} from "./lib/browserFixtures"

const output = await fixtureBuild(["tests/fixtures/youtubeMusic/index.html"])
const artifacts = resolve(import.meta.dir, "../.tmp/youtube-music-checks")
await mkdir(artifacts, { recursive: true })
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => fixtureFile(output, new URL(request.url).pathname),
})
try {
  for (const type of [chromium, webkit]) {
    const browser = await launchFixtureBrowser(type)
    try {
      for (const [theme, width] of [["dark", 1200], ["light", 520]] as const) {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
        })
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        await page.goto(
          `http://127.0.0.1:${server.port}/tests/fixtures/youtubeMusic/index.html`
        )
        await page.evaluate((theme) => {
          document.documentElement.classList.toggle("dark", theme === "dark")
          document.documentElement.setAttribute("data-theme", theme)
        }, theme)
        const icon = page.getByRole("button", {
          name: "YouTube Music: Not connected",
          exact: true,
        })
        await icon.click()
        await page
          .getByRole("status")
          .filter({ hasText: "Waiting for sign-in" })
          .waitFor()
        await page.evaluate(() =>
          (window as any).youtubeMusicFixture.update("connected")
        )
        const panel = page.getByRole("dialog", { name: "YouTube Music", exact: true })
        await panel.getByText("Connected", { exact: true }).waitFor()
        await panel.getByText(/Not supported or endorsed by Google/).waitFor()
        assert.equal(await panel.getByRole("searchbox").count(), 0)
        const material = await panel.evaluate(node => {
          const style = getComputedStyle(node)
          return { blur: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
            inlineBackground: (node as HTMLElement).style.background,
            right: node.getBoundingClientRect().right }
        })
        assert.ok(material.blur.includes("blur"))
        assert.equal(material.inlineBackground, "")
        assert.ok(material.right <= width - 11)
        await page
          .getByRole("button", { name: "Install playback tools", exact: true })
          .click()
        await page
          .getByText("Playback tools installed.", { exact: true })
          .waitFor()
        await page.screenshot({
          path: `${artifacts}/${type.name()}-${theme}-connected.png`,
        })
        await page.getByRole("button", { name: "Refresh session", exact: true }).click()
        await panel.getByText("Connected", { exact: true }).waitFor()
        await page.evaluate(() =>
          (window as any).youtubeMusicFixture.update("unavailable")
        )
        assert.equal(
          await page
            .locator("[data-ytmusic-connection] svg.text-amber-700")
            .count(),
          0
        )
        await page.evaluate(() =>
          (window as any).youtubeMusicFixture.update("reauthRequired")
        )
        await page
          .getByRole("button", {
            name: "YouTube Music: Sign in again",
            exact: true,
          })
          .waitFor()
        assert.equal(
          await page
            .locator("[data-ytmusic-connection] svg.text-amber-700")
            .count(),
          1
        )
        await page.screenshot({
          path: `${artifacts}/${type.name()}-${theme}-reauth.png`,
        })
        await page
          .getByRole("button", { name: "Disconnect", exact: true })
          .click()
        await page
          .getByRole("button", {
            name: "YouTube Music: Not connected",
            exact: true,
          })
          .waitFor()
        assert.equal(
          await page.getByRole("heading", { name: "Try a song" }).count(),
          0
        )
        await page
          .getByRole("button", { name: "Close YouTube Music", exact: true })
          .click()
        await page.keyboard.press("Enter")
        await page
          .getByRole("dialog", { name: "YouTube Music", exact: true })
          .waitFor()
        await page.keyboard.press("Escape")
        await page
          .getByRole("dialog", { name: "YouTube Music", exact: true })
          .waitFor({ state: "hidden" })
        assert.equal(
          await page
            .getByRole("dialog", { name: "YouTube Music", exact: true })
            .count(),
          0
        )
        assert.deepEqual(errors, [])
        await page.close()
      }
      console.log(
        `${type.name()}: translucent connection panel, installation, refresh, reauthentication, disconnect and keyboard controls passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  server.stop(true)
  await disposeFixture(output)
}
