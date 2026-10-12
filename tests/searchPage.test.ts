import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "reachability",
  "filters-reset",
  "playback",
  "card-interactions",
  "states-history",
  "compact-shortcut",
  "default-table",
]) {
  test(`mounted full search page: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/searchPage.tsx", scenario],
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
