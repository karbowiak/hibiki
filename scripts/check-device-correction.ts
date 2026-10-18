import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium, webkit } from "playwright"
import {
  fixtureBuild,
  disposeFixture,
  fixtureFile,
  launchFixtureBrowser,
} from "./lib/browserFixtures"

const output = await fixtureBuild(
  ["tests/fixtures/deviceCorrection/index.html"],
  "windows"
)
const artifacts = resolve(import.meta.dir, "../.tmp/device-correction-checks")
await mkdir(artifacts, { recursive: true })
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => fixtureFile(output, new URL(request.url).pathname),
})
try {
  const origin = `http://127.0.0.1:${server.port}`
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await launchFixtureBrowser(type)
    try {
      const context = await browser.newContext({
        viewport: { width: 1100, height: 1000 },
      })
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort()
      )
      const page = await context.newPage(),
        errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${origin}/tests/fixtures/deviceCorrection/index.html`)
      await page.getByRole("tab", { name: "Device correction" }).click()
      const panel = page.getByRole("region", { name: "Device correction" })
      await panel.waitFor()
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).fixtureCorrection
              .calls()
              .filter((call: any) => call.command.startsWith("autoeq_")).length
        ),
        0
      )
      await panel.getByRole("button", { name: "Find or import" }).click()
      await panel.getByLabel("AutoEq model or manufacturer").fill("Fixture")
      await panel
        .getByRole("button", { name: /Fixture Headphone \(ANC On\)/ })
        .click()
      await panel
        .getByLabel("Parametric filters")
        .fill("Preamp: -8 dB\nFilter 1: ON PK Fc 1234 Hz Gain 4 dB Q 2.5")
      await panel.getByRole("button", { name: "Preview", exact: true }).click()
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().correctionPreview !== null
      )
      await panel.getByRole("button", { name: "Stop preview", exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).fixtureCorrection.state().correctionPreview), null)
      await panel.getByRole("button", { name: "Preview", exact: true }).click()
      assert.equal(
        await page.evaluate(
          () =>
            Object.keys((window as any).fixtureCorrection.state().corrections)
              .length
        ),
        0
      )
      await panel.getByRole("button", { name: "Cancel", exact: true }).click()
      assert.equal(
        await page.evaluate(
          () => (window as any).fixtureCorrection.state().correctionPreview
        ),
        null
      )
      await panel.getByRole("button", { name: "Find or import" }).click()
      await panel
        .getByRole("button", { name: /Fixture Headphone \(ANC Off\)/ })
        .click()
      await panel.getByRole("button", { name: "Apply", exact: true }).click()
      await panel.getByRole("button", { name: "Save to output" }).click()
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().appliedEq
            ?.correctionPreampDb === -6.1
      )
      const profile = await page.evaluate(
        () =>
          Object.values(
            (window as any).fixtureCorrection.state().corrections
          )[0] as any
      )
      assert.equal(profile.source.revision, "a".repeat(40))
      assert.equal(profile.source.measurement, "oratory1990")
      await panel.getByRole("button", { name: "Edit filters" }).click()
      await panel
        .getByLabel("Parametric filters")
        .fill("Preamp: nan dB\nFilter 1: ON PK Fc 1000 Hz Gain 4 dB Q 2")
      await panel.getByRole("button", { name: "Preview", exact: true }).click()
      await panel.getByRole("alert").waitFor()
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).fixtureCorrection.state().appliedEq
              .correctionPreampDb
        ),
        -6.1
      )
      await panel.getByRole("button", { name: "Cancel", exact: true }).click()
      await panel
        .getByRole("checkbox", { name: "Enabled", exact: true })
        .uncheck()
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().appliedEq
            ?.correctionPreampDb === 0
      )
      await panel
        .getByRole("checkbox", { name: "Enabled", exact: true })
        .check()
      assert.equal(await panel.getByRole("button", { name: "Save to output" }).isDisabled(), true)
      await panel.getByText("Saved for this output", { exact: true }).waitFor()
      await page.evaluate(() =>
        (window as any).fixtureCorrection.output("2", "2")
      )
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().appliedEq
            ?.correctionPreampDb === 0
      )
      await page.evaluate(() =>
        (window as any).fixtureCorrection.output("1", "3")
      )
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().appliedEq
            ?.correctionPreampDb === -6.1
      )
      for (const theme of ["dark", "light"] as const) {
        await page.evaluate(
          (value) => (window as any).fixtureCorrection.theme(value),
          theme
        )
        if (!process.argv.includes("--interaction-only"))
          await page.screenshot({
            path: resolve(artifacts, `${name}-${theme}-applied.png`),
          })
      }
      await page.setViewportSize({ width: 340, height: 900 })
      await page.getByRole("tab", { name: "Tone", exact: true }).click()
      assert.equal(await page.locator('[role="tabpanel"]').filter({ visible: true }).evaluate(element => element.scrollWidth > element.clientWidth), false, `${name}: narrow tone panel overflow`)
      await page.getByRole("tab", { name: "Tone", exact: true }).press("ArrowRight")
      await panel.getByRole("button", { name: "Edit filters" }).click()
      await panel.getByText("Source and licence", { exact: true }).click()
      await panel.getByRole("link", { name: /^AutoEq/ }).click()
      assert.equal(
        await page.evaluate(() =>
          (window as any).fixtureCorrection
            .calls()
            .some((call: any) => call.command === "plugin:opener|open_url")
        ),
        true
      )
      const overflow = await panel.evaluate(
        (element) => element.scrollWidth > element.clientWidth
      )
      assert.equal(overflow, false, `${name}: narrow panel overflow`)
      if (!process.argv.includes("--interaction-only"))
        await page.screenshot({
          path: resolve(artifacts, `${name}-narrow-editor.png`),
        })
      await panel.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.evaluate(() => localStorage.setItem("fixture-offline", "1"))
      await page.reload()
      await page.getByRole("tab", { name: "Device correction" }).click()
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().appliedEq
            ?.correctionPreampDb === -6.1
      )
      assert.equal(
        await panel
          .getByRole("combobox", { name: "Correction profile" })
          .textContent(),
        profile.label
      )
      await panel.getByRole("button", { name: "Find or import" }).click()
      await panel.getByLabel("AutoEq model or manufacturer").fill("offline")
      await panel.getByRole("alert").waitFor()
      await panel.getByRole("button", { name: "Paste custom filters" }).click()
      await panel.getByLabel("Profile name").fill("Desk speakers")
      await panel
        .getByLabel("Parametric filters")
        .fill("Preamp: -3 dB\nFilter 1: ON LSC Fc 90 Hz Gain -2 dB Q 0.7")
      await panel.getByRole("button", { name: "Apply", exact: true }).click()
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().appliedEq
            ?.correctionPreampDb === -3
      )
      await panel.getByRole("button", { name: "Find or import" }).click()
      const file = "Preamp: -4 dB\nFilter 1: ON HSC Fc 8000 Hz Gain -3 dB Q 0.7"
      await panel
        .getByLabel("Import correction text file")
        .setInputFiles({
          name: "Speaker.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(file),
        })
      await panel.getByLabel("Profile name").waitFor()
      await panel.getByRole("button", { name: "Apply", exact: true }).click()
      await page.waitForFunction(
        () =>
          (window as any).fixtureCorrection.state().appliedEq
            ?.correctionPreampDb === -4
      )
      assert.equal(
        await page.evaluate(
          () =>
            Object.values(
              (window as any).fixtureCorrection.state().corrections
            ).find((item: any) => item.label === "Speaker")?.originalText
        ),
        file
      )
      assert.deepEqual(errors, [], `${name}: renderer errors`)
      console.log(
        `${name}: catalogue variants, preview/cancel, validation, save/bypass, A–B–A, offline restart and custom import passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  server.stop(true)
  await disposeFixture(output)
}
