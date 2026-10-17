import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fixtureBuild, disposeFixture, fixtureFile, launchFixtureBrowser } from "./lib/browserFixtures"
import { chromium, webkit } from "playwright"
const root = resolve(import.meta.dir, "..")
const output = await fixtureBuild(["tests/fixtures/libraryLayout/index.html"])
const artifacts = resolve(root, ".tmp/virtual-checks")
await mkdir(artifacts, { recursive: true })
let server: ReturnType<typeof Bun.serve> | undefined
try {

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (path.startsWith("/synthetic-artwork/"))
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#234"/></svg>',
          { headers: { "Content-Type": "image/svg+xml" } }
        )
      return fixtureFile(output,path)
    },
  })
  for (const [name, type] of [
    ["chrome", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await launchFixtureBrowser(type)
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      })
      const errors: string[] = []
      page.on("pageerror", (error) => {
        errors.push(error.message)
        console.log("PAGE ERROR", error.message)
      })
      await page.goto(
        `http://127.0.0.1:${server.port}/tests/fixtures/libraryLayout/index.html?appearance=1&virtual=1`
      )
      await page.waitForFunction(() => (window as any).visualFixtureReady)
      for (const route of [
        "/collection/tracks",
        "/playlist/stress-0",
        "/collection/albums",
        "/collection/artists",
        "/collection/playlists",
      ]) {
        console.log(`${name}: checking ${route}`)
        const started = performance.now()
        await page.evaluate(
          (path) => (window as any).fixtureAppearance.route(path),
          route
        )
        await page.locator(".app-page-content h1").waitFor()
        const grid =
          route.endsWith("albums") ||
          route.endsWith("artists") ||
          route.endsWith("playlists")
        const selector = grid
          ? ".app-page-content [data-media-index]"
          : ".app-page-content [data-track-index]"
        await page.locator(selector).first().waitFor()
        const total = route.endsWith("playlists") ? 3000 : grid ? 6000 : 20000
        assert.match(
          await page.locator(".app-page-content").innerText(),
          new RegExp(total.toLocaleString("en-US"))
        )
        assert.ok(
          (await page.locator(selector).count()) < (grid ? 180 : 90),
          `${name}/${route}: too many mounted items`
        )
        const geometry = await page
          .locator(".app-page-content")
          .evaluate((element) => ({
            height: element.scrollHeight,
            viewport: element.clientHeight,
          }))
        assert.ok(
          geometry.height > (grid ? 50000 : 900000),
          `${name}/${route}: scrollbar represents only loaded rows (${geometry.height})`
        )
        await page.evaluate(() => (window as any).fixtureLoading.hold())
        await page.locator(".app-page-content").evaluate((element) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
        })
        if (!route.endsWith("playlists")) {
          if (grid)
            await page
              .locator(".app-page-content [data-media-index] .skeleton-block")
              .first()
              .waitFor()
          else
            await page
              .locator(".app-page-content [data-loading-index]")
              .first()
              .waitFor()
          await page.screenshot({
            path: join(
              artifacts,
              `${name}-${route.split("/").at(-1)}-loading.png`
            ),
          })
        }
        await page.evaluate(() => (window as any).fixtureLoading.release())
        console.log(`${name}: ${route} released; waiting for middle rows`)
        await page.waitForFunction(
          ({ selector, grid }) => {
            const rows = [
              ...document.querySelectorAll(selector),
            ] as HTMLElement[]
            const index = Number(
              rows[0]?.getAttribute(
                grid ? "data-media-index" : "data-track-index"
              )
            )
            return (
              rows.length > 0 &&
              index > 300 &&
              (grid
                ? rows.some((row) => row.querySelector(".media-card"))
                : !document.querySelector(
                    ".app-page-content [data-loading-index]"
                  ))
            )
          },
          { selector, grid }
        )
        console.log(`${name}: ${route} checking bottom`)
        await page.locator(".app-page-content").evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        await page
          .waitForFunction(
            ({ selector, total, grid }) => {
              const rows = [...document.querySelectorAll(selector)]
              return (
                rows.some(
                  (row) =>
                    Number(
                      row.getAttribute(
                        grid ? "data-media-index" : "data-track-index"
                      )
                    ) ===
                    total - 1
                ) &&
                (grid
                  ? !!rows.at(-1)?.querySelector(".media-card")
                  : !document.querySelector(
                      ".app-page-content [data-loading-index]"
                    ))
              )
            },
            { selector, total, grid },
            { timeout: 7000 }
          )
          .catch(async (error) => {
            console.log(
              await page.locator(".app-page-content").evaluate((element) => ({
                scroll: element.scrollTop,
                height: element.scrollHeight,
                viewport: element.clientHeight,
                first: element
                  .querySelector(
                    "[data-track-index], [data-loading-index], [data-media-index]"
                  )
                  ?.outerHTML.slice(0, 300),
                last: [
                  ...element.querySelectorAll(
                    "[data-track-index], [data-loading-index], [data-media-index]"
                  ),
                ]
                  .at(-1)
                  ?.outerHTML.slice(0, 300),
                rows: element.querySelectorAll("tbody tr").length,
              }))
            )
            await page.screenshot({
              path: join(artifacts, `${name}-failure.png`),
            })
            throw error
          })
        assert.ok((await page.locator(selector).count()) < (grid ? 180 : 90))
        await page.screenshot({
          path: join(
            artifacts,
            `${name}-${route.split("/").at(-1)}-bottom.png`
          ),
        })
        await page.locator(".app-page-content").evaluate((element) => {
          element.scrollTop = 0
        })
        await page.waitForFunction(
          ({ selector, grid }) =>
            document
              .querySelector(selector)
              ?.getAttribute(grid ? "data-media-index" : "data-track-index") ===
            "0",
          { selector, grid }
        )
        console.log(
          `${name}: ${route}, ${total} items, initial render ${Math.round(performance.now() - started)} ms including jump/scroll checks`
        )
      }
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/collection/tracks")
      )
      await page
        .getByRole("button", { name: "Shuffle liked songs", exact: true })
        .click()
      await page.waitForFunction(
        () => (window as any).fixtureVirtual.playback?.ids.length > 0
      )
      const playback = await page.evaluate(
        () => (window as any).fixtureVirtual.playback
      )
      assert.equal(playback.total, 20000)
      assert.equal(playback.shuffle, true)
      assert.equal(playback.ids.length, 500)
      const ids = playback.ids.map(Number)
      assert.ok(
        Math.max(...ids) - Math.min(...ids) > 15000,
        `${name}: shuffle is limited to a nearby page`
      )
      await page.locator('.app-page-content [data-track-index="0"]').waitFor()
      await page.evaluate(() => {
        const w = window as any
        w.syncSkeletons = 0
        w.syncInitialRow = document.querySelector(
          '.app-page-content [data-track-index="0"]'
        )
        w.syncObserver = new MutationObserver(() => {
          w.syncSkeletons = Math.max(
            w.syncSkeletons,
            document.querySelectorAll(".app-page-content [data-loading-index]")
              .length
          )
        })
        w.syncObserver.observe(document.querySelector(".app-page-content"), {
          subtree: true,
          childList: true,
        })
        w.fixtureLoading.hold()
        w.fixtureVirtual.syncFavorite(19999)
      })
      await page.waitForTimeout(150)
      assert.ok(
        (await page.locator(".app-page-content [data-track-index]").count()) >
          0,
        `${name}: sync cleared the list`
      )
      assert.equal(
        await page.locator(".app-page-content [data-loading-index]").count(),
        0,
        `${name}: sync replaced visible songs with skeletons`
      )
      await page.evaluate(() => (window as any).fixtureLoading.release())
      await page.waitForFunction(() =>
        document
          .querySelector('.app-page-content [data-track-index="0"]')
          ?.textContent?.includes("Synthetic song 19999")
      )
      assert.equal(
        await page.evaluate(
          () =>
            (window as any).syncInitialRow ===
            document.querySelector('.app-page-content [data-track-index="1"]')
        ),
        true,
        `${name}: unchanged songs remounted during live sync`
      )
      assert.equal(
        await page.evaluate(() => {
          const w = window as any
          w.syncObserver.disconnect()
          return w.syncSkeletons
        }),
        0,
        `${name}: live sync flickered through placeholders`
      )
      console.log(
        `${name}: live favorite sync updates without clearing visible rows`
      )
      await page.evaluate(() => (window as any).fixtureVirtual.reviewLikes())
      const syncReview = page.getByRole("button", { name: "Sync liked songs — review needed", exact:true })
      await syncReview.locator("[data-sync-review]").waitFor()
      assert.ok((await syncReview.boundingBox())!.height < 60, `${name}: review indicator broke toolbar layout`)
      await page.screenshot({ path: join(artifacts, `${name}-sync-review.png`) })
      assert.deepEqual(errors, [], `${name}: renderer errors`)
      await page.goto(
        `http://127.0.0.1:${server.port}/tests/fixtures/libraryLayout/index.html?appearance=1&virtual=1&queue=1`
      )
      await page.waitForFunction(() => (window as any).visualFixtureReady)
      await page.evaluate(() =>
        (window as any).fixtureAppearance.route("/collection/tracks")
      )
      await page
        .getByRole("button", { name: "Shuffle liked songs", exact: true })
        .click()
      await page.waitForFunction(
        () => (window as any).fixtureVirtual.queue().total === 20000
      )
      await page.evaluate(() =>
        (window as any).fixtureAppearance.panel("queue", true)
      )
      const queue = page.locator("[data-queue-scroll]")
      await queue.waitFor()
      const panel = page.locator('[aria-label="Player panel"]').locator("..")
      const tabs = await panel.getByRole("button", { name: "Queue", exact: true }).boundingBox()
      const pin = await panel.getByRole("button", { name: "Unpin queue", exact: true }).boundingBox()
      const close = await panel.getByRole("button", { name: "Close queue", exact: true }).boundingBox()
      assert.ok(tabs && pin && close)
      assert.ok(Math.abs((tabs.y + tabs.height/2) - (pin.y + pin.height/2)) < 2, `${name}: pin wrapped below queue tabs`)
      assert.ok(Math.abs((tabs.y + tabs.height/2) - (close.y + close.height/2)) < 2, `${name}: close wrapped below queue tabs`)
      assert.ok(pin.x > tabs.x + tabs.width && close.x > pin.x, `${name}: queue actions are not right aligned`)
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
      )
      assert.ok(
        (await page.locator("[data-queue-index]").count()) < 80,
        `${name}: whole queue mounted`
      )
      assert.match(await queue.innerText(), /19,999|19999/)
      assert.ok(
        (await queue.evaluate((element) => element.scrollHeight)) > 1000000
      )
      await queue.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      const last = page.locator('[data-queue-index="19999"]')
      await last.waitFor({ timeout: 7000 }).catch(async (error) => {
        console.log(
          "QUEUE GEOMETRY",
          await queue.evaluate((element) => ({
            top: element.scrollTop,
            height: element.scrollHeight,
            viewport: element.clientHeight,
            first: element
              .querySelector("[data-queue-index]")
              ?.getAttribute("data-queue-index"),
            last: [...element.querySelectorAll("[data-queue-index]")]
              .at(-1)
              ?.getAttribute("data-queue-index"),
          }))
        )
        await page.screenshot({
          path: join(artifacts, `${name}-queue-failure.png`),
        })
        throw error
      })
      await page.waitForFunction(
        () =>
          !document
            .querySelector('[data-queue-index="19999"]')
            ?.textContent?.includes("Loading song"),
        undefined,
        { timeout: 10000 }
      )
      console.log(`${name}: final queue row hydrated`)
      await page.screenshot({
        path: join(artifacts, `${name}-complete-queue-bottom.png`),
      })
      await last.getByRole("button", { name: /^Play / }).click()
      await page.waitForFunction(
        () => (window as any).fixtureVirtual.queue().index === 19999,
        undefined,
        { timeout: 10000 }
      ).catch(async error => { console.log("QUEUE JUMP", await page.evaluate(() => (window as any).fixtureVirtual.queue())); throw error })
      console.log(`${name}: final queue row selected`)
      // Use the real toolbar actions so docking and tab preferences survive a
      // new document, rather than only setting the synthetic panel state.
      await page.getByRole("button", { name:"Unpin queue", exact:true }).click()
      await page.getByRole("button", { name:"Pin queue", exact:true }).click()
      await page.getByRole("button", { name:"Lyrics", exact:true }).click()
      await page.evaluate(() =>
        (window as any).fixtureVirtual.rememberPosition(43210)
      )
      const before = await page.evaluate(() =>
        (window as any).fixtureVirtual.queue()
      )
      assert.equal(
        before.error,
        null,
        `${name}: synthetic playback did not start`
      )
      // The fixture router changes location; restore its entry URL before a
      // real document reload on the static test server.
      await page.evaluate(() => history.replaceState({}, "", "/tests/fixtures/libraryLayout/index.html?appearance=1&virtual=1&queue=1"))
      await page.reload()
      await page.waitForFunction(
        () =>
          (window as any).visualFixtureReady &&
          (window as any).fixtureVirtual.queue().position === 43210
      ).catch(async error => { console.log("QUEUE RESTORE", await page.evaluate(() => ({ url: location.href, ready: (window as any).visualFixtureReady, queue: (window as any).fixtureVirtual?.queue(), savedBytes: localStorage.getItem("synthetic-queue")?.length, savedState: JSON.parse(localStorage.getItem("synthetic-queue") ?? "null")?.state, body:document.body.innerText.slice(0,500) }))); throw error })
      const after = await page.evaluate(() => ({
        ...(window as any).fixtureVirtual.queue(),
        audioPlays: (window as any).fixtureVirtual.audioPlayCount,
      }))
      assert.equal(after.total, 20000)
      assert.equal(after.index, 19999)
      assert.equal(after.id, before.id)
      assert.equal(after.playing, false)
      await page.getByRole("button", { name:"Unpin queue", exact:true }).waitFor()
      assert.equal(await page.getByRole("button", { name:"Lyrics", exact:true }).getAttribute("aria-pressed"), "true", `${name}: docked tab did not survive restart`)
      await page.getByRole("button", { name:"Queue", exact:true }).click()
      await page.locator("[data-queue-scroll]").waitFor()
      assert.equal(
        after.audioPlays,
        0,
        `${name}: restoration auto-started playback`
      )
      assert.deepEqual(errors, [], `${name}: queue renderer errors`)
      console.log(
        `${name}: complete virtual queue, distant jump and paused restart restoration passed`
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  server?.stop(true)
  await disposeFixture(output)
}
