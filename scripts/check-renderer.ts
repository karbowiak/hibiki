import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join, relative } from "node:path"
import { build } from "vite"
import { chromium, webkit } from "playwright"

const root = resolve(import.meta.dir, "..")
const output = await mkdtemp(join(tmpdir(), "hibiki-renderer-"))
const config = await Bun.file(resolve(root, "src-tauri/tauri.conf.json")).json()
const policy = config.app.security.csp
const csp =
  typeof policy === "string"
    ? policy
    : Object.entries(policy ?? {})
        .map(
          ([directive, sources]) =>
            `${directive} ${Array.isArray(sources) ? sources.join(" ") : sources}`
        )
        .join("; ")
const artifactDir = resolve(root, ".tmp/renderer-checks")
await mkdir(artifactDir, { recursive: true })

// A small silent PCM fixture exercises the actual radio player without any server
// account, Plex integration, or audible output.
const samples = 44100 * 10
const wav = Buffer.alloc(44 + samples * 2)
wav.write("RIFF", 0)
wav.writeUInt32LE(wav.length - 8, 4)
wav.write("WAVEfmt ", 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(44100, 24)
wav.writeUInt32LE(44100 * 2, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write("data", 36)
wav.writeUInt32LE(samples * 2, 40)
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#748ac7"/></svg>'
const font = await Bun.file(
  resolve(
    root,
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
  )
).bytes()
const unexpectedRequests: string[] = []

try {
  await build({
    root,
    configFile: resolve(root, "vite.config.ts"),
    logLevel: "error",
    build: {
      outDir: output,
      emptyOutDir: true,
      sourcemap: false,
      rolldownOptions: {
        input: [
          resolve(root, "index.html"),
          resolve(root, "tests/fixtures/renderer/index.html"),
        ],
      },
    },
  })
  const certificate = join(output, "fixture-cert.pem")
  const key = join(output, "fixture-key.pem")
  const certificateProcess = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdout: "ignore", stderr: "ignore" }
  )
  assert.equal(
    await certificateProcess.exited,
    0,
    "Could not generate an ephemeral fixture certificate"
  )
  const socketOptions = {
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, server: any) {
      const url = new URL(request.url)
      if (
        url.pathname === "/:/websockets/notifications" &&
        url.searchParams.get("X-Plex-Token") === "synthetic-renderer-token" &&
        server.upgrade(request)
      )
        return
      return new Response(null, { status: 404 })
    },
    websocket: { message() {} },
  }
  const wsServer = Bun.serve(socketOptions)
  const wssServer = Bun.serve({
    ...socketOptions,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/renderer-fixture.json")
        return Response.json({
          ws: `http://127.0.0.1:${wsServer.port}`,
          wss: `https://127.0.0.1:${wssServer.port}`,
        })
      if (url.pathname === "/radio.wav")
        return new Response(wav, { headers: { "Content-Type": "audio/wav" } })
      if (url.pathname.includes("untrusted-"))
        unexpectedRequests.push(url.pathname)
      const path = resolve(
        output,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`
      )
      if (relative(output, path).startsWith(".."))
        return new Response(null, { status: 400 })
      const file = Bun.file(path)
      if (!(await file.exists())) return new Response(null, { status: 404 })
      const headers: Record<string, string> = {}
      if (path.endsWith(".html") && csp)
        headers["Content-Security-Policy"] = csp
      return new Response(file, { headers })
    },
  })
  try {
    for (const name of (
      process.env.HIBIKI_RENDERERS ?? "chromium,webkit"
    ).split(",")) {
      assert.ok(
        name === "chromium" || name === "webkit",
        `Unknown renderer ${name}`
      )
      const browser = await (name === "chromium" ? chromium : webkit).launch({
        headless: true,
        // CI has no physical GPU. Exercise WebGL through Chromium's software GL
        // driver, only in these isolated fixtures; the desktop app uses its GPU.
        ...(name === "chromium" && process.env.LIBGL_ALWAYS_SOFTWARE === "1"
          ? { args: ["--use-gl=angle", "--use-angle=swiftshader"] }
          : {}),
        ...(name === "chromium" && process.env.HIBIKI_CHROME_CHANNEL
          ? { channel: process.env.HIBIKI_CHROME_CHANNEL }
          : {}),
      })
      try {
        const context = await browser.newContext({
          viewport: { width: 1400, height: 890 },
          // Trust only the context's synthetic TLS test. Native certificate
          // verification remains covered by Rust tests and is not changed here.
          ignoreHTTPSErrors: true,
        })
        const origin = `http://127.0.0.1:${server.port}`
        await context.route("**/*", (route) => {
          if (new URL(route.request().url()).origin === origin)
            return route.continue()
          unexpectedRequests.push("unexpected external request")
          return route.abort()
        })
        // Each renderer gets a fresh temporary browser profile and synthetic-only
        // endpoints. Never attach to the user's browser or read saved credentials.
        // Preserve the existing Circular font origin without depending on its CDN
        // being reachable: deliver a bundled, redistributable font as fixture bytes.
        await context.route("https://encore.scdn.co/fonts/**", (route) =>
          route.fulfill({
            contentType: "font/woff2",
            body: Buffer.from(font),
            headers: { "Access-Control-Allow-Origin": "*" },
          })
        )
        await context.route("http://image.localhost/**", (route) =>
          route.fulfill({
            contentType: "image/svg+xml",
            body: svg,
            headers: { "Access-Control-Allow-Origin": "*" },
          })
        )
        await context.route("http://ipc.localhost/**", (route) =>
          route.fulfill({
            contentType: "text/plain",
            body: "fixture IPC",
            headers: { "Access-Control-Allow-Origin": "*" },
          })
        )
        await context.route("http://untrusted.localhost/**", (route) => {
          unexpectedRequests.push("untrusted external request")
          return route.fulfill({
            contentType: "application/javascript",
            body: "window.remoteScriptRan = true",
          })
        })
        const page = await context.newPage()
        await page.goto(origin)
        await page
          .getByRole("heading", { name: "Open the Hibiki desktop app" })
          .waitFor()
        const fonts = await page.evaluate(async () => {
          await document.fonts.ready
          return [...document.fonts].filter((font) => font.status === "loaded")
            .length
        })
        assert.ok(fonts > 0, `${name}: bundled fonts were not loaded`)
        await page.screenshot({ path: join(artifactDir, `${name}-app.png`) })
        await page.goto(`${origin}/tests/fixtures/renderer/index.html`)
        await page
          .getByRole("button", { name: "Start renderer checks" })
          .click()
        await page.waitForFunction(
          () => {
            const state = (window as any).rendererCheck
            return state?.ready || state?.error
          },
          undefined,
          { timeout: 30000 }
        )
        const state = await page.evaluate(() => (window as any).rendererCheck)
        assert.equal(state.error, "", `${name}: ${state.error}`)
        assert.equal(state.ready, true)
        assert.ok(state.presetCount > 0, `${name}: no preset pack metadata`)
        assert.equal(state.frames, 5)
        assert.equal(state.artwork, true)
        assert.equal(state.focalPoint, true)
        assert.equal(state.ipc, true)
        assert.deepEqual(
          state.violations,
          [],
          `${name}: CSP blocked a supported feature`
        )
        await page.waitForFunction(
          () => (window as any).rendererCheck.radioPlaying,
          undefined,
          { timeout: 5000 }
        )
        await page.waitForFunction(
          () => {
            const state = (window as any).rendererCheck
            return state.plexWs && state.plexWss
          },
          undefined,
          { timeout: 5000 }
        )
        assert.deepEqual(
          await page.evaluate(() => (window as any).rendererCheck.violations),
          []
        )
        await page.evaluate(() => (window as any).pauseRadio())
        await page.waitForFunction(
          () => (window as any).rendererCheck.radioPaused
        )
        assert.equal(
          await page.evaluate(() => (window as any).rendererCheck.radioError),
          ""
        )
        await page.screenshot({
          path: join(artifactDir, `${name}-milkdrop.png`),
        })
        await page.evaluate(() => (window as any).tryUntrustedContent(true))
        await page.waitForTimeout(100)
        assert.equal(
          await page.evaluate(() => (window as any).inlineScriptRan),
          undefined,
          `${name}: inline script ran`
        )
        await page.evaluate(() => (window as any).tryUntrustedContent())
        await page.waitForTimeout(250)
        const security = await page.evaluate(() => ({
          inline: (window as any).inlineScriptRan,
          handler: (window as any).inlineHandlerRan,
          remote: (window as any).remoteScriptRan,
          base: document.baseURI,
          violations: (window as any).rendererCheck.violations,
        }))
        assert.equal(security.inline, undefined, `${name}: inline script ran`)
        assert.equal(
          security.handler,
          undefined,
          `${name}: inline event handler ran`
        )
        assert.equal(security.remote, undefined, `${name}: remote script ran`)
        assert.ok(
          security.base.startsWith(origin),
          `${name}: injected base URL was used`
        )
        for (const directive of [
          "script-src-elem",
          "script-src-attr",
          "frame-src",
          "object-src",
          "base-uri",
          "form-action",
        ]) {
          assert.ok(
            security.violations.includes(directive),
            `${name}: ${directive} was not enforced`
          )
        }
        assert.deepEqual(
          unexpectedRequests,
          [],
          `${name}: untrusted content reached the network`
        )
        await page.evaluate(() => (window as any).disposeRenderer())
        console.log(
          `${name}: app, MilkDrop, artwork, IPC, radio, Plex WS/WSS, and CSP enforcement passed`
        )
        await context.close()
      } finally {
        await browser.close()
      }
    }
  } finally {
    server.stop(true)
    wsServer.stop(true)
    wssServer.stop(true)
  }
} finally {
  await rm(output, { recursive: true, force: true })
}
