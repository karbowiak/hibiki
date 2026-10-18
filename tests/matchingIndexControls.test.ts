import { expect, test } from "bun:test"

test("index status polling cannot race lifecycle controls or cross library ownership", async () => {
  const child = Bun.spawn([process.execPath, "tests/fixtures/matchingIndexControls.tsx"], { stdout: "pipe", stderr: "pipe" })
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})
