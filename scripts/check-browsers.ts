import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

// Sequential checks keep deterministic fixture ownership, but identical
// entrypoints/platforms compile only once for this disposable run.
const output = await mkdtemp(join(tmpdir(), "hibiki-browser-suite-"))
const checks = [
  "renderer",
  "library-layout",
  "search-discovery",
  "notifications",
  "virtual-collections",
  "playlist-information",
  "playlist-management",
  "appearance",
  "device-correction",
]
const requested = process.argv.slice(2)
const selected = requested.length ? requested : checks
if (selected.some((check) => ![...checks, "metadata-edit-ui"].includes(check)))
  throw Error("Unknown browser check")
try {
  for (const check of selected) {
    console.log(`Checking ${check}`)
    const child = Bun.spawn([process.execPath, `scripts/check-${check}.ts`], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, HIBIKI_FIXTURE_BUILDS: output },
    })
    const status = await child.exited
    if (status !== 0) throw Error(`${check} failed (${status})`)
  }
} finally {
  await rm(output, { recursive: true, force: true })
}
