import { expect, test } from "bun:test"
import { resolve } from "node:path"

for (const [scenario, description] of [
  [
    "features",
    "native permissions cover the real window, menu, event, link, and updater SDK calls",
  ],
  [
    "boundaries",
    "unused privileged native operations are not granted to the frontend",
  ],
  [
    "scope",
    "only explicitly selected local main-window capabilities are enabled",
  ],
]) {
  test(description, async () => {
    // Other store tests mock SDK modules; use a fresh process for the actual SDK.
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/tauriCapabilities.ts", scenario],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    expect(stdout.trim()).toBe("Capability scenario passed")
  })
}
