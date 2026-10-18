import { expect, test } from "bun:test"

test("same-named provider playlists create a queued merge directly with source logos", async () => {
  const child = Bun.spawn([process.execPath, "tests/fixtures/mergePlaylistDialog.tsx"], { stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ status, output: stdout + stderr }).toEqual({ status: 0, output: "" })
})
