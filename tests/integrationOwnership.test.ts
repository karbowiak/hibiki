import { expect, test } from "bun:test"
import { resolve } from "node:path"

for (const scenario of ["hydration", "mutations", "auth", "now-playing"]) {
  test(`integration ownership: ${scenario}`, async () => {
    // Isolate native API mocks from every other frontend regression suite.
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/integrationOwnership.ts", scenario],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, output: stdout + stderr }).toEqual({
      status: 0,
      output: "",
    })
  })
}
