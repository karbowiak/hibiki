import { expect, test } from "bun:test"
import { resolve } from "node:path"
test("linked playlist UI previews explicit recording choices, retains enable once, syncs and pauses", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/linkedPlaylistUI.tsx"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})
test("linked poll respects offline, pause and retired service leases", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/linkedPlaylistPoll.tsx"],
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
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})

test("smart playlist configuration exposes export only and preserves manual snapshot sync", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/linkedPlaylistUI.tsx", "smart"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})
