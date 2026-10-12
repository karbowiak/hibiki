import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("inline artwork panel uses cached protocol previews and retires account/item actions without modal focus", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/artworkSourcePanel.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})
