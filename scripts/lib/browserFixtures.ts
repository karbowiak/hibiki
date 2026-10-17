import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, relative } from "node:path"
import { createHash } from "node:crypto"
import { build } from "vite"
import type { BrowserType } from "playwright"

const root = resolve(import.meta.dir, "../..")
/** Batch runs share immutable builds; each check still owns its browser/server. */
export async function fixtureBuild(
  inputs: string[],
  platform: string | undefined = process.env.TAURI_ENV_PLATFORM
) {
  const parent = process.env.HIBIKI_FIXTURE_BUILDS
  const key = createHash("sha256")
    .update(JSON.stringify([inputs, platform ?? null]))
    .digest("hex")
    .slice(0, 16)
  const output = parent
    ? resolve(parent, key)
    : await mkdtemp(join(tmpdir(), "hibiki-browser-"))
  if (parent && (await Bun.file(join(output, "fixture-ready")).exists()))
    return output
  await mkdir(output, { recursive: true })
  const previous = process.env.TAURI_ENV_PLATFORM
  try {
    if (platform === undefined) delete process.env.TAURI_ENV_PLATFORM
    else process.env.TAURI_ENV_PLATFORM = platform
    await build({
      root,
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "error",
      build: {
        outDir: output,
        emptyOutDir: true,
        sourcemap: false,
        rolldownOptions: { input: inputs.map((input) => resolve(root, input)) },
      },
    })
    if (parent) await Bun.write(join(output, "fixture-ready"), "ready")
    return output
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  } finally {
    if (previous === undefined) delete process.env.TAURI_ENV_PLATFORM
    else process.env.TAURI_ENV_PLATFORM = previous
  }
}
export async function disposeFixture(output: string) {
  const shared = process.env.HIBIKI_FIXTURE_BUILDS
  if (!shared || relative(resolve(shared), output).startsWith(".."))
    await rm(output, { recursive: true, force: true })
}
export async function fixtureFile(
  output: string,
  pathname: string,
  headers?: HeadersInit
) {
  const path = resolve(output, `.${decodeURIComponent(pathname)}`)
  if (path === output || relative(output, path).startsWith(".."))
    return new Response(null, { status: 404 })
  const file = Bun.file(path)
  return (await file.exists())
    ? new Response(file, { headers })
    : new Response(null, { status: 404 })
}
export function launchFixtureBrowser(type: BrowserType, softwareGL = false) {
  return type.launch({
    headless: true,
    ...(softwareGL &&
    type.name() === "chromium" &&
    process.env.LIBGL_ALWAYS_SOFTWARE === "1"
      ? { args: ["--use-gl=angle", "--use-angle=swiftshader"] }
      : {}),
    ...(type.name() === "chromium" && process.env.HIBIKI_CHROME_CHANNEL
      ? { channel: process.env.HIBIKI_CHROME_CHANNEL }
      : {}),
  })
}
