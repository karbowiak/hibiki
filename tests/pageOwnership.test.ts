import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "tag-route",
  "tag-provider",
  "tag-pagination",
  "tag-offset",
  "tag-capability",
  "playlist-double",
  "playlist-unmount",
  "playlist-provider",
  "playlist-focus",
  "playlist-followup",
  "search-errors",
  "search-topbar",
]) {
  test(`mounted page ownership: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/pageOwnership.tsx", scenario],
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
