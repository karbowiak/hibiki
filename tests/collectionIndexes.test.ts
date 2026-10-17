import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("collection indexes share owned reads, recover errors and retire cleared metadata", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/collectionIndexes.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
})
