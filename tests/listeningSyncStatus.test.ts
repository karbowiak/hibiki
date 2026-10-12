import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "normal",
  "saving",
  "transient",
  "unsafe",
  "account",
  "status-error",
  "status-recovery",
  "retry-error",
  "poll-overlap",
  "retry-race",
  "unmount-retry",
]) {
  test(`mounted listening sync status: ${scenario}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/listeningSyncStatus.tsx", scenario],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, output: output + errors }).toEqual({
      status: 0,
      output: "",
    })
  })
}
