import { expect, test } from "bun:test"
import { resolve } from "node:path"
for (const scenario of [
  "disabled",
  "plex-first",
  "deezer-first",
  "failed-plex",
  "entity-switch",
  "playback-notice",
]) {
  test(`mounted artwork/playback preference consumer: ${scenario}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "tests/fixtures/artworkPreferenceConsumers.tsx",
        scenario,
      ],
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
}
