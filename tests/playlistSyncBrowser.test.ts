import { test, expect } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "browse",
  "create-pending",
  "create-retired",
  "create-unknown",
  "readonly",
  "retired",
  "wildcard",
  "weekly",
  "weekly-tie",
  "weekly-nodate",
]) {
  test(`global Sync UI ${scenario}: scoped roster, one modal and explicit matching`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/playlistSyncBrowser.tsx", scenario],
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
