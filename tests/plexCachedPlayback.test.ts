import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of ["success", "unavailable", "retired"])
  test(`saved browsing playback metadata: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/plexCachedPlayback.ts", scenario],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
    )
    const [status, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
  })
