import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("mounted Edit metadata snapshots retire query/account work and support only targeted refresh", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/metadataSnapshot.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: stdout + stderr }).toEqual({ status: 0, output: "" })
})
