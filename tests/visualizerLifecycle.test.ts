import { expect, test } from "bun:test"
import { resolve } from "node:path"

for (const scenario of [
  "compact",
  "bridge",
  "milkdrop",
  "cancel-meta",
  "cancel-packs",
  "native",
  "party",
]) {
  test(`visualizer lifecycle: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/visualizerLifecycle.tsx", scenario],
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
