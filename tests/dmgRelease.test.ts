import { test, expect } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
const { uploadDmgSignature } = require("../scripts/dmg-release.cjs")
const repo = { owner: "owner", repo: "repo" },
  tag = "v0.6.0",
  name = "Hibiki_0.6.0_x64.dmg",
  data = Buffer.alloc(512, 7),
  signature = Buffer.from("synthetic signature")
const asset = (name: string, bytes: Buffer, id: number) => ({
  name,
  id,
  size: bytes.length,
  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
})
async function files(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hibiki-dmg-test-"))
  try {
    const path = join(dir, name)
    await writeFile(path, data)
    await writeFile(path + ".sig", signature)
    await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
function harness(
  options: {
    published?: boolean
    publishSecond?: boolean
    existing?: Buffer
    mismatch?: boolean
  } = {}
) {
  let reads = 0
  const writes: string[] = [],
    assets = [asset(name, data, 1)]
  if (options.mismatch) assets[0].digest = "sha256:" + "0".repeat(64)
  if (options.existing) assets.push(asset(name + ".sig", options.existing, 2))
  const github = {
    rest: {
      repos: {
        getRelease: async () => ({
          data: {
            draft: !(
              options.published ||
              (options.publishSecond && ++reads > 1)
            ),
            tag_name: tag,
            assets,
          },
        }),
        deleteReleaseAsset: async () => {
          writes.push("delete")
        },
        uploadReleaseAsset: async (request: any) => {
          expect(request.name).toBe(name + ".sig")
          expect(request.data).toEqual(signature)
          writes.push("upload")
        },
      },
    },
  }
  return { github, writes }
}
test("DMG signature upload binds local bytes and reuses identical draft companion", async () => {
  await files(async (path) => {
    const fresh = harness()
    expect(await uploadDmgSignature(fresh.github, repo, 1, tag, path)).toBe(
      "uploaded"
    )
    expect(fresh.writes).toEqual(["upload"])
    const same = harness({ existing: signature })
    expect(await uploadDmgSignature(same.github, repo, 1, tag, path)).toBe(
      "reused"
    )
    expect(same.writes).toEqual([])
  })
})
test("DMG signature upload refuses published, newly published and different installer bytes", async () => {
  await files(async (path) => {
    for (const options of [
      { published: true },
      { publishSecond: true, existing: Buffer.from("old") },
      { mismatch: true },
    ]) {
      const f = harness(options)
      await expect(
        uploadDmgSignature(f.github, repo, 1, tag, path)
      ).rejects.toThrow()
      expect(f.writes).toEqual([])
    }
  })
})
test("draft retries may replace a different signature without replacing the installer", async () => {
  await files(async (path) => {
    const f = harness({ existing: Buffer.from("old") })
    expect(await uploadDmgSignature(f.github, repo, 1, tag, path)).toBe(
      "uploaded"
    )
    expect(f.writes).toEqual(["delete", "upload"])
  })
})
