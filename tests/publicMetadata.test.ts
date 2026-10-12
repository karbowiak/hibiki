import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("public providers anchor identities and keep descriptions separate from biographies", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/publicMetadata.ts"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: stdout + stderr }).toEqual({ status: 0, output: "" })
})
