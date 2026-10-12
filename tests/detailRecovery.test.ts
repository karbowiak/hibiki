import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const kind of ["artist", "album"])
  for (const scenario of ["recovery", "route", "provider", "disconnected"])
    test(`detail ${kind}: ${scenario}`, async () => {
      const child = Bun.spawn(
        [process.execPath, "tests/fixtures/detailRecovery.tsx", kind, scenario],
        { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
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
