import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "local",
  "bulk",
  "race",
  "retired",
  "dialog",
  "page",
  "corrupt",
  "remote_reload",
  "recording",
  "heart",
  "matching",
  "reset",
  "reset_matching",
  "reset_controls",
])
  test(`favorites ${scenario} uses local storage and scoped sync`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/favoritesStore.tsx", scenario],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
    )
    const [status, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
  })
