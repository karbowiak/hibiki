import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"
import { renderLinuxMetadata } from "../scripts/prepare-linux-metadata"
const {
  uploadCompanion,
  downloadUpdateArtifacts,
} = require("../scripts/appimage-release.cjs")
const root = resolve(import.meta.dir, "..")
const tag = "v0.5.5"
const image = "Hibiki_0.5.5_amd64.AppImage"
const data = Buffer.from("synthetic installer")
const side = Buffer.from("synthetic companion")
function asset(name: string, bytes: Buffer, id: number) {
  return {
    name,
    id,
    size: bytes.length,
    digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  }
}
function mock(
  options: {
    published?: boolean
    tag?: string
    existing?: Buffer
    publishOnSecond?: boolean
  } = {}
) {
  const writes: string[] = []
  let reads = 0
  const assets = [asset(image, data, 1)]
  if (options.existing)
    assets.push(asset(image + ".zsync", options.existing, 2))
  const github = {
    rest: {
      repos: {
        getRelease: async () => ({
          data: {
            draft: !(
              options.published ||
              (options.publishOnSecond && ++reads > 1)
            ),
            tag_name: options.tag ?? tag,
            assets,
          },
        }),
        deleteReleaseAsset: async () => {
          writes.push("delete")
        },
        uploadReleaseAsset: async (request: any) => {
          expect(request.data).toEqual(side)
          writes.push("upload")
        },
      },
    },
  }
  return { github, writes, assets }
}
async function files(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hibiki-packaging-"))
  try {
    await writeFile(join(dir, image), data)
    await writeFile(join(dir, image + ".zsync"), side)
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
describe("Linux package metadata", () => {
  test("actual template matches package version, desktop identity and MIT license", () => {
    const xml = renderLinuxMetadata(
      readFileSync(
        join(root, "src-tauri/linux/app.hibiki.client.metainfo.xml.in"),
        "utf8"
      ),
      "0.5.5",
      "2026-10-12"
    )
    expect(xml).toContain('version="0.5.5"')
    expect(xml).toContain('date="2026-10-12"')
    expect(xml).toContain('type="stable"')
    expect(xml).toContain("Hibiki.desktop")
    expect(xml).toContain("<project_license>MIT</project_license>")
    const config = JSON.parse(
      readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")
    )
    for (const format of ["appimage", "deb", "rpm"])
      expect(
        config.bundle.linux[format].files[
          "/usr/share/metainfo/app.hibiki.client.metainfo.xml"
        ]
      ).toContain("linux-metadata")
    expect(config.build.beforeBundleCommand).toContain("prepare-linux-metadata")
  })
  test("rejects invalid versions, impossible dates and unresolved placeholders", () => {
    expect(() =>
      renderLinuxMetadata("@VERSION@", "<bad>", "2026-10-12")
    ).toThrow()
    expect(() =>
      renderLinuxMetadata("@VERSION@", "0.5.5", "2026-02-30")
    ).toThrow()
    expect(() =>
      renderLinuxMetadata("@UNKNOWN@", "0.5.5", "2026-10-12")
    ).toThrow()
    expect(
      renderLinuxMetadata("@RELEASE_TYPE@", "0.1.0", "2026-10-12", true)
    ).toBe("development")
  })
})
describe("AppImage companion release ownership", () => {
  test("uploads only matching validated installer and reuses identical companion", async () =>
    files(async (dir) => {
      const fresh = mock()
      expect(
        await uploadCompanion(fresh.github, {}, 10, tag, join(dir, image))
      ).toBe("uploaded")
      expect(fresh.writes).toEqual(["upload"])
      const retry = mock({ existing: side })
      expect(
        await uploadCompanion(retry.github, {}, 10, tag, join(dir, image))
      ).toBe("reused")
      expect(retry.writes).toEqual([])
      const stale = mock({ existing: Buffer.from("old") })
      await uploadCompanion(stale.github, {}, 10, tag, join(dir, image))
      expect(stale.writes).toEqual(["delete", "upload"])
    }))
  test("never mutates published, wrong-tag or concurrently published draft", async () =>
    files(async (dir) => {
      for (const options of [
        { published: true },
        { tag: "v0.5.4" },
        { publishOnSecond: true, existing: Buffer.from("old") },
      ]) {
        const m = mock(options)
        await expect(
          uploadCompanion(m.github, {}, 10, tag, join(dir, image))
        ).rejects.toThrow()
        expect(m.writes).toEqual([])
      }
      const m = mock()
      m.assets[0].digest = "sha256:wrong"
      await expect(
        uploadCompanion(m.github, {}, 10, tag, join(dir, image))
      ).rejects.toThrow()
      expect(m.writes).toEqual([])
    }))
  test("downloads exact owned bytes and rejects oversized or corrupt responses", async () =>
    files(async (dir) => {
      const m = mock({ existing: side })
      const destination = join(dir, "download")
      const fetch = async (_: unknown, a: any) =>
        new Response(a.id === 1 ? data : side)
      expect(
        await downloadUpdateArtifacts(m.github, {}, 10, tag, destination, fetch)
      ).toBe(join(destination, image))
      expect(await readFile(join(destination, image))).toEqual(data)
      await expect(
        downloadUpdateArtifacts(
          m.github,
          {},
          10,
          tag,
          join(dir, "bad"),
          async () => new Response(Buffer.alloc(data.length + 1))
        )
      ).rejects.toThrow()
      await expect(
        downloadUpdateArtifacts(
          m.github,
          {},
          10,
          tag,
          join(dir, "corrupt"),
          async () => new Response(Buffer.alloc(data.length))
        )
      ).rejects.toThrow()
      m.assets.push(asset(image, data, 3))
      await expect(
        downloadUpdateArtifacts(
          m.github,
          {},
          10,
          tag,
          join(dir, "duplicate"),
          fetch
        )
      ).rejects.toThrow()
    }))
})

test("offline relocated metadata and zsync corruption boundaries", () => {
  const result = Bun.spawnSync(
    [
      process.platform === "win32" ? "python" : "python3",
      "scripts/test-appimage.py",
    ],
    { cwd: root }
  )
  expect(result.exitCode).toBe(0)
})
