import { expect, test } from "bun:test"
for (const scenario of ["pages", "cycle", "account"]) {
  test(`YouTube Music likes preserve pagination and content boundaries: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "tests/fixtures/youtubeMusicLibrary.ts", scenario], { stdout: "pipe", stderr: "pipe" })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ status, output: stdout + stderr }).toEqual({ status: 0, output: "" })
  })
}
