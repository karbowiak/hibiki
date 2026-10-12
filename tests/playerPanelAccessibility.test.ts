import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("empty player disables transport without placeholder links and closed overlay/pinned panels are inert", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/playerPanelAccessibility.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})
