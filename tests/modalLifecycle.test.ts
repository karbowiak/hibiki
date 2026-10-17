import { expect, test } from "bun:test"

test("shared dialogs preserve focus, isolation, close gates and nested teardown", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/modalLifecycle.tsx"],
    {
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
