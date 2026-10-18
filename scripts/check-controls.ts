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

const output = await fixtureBuild(["tests/fixtures/controls/index.html"])
const artifacts = resolve(import.meta.dir, "../.tmp/controls-checks")
await mkdir(artifacts, { recursive: true })
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => fixtureFile(output, new URL(request.url).pathname),
})
try {
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await launchFixtureBrowser(type)
    try {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 850 },
        reducedMotion: "reduce",
      })
      page.setDefaultTimeout(8000)
      const errors: string[] = []
      page.on("pageerror", (error) => {
        errors.push(error.message)
        console.error(error.message)
      })
      await page.goto(
        `http://127.0.0.1:${server.port}/tests/fixtures/controls/index.html`
      )
      const profile = page.getByRole("combobox", {
        name: "Sound profile",
        exact: true,
      })
      const order = page.getByRole("combobox", {
        name: "Queue order",
        exact: true,
      })
      await profile.click()
      await page
        .getByRole("option", { name: "Unavailable", exact: true })
        .waitFor()
      assert.equal(
        await page
          .getByRole("option", { name: "Unavailable", exact: true })
          .getAttribute("aria-disabled"),
        "true"
      )
      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("Enter")
      assert.equal(await profile.textContent(), "Bright")
      assert.equal(
        await page.locator("output").getAttribute("data-changes"),
        "1"
      )
      await profile.click()
      await page.keyboard.press("End")
      await page.keyboard.press("Escape")
      assert.equal(await profile.textContent(), "Bright")
      assert.equal(
        await profile.evaluate((el) => el === document.activeElement),
        true
      )
      await page.keyboard.press("b")
      assert.equal(await profile.textContent(), "Bass boost")
      await profile.click()
      await page
        .getByRole("option", { name: "Quiet listening", exact: true })
        .click()
      assert.equal(await profile.textContent(), "Quiet listening")
      assert.equal(
        await page.locator("output").getAttribute("data-changes"),
        "3"
      )
      await order.click()
      await page.getByRole("option", { name: "Artist", exact: true }).click()
      await page.getByRole("button", { name: "Save preferences" }).click()
      assert.deepEqual(
        JSON.parse((await page.locator("output").textContent())!),
        { profile: "quiet", order: "artist", normalize: "on", waveform: "on" }
      )
      await page.getByRole("button", { name: "Reset order" }).click()
      await page.waitForFunction(
        () =>
          document.querySelector("#uncontrolled")?.textContent === "Date added"
      )
      await page
        .getByRole("checkbox", { name: "Normalize volume", exact: true })
        .uncheck()
      await page
        .getByRole("switch", { name: "Show waveform", exact: true })
        .uncheck()
      assert.equal(
        await page
          .getByRole("combobox", { name: "Unavailable output" })
          .isDisabled(),
        true
      )
      await profile.click()
      await page.keyboard.press("Tab")
      assert.equal(await page.getByRole("listbox").count(), 0)
      assert.equal(
        await order.evaluate((el) => el === document.activeElement),
        true
      )
      await page.getByRole("button", { name: "Choose output" }).click()
      const dialog = page.getByRole("dialog", { name: "Output settings" })
      const outputDevice = dialog.getByRole("combobox", {
        name: "Output device",
        exact: true,
      })
      await outputDevice.click()
      await page
        .getByRole("option", { name: "Built-in speakers", exact: true })
        .click()
      assert.equal(await outputDevice.textContent(), "Built-in speakers")
      await outputDevice.click()
      await page.keyboard.press("Escape")
      assert.equal(await dialog.isVisible(), true)
      await dialog.getByRole("button", { name: /Close/ }).click()
      for (const theme of ["dark", "light"]) {
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme
        )
        for (const width of [1000, 340]) {
          await page.setViewportSize({ width, height: 850 })
          await profile.click()
          await page.getByRole("listbox").waitFor({ state: "visible" })
          const bounds = await page.getByRole("listbox").boundingBox()
          assert.ok(
            bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
            `${name}: list fits ${width}`
          )
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth
            ),
            false
          )
          await page.screenshot({
            path: resolve(artifacts, `${name}-${theme}-${width}.png`),
          })
          await page.keyboard.press("Escape")
        }
      }
      await page.getByRole("button", { name: "Choose output" }).click()
      await dialog
        .getByRole("combobox", { name: "Output device", exact: true })
        .click()
      await page.screenshot({ path: resolve(artifacts, `${name}-modal.png`) })
      await page.keyboard.press("Escape")
      await dialog.getByRole("button", { name: /Close/ }).click()
      await page
        .getByRole("combobox", { name: "Long list", exact: true })
        .click()
      const selected = page.getByRole("option", {
        name: "Output 15",
        exact: true,
      })
      assert.equal(await selected.getAttribute("aria-selected"), "true")
      const bounds = await page.getByRole("listbox").boundingBox()
      assert.ok(
        bounds && bounds.y >= 0 && bounds.y + bounds.height <= 850,
        `${name}: long list stays in viewport`
      )
      assert.deepEqual(errors, [])
      console.log(
        `${name}: select keyboard/pointer/form/reset/modal behavior, checkbox/switch and light/dark narrow controls passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  server.stop(true)
  await disposeFixture(output)
}
