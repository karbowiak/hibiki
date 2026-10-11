import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of ["detail-route", "detail-error", "search-race", "category-retirement", "lookup-error", "search-unmount", "identity"]) {
  test(`podcast lifecycle: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "tests/fixtures/podcastLifecycle.tsx", scenario], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    })
    const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
  })
}
