import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "thumbnail-eviction",
  "thumbnail-batch",
  "thumbnail-retired",
  "thumbnail-identity",
  "thumbnail-coalescing",
  "home-source",
  "home-playback",
  "home-playback-hub",
  "home-playback-latest",
  "home-playback-error",
  "mix-selection",
  "mix-provider",
  "mix-retry",
  "mix-capability",
  "stations-provider",
  "stations-retry",
  "stations-capability",
  "stations-search",
  "stations-seeds",
  "stations-search-retry",
]) {
  test(`mounted mix ownership: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/mixOwnership.tsx", scenario],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, output: output + errors }).toEqual({
      status: 0,
      output: "",
    })
  })
}
