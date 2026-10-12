import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("mounted artwork picker preserves explicit choice, scoped fallback, targeted retry and modal focus", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/artworkSourcePicker.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})
