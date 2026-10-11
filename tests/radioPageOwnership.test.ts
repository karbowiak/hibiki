import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "plex-route",
  "plex-provider",
  "plex-capability",
  "plex-unmount",
  "plex-retry",
  "plex-selection",
  "plex-opaque",
  "public-search",
  "public-search-retry",
  "public-country",
  "public-genre",
  "public-featured-retry",
  "public-countries-retry",
  "public-tags-retry",
  "public-unmount",
]) {
  test(`mounted radio page ownership: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/radioPageOwnership.tsx", scenario],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
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
