import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"
import { chromium, webkit } from "playwright"
function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number)
    assert.equal(channels?.length, 3, `Unsupported computed color ${color}`)
    const linear = channels!.map((value) => {
      const channel = value / 255
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const first = luminance(foreground),
    second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
const root = resolve(import.meta.dir, "..")
const output = await mkdtemp(join(tmpdir(), "hibiki-metadata-edit-"))
const artifacts = resolve(root, ".tmp/metadata-edit-checks")
await mkdir(artifacts, { recursive: true })
let server: ReturnType<typeof Bun.serve> | undefined
const previousPlatform = process.env.TAURI_ENV_PLATFORM
process.env.TAURI_ENV_PLATFORM = "windows"
try {
  await build({
    root,
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: output,
      emptyOutDir: true,
      rolldownOptions: {
        input: resolve(root, "tests/fixtures/metadataEditUI/index.html"),
      },
    },
  })
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/synthetic-cover.svg")
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#d79431"/><circle cx="205" cy="35" r="112" fill="#2d5560"/><path d="M0 190L256 110V256H0" fill="#e7c59a"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      if (new URL(request.url).pathname === "/synthetic-background.svg")
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#234454"/><circle cx="440" cy="150" r="190" fill="#7b5037"/><path d="M0 240L640 150V320H0" fill="#102430"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      const filename = resolve(output, "." + new URL(request.url).pathname)
      if (!filename.startsWith(output + "/"))
        return new Response("Not found", { status: 404 })
      const file = Bun.file(filename)
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  let views = 0
  for (const [name, type] of [
    ["chrome", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({
      headless: true,
      ...(name === "chrome" && process.env.HIBIKI_CHROME_CHANNEL
        ? { channel: process.env.HIBIKI_CHROME_CHANNEL }
        : {}),
    })
    try {
      const context = await browser.newContext()
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort()
      )
      for (const [width, height] of [
        [1440, 1000],
        [800, 650],
        [480, 650],
      ] as const) {
        for (const theme of ["dark", "light"] as const) {
          const page = await context.newPage(),
            errors: string[] = []
          page.on("pageerror", (error) => errors.push(error.message))
          await page.setViewportSize({ width, height })
          await page.goto(`${origin}/tests/fixtures/metadataEditUI/index.html`)
          await page.waitForFunction(
            () => !!(window as any).metadataEditFixture
          )
          await page.evaluate(
            (value) => (window as any).metadataEditFixture.theme(value),
            theme
          )
          const opener = page.getByRole("button", {
            name: "Edit album",
            exact: true,
          })
          await opener.focus()
          await page.keyboard.press("Enter")
          const dialog = page.getByRole("dialog")
          await dialog.waitFor()
          await page.waitForFunction(() =>
            [
              ...document.querySelectorAll<HTMLImageElement>(
                ".metadata-edit-cover img"
              ),
            ].some((image) => image.complete && image.naturalWidth > 0)
          )
          const geometry = await dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect(),
              css = getComputedStyle(element)
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight,
              background: css.backgroundColor,
              color: css.color,
              horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
            }
          })
          assert.ok(
            geometry.left >= 0 &&
              geometry.right <= width + 1 &&
              geometry.top >= 0 &&
              geometry.bottom <= height + 1,
            `${name}/${width}/${theme}: dialog outside viewport ${JSON.stringify(geometry)}`
          )
          if (width >= 1440)
            assert.ok(
              geometry.width <= width * 0.85,
              `${name}/${theme}: desktop dialog lacks bounded side gutters`
            )
          assert.equal(
            geometry.horizontalOverflow,
            false,
            `${name}/${width}/${theme}: horizontal dialog overflow`
          )
          assert.notEqual(geometry.background, "rgba(0, 0, 0, 0)")
          assert.ok(
            contrast(geometry.color, geometry.background) >= 4.5,
            `${name}/${width}/${theme}: dialog text contrast below 4.5`
          )
          await page.screenshot({
            path: join(artifacts, `${name}-${width}-${theme}-general.png`),
          })
          const general = page.getByRole("tab", {
            name: "General",
            exact: true,
          })
          assert.equal(await general.getAttribute("aria-selected"), "true")
          await general.focus()
          await page.keyboard.press("ArrowDown")
          const sources = page.getByRole("tab", {
            name: "Metadata sources",
            exact: true,
          })
          await page
            .getByRole("tabpanel", { name: "Metadata sources", exact: true })
            .waitFor()
          assert.equal(await sources.getAttribute("aria-selected"), "true")
          assert.equal(
            await sources.evaluate(
              (element) => element === document.activeElement
            ),
            true
          )
          await page
            .getByRole("tabpanel", { name: "Metadata sources", exact: true })
            .waitFor()
          await page.screenshot({
            path: join(artifacts, `${name}-${width}-${theme}-sources.png`),
          })
          await page.keyboard.press("End")
          const background = page.getByRole("tab", {
            name: "Background",
            exact: true,
          })
          const backgroundPanel = page.getByRole("tabpanel", {
            name: "Background",
            exact: true,
          })
          await backgroundPanel.waitFor()
          assert.equal(await background.getAttribute("aria-selected"), "true")
          assert.equal(
            await background.evaluate(
              (element) => element === document.activeElement
            ),
            true
          )
          await backgroundPanel
            .locator('img[src$="synthetic-background.svg"]')
            .first()
            .waitFor()
          await page.screenshot({
            path: join(
              artifacts,
              `${name}-${width}-${theme}-background-artwork.png`
            ),
          })
          await page.keyboard.press("ArrowUp")
          const poster = page.getByRole("tab", { name: "Poster", exact: true })
          const posterPanel = page.getByRole("tabpanel", {
            name: "Poster",
            exact: true,
          })
          await posterPanel.waitFor()
          assert.equal(await poster.getAttribute("aria-selected"), "true")
          assert.equal(await background.getAttribute("aria-selected"), "false")
          await posterPanel
            .locator('img[src$="synthetic-cover.svg"]')
            .first()
            .waitFor()
          await page.screenshot({
            path: join(
              artifacts,
              `${name}-${width}-${theme}-poster-artwork.png`
            ),
          })
          await sources.focus()
          await page.keyboard.press("Home")
          await page
            .getByRole("tabpanel", { name: "General", exact: true })
            .waitFor()
          assert.equal(await general.getAttribute("aria-selected"), "true")
          const title = page.getByRole("textbox", {
            name: "Title",
            exact: true,
          })
          await title.fill("Synthetic edited album")
          assert.equal(
            await page.evaluate(() =>
              (window as any).metadataEditFixture.writes()
            ),
            0
          )
          const reviewButton = page.getByRole("button", {
            name: "Review changes",
            exact: true,
          })
          const actionStyle = await reviewButton.evaluate((element) => {
            const style = getComputedStyle(element),
              rect = element.getBoundingClientRect()
            return {
              foreground: style.color,
              background: style.backgroundColor,
              height: rect.height,
            }
          })
          assert.ok(
            actionStyle.height >= 32,
            `${name}/${width}/${theme}: review target too small`
          )
          assert.ok(
            contrast(actionStyle.foreground, actionStyle.background) >= 4.5,
            `${name}/${width}/${theme}: primary action contrast below 4.5`
          )
          await reviewButton.click()
          await page.getByRole("region", { name: "Changes to save" }).waitFor()
          await page.waitForFunction(
            () => {
              const preview = document.querySelector(
                '[aria-label="Changes to save"]'
              )
              const value = [...(preview?.querySelectorAll("p") ?? [])].find(
                (node) => node.textContent === "Synthetic edited album"
              )
              const panel = preview?.closest('[role="tabpanel"]')
              if (!value || !panel) return false
              const item = value.getBoundingClientRect(),
                visible = panel.getBoundingClientRect()
              return item.top >= visible.top && item.bottom <= visible.bottom
            },
            undefined,
            { timeout: 5000 }
          )
          await page.screenshot({
            path: join(artifacts, `${name}-${width}-${theme}-review.png`),
          })
          await page
            .getByRole("button", { name: "Save to Plex", exact: true })
            .click()
          assert.equal(
            await page.evaluate(() =>
              (window as any).metadataEditFixture.writes()
            ),
            1
          )
          const close = page.getByRole("button", { name: /Close Edit album/i })
          assert.equal(await close.isDisabled(), true)
          await page.keyboard.press("Escape")
          assert.equal(await dialog.isVisible(), true)
          await page.evaluate(() =>
            (window as any).metadataEditFixture.settle()
          )
          await page.getByText("Saved to Plex.", { exact: true }).waitFor()
          assert.equal(await close.isEnabled(), true)
          await page.keyboard.press("Escape")
          await dialog.waitFor({ state: "detached" })
          assert.equal(
            await opener.evaluate(
              (element) => element === document.activeElement
            ),
            true
          )
          assert.deepEqual(
            errors,
            [],
            `${name}/${width}/${theme}: renderer error`
          )
          views++
          await page.close()
        }
      }
      await context.close()
    } finally {
      await browser.close()
    }
  }
  console.log(
    `Metadata edit UI: ${views} Chromium/WebKit dark/light views passed; screenshots ${artifacts}`
  )
} finally {
  server?.stop(true)
  if (previousPlatform === undefined) delete process.env.TAURI_ENV_PLATFORM
  else process.env.TAURI_ENV_PLATFORM = previousPlatform
  await rm(output, { recursive: true, force: true })
}
