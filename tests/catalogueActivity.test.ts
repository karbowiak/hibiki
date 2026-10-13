import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("library progress lives in Activity; errors use notifications and offline retries stay blocked", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/catalogueActivity.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
})
