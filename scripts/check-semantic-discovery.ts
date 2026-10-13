import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { build } from "vite"
import { chromium, webkit } from "playwright"
import { SEMANTIC_ASSETS, MODEL_REVISION } from "../src/semantic/manifest"
const root = resolve(import.meta.dir, "..")
const assets = process.env.HIBIKI_SEMANTIC_FIXTURE_ASSETS
if (!assets)
  throw new Error(
    "Set HIBIKI_SEMANTIC_FIXTURE_ASSETS to a directory containing pinned public model files + runtime.wasm; this check never downloads models."
  )
const output = await mkdtemp(join(tmpdir(), "hibiki-semantic-"))
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
        input: resolve(root, "tests/fixtures/semanticDiscovery/index.html"),
      },
    },
  })
  const emitted = await readdir(output, { recursive: true })
  assert(
    !emitted.some((file) => file.endsWith(".wasm")),
    "Runtime must be verified on explicit install, never duplicated in bundled assets"
  )
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = resolve(output, "." + new URL(request.url).pathname)
      if (!path.startsWith(output + "/"))
        return new Response("Invalid", { status: 400 })
      const file = Bun.file(path)
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 })
    },
  })
  for (const [name, type] of [
    ["chrome", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({
      headless: true,
      ...(name === "chrome"
        ? { channel: process.env.HIBIKI_CHROME_CHANNEL ?? "chrome" }
        : {}),
    })
    try {
      const context = await browser.newContext()
      let assetRequests = 0
      let unexpected = 0
      await context.route("**/*", async (route) => {
        const url = route.request().url()
        if (new URL(url).hostname === "127.0.0.1") {
          await route.continue()
          return
        }
        const asset = SEMANTIC_ASSETS.find((asset) => asset.url === url)
        if (!asset) {
          unexpected++
          await route.abort()
          return
        }
        assetRequests++
        const file = resolve(assets, asset.name)
        await route.fulfill({
          status: 200,
          body: Buffer.from(await Bun.file(file).arrayBuffer()),
          headers: {
            "Content-Type": asset.name.endsWith(".wasm")
              ? "application/wasm"
              : asset.name.endsWith(".onnx")
                ? "application/octet-stream"
                : "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        })
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(
        `http://127.0.0.1:${server.port}/tests/fixtures/semanticDiscovery/index.html`
      )
      await page
        .getByRole("button", { name: "Download local model", exact: true })
        .waitFor()
      assert.equal(assetRequests, 0, "No model download before explicit action")
      await page
        .getByRole("button", { name: "Download local model", exact: true })
        .click()
      await page
        .getByRole("checkbox", { name: "Enable local semantic discovery" })
        .waitFor({ timeout: 60000 })
      assert.equal(assetRequests, 5)
      const result = await page.evaluate(() => (window as any).testEmbeddings())
      assert.deepEqual(result.top, [0, 1, 2, 3, 4])
      assert.equal(result.dimensions, 384)
      assert(result.norms.every((n: number) => Math.abs(n - 1) < 0.01))
      assert(Math.abs(result.longNorm - 1) < 0.01)
      assert.equal(
        assetRequests,
        5,
        "Inference makes no model/upstream downloads"
      )
      assert.equal(unexpected, 0)
      assert.deepEqual(errors, [])
      console.log(
        `${name}: explicit verified download; real local worker paraphrases5/5, 384D norms, long-input bounded; no unexpected requests`
      )
      await context.close()
    } finally {
      await browser.close()
    }
  }
  console.log(
    `Pinned model ${MODEL_REVISION}: production semantic worker passed both engines`
  )
} finally {
  server?.stop(true)
  await rm(output, { recursive: true, force: true })
}
