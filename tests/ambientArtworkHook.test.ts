import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("mounted ambient selection is visit-stable, cache-only, source-aware and retires route/account failures", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/ambientArtwork.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})
