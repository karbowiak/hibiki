import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "tracks",
  "album",
  "failure",
  "retired",
  "scope",
  "cancel",
  "release-outside",
]) {
  test(`pointer playlist drop: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/playlistPointerDrop.tsx", scenario],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
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
