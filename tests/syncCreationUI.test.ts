import { test, expect } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "known",
  "unknown",
  "late",
  "notices",
  "known-export",
  "unknown-export",
]) {
  test(`sync creation recovery ${scenario} preserves destination and account ownership`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/syncCreationUI.tsx", scenario],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
    )
    const [status, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
  })
}
