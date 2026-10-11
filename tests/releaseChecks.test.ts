import { expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
const {
  assertCI,
  artifactPlan,
  assertArtifacts,
  assetResponse,
} = require("../scripts/check-release.cjs")

const repo = { owner: "owner", repo: "repo" },
  tag = "v0.5.2",
  commit = "a".repeat(40)
const keys = generateKeyPairSync("ed25519")
const keyId = Buffer.from("0102030405060708", "hex")
const rawKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
const key = Buffer.from(
  `untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`
).toString("base64")
function signed(bytes: Buffer) {
  const signature = sign(
    null,
    createHash("blake2b512").update(bytes).digest(),
    keys.privateKey
  )
  const packet = Buffer.concat([Buffer.from("ED"), keyId, signature])
  const comment = "timestamp:1\tfile:fixture"
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    keys.privateKey
  )
  return Buffer.from(
    `untrusted comment: fixture\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`
  ).toString("base64")
}

function fixture() {
  const bodies = new Map<number, Buffer>()
  const assets: any[] = []
  function asset(name: string, bytes: Buffer) {
    const result = {
      id: assets.length + 1,
      name,
      size: bytes.length,
      state: "uploaded",
    }
    assets.push(result)
    bodies.set(result.id, bytes)
    return result
  }
  asset("Hibiki_0.5.2_aarch64.dmg", Buffer.from("arm dmg"))
  asset("Hibiki_0.5.2_x64.dmg", Buffer.from("intel dmg"))
  const entries = {
    "darwin-aarch64-app": "Hibiki_aarch64.app.tar.gz",
    "darwin-x86_64-app": "Hibiki_x64.app.tar.gz",
    "linux-x86_64-appimage": "Hibiki_0.5.2_amd64.AppImage",
    "linux-x86_64-deb": "Hibiki_0.5.2_amd64.deb",
    "linux-x86_64-rpm": "Hibiki-0.5.2-1.x86_64.rpm",
    "windows-x86_64-msi": "Hibiki_0.5.2_x64_en-US.msi",
    "windows-x86_64-nsis": "Hibiki_0.5.2_x64-setup.exe",
  }
  const platforms: Record<string, any> = {}
  for (const [platform, name] of Object.entries(entries)) {
    const bytes = Buffer.from(`installer:${name}`),
      signature = signed(bytes)
    asset(name, bytes)
    asset(`${name}.sig`, Buffer.from(signature))
    platforms[platform] = {
      url: `https://github.com/owner/repo/releases/download/${tag}/${name}`,
      signature,
    }
  }
  for (const [alias, target] of Object.entries({
    "darwin-aarch64": "darwin-aarch64-app",
    "darwin-x86_64": "darwin-x86_64-app",
    "linux-x86_64": "linux-x86_64-appimage",
    "windows-x86_64": "windows-x86_64-msi",
  }))
    platforms[alias] = { ...platforms[target] }
  const manifest = { version: "0.5.2", platforms }
  const json = asset("latest.json", Buffer.from(JSON.stringify(manifest)))
  const release = { id: 99, tag_name: tag, draft: true, assets }
  const github = {
    rest: { repos: { getRelease: async () => ({ data: release }) } },
  }
  const downloaded: string[] = []
  const download = async (_repo: unknown, item: any) => {
    downloaded.push(item.name)
    return new Response(bodies.get(item.id))
  }
  const update = () => {
    const bytes = Buffer.from(JSON.stringify(manifest))
    bodies.set(json.id, bytes)
    json.size = bytes.length
  }
  return { release, manifest, github, download, downloaded, bodies, update }
}

function ci(runs: any[], tagged = commit) {
  const listWorkflowRuns = () => {}
  return {
    rest: {
      repos: {
        getCommit: async (args: any) => {
          expect(args.ref).toBe(`refs/tags/${tag}`)
          return { data: { sha: tagged } }
        },
      },
      actions: { listWorkflowRuns },
    },
    paginate: async (endpoint: any, args: any) => {
      expect(endpoint).toBe(listWorkflowRuns)
      expect(args.head_sha).toBe(commit)
      return runs
    },
  }
}
const passed = {
  id: 1,
  head_sha: commit,
  event: "push",
  head_branch: "main",
  head_repository: { full_name: "owner/repo" },
  status: "completed",
  conclusion: "success",
}

test("CI gate requires the exact tag and latest successful main push run", async () => {
  await assertCI(ci([passed]), repo, tag, commit)
  for (const runs of [
    [],
    [{ ...passed, head_sha: "old" }],
    [{ ...passed, event: "pull_request" }],
    [{ ...passed, head_repository: { full_name: "fork/repo" } }],
    [passed, { ...passed, id: 2, status: "in_progress", conclusion: null }],
    [passed, { ...passed, id: 2, conclusion: "failure" }],
    [passed, { ...passed, id: 2, conclusion: "cancelled" }],
  ]) {
    await expect(assertCI(ci(runs), repo, tag, commit)).rejects.toThrow(
      "exact tagged commit"
    )
  }
  await expect(
    assertCI(ci([passed], "moved"), repo, tag, commit)
  ).rejects.toThrow("Tag v0.5.2 changed")
})

test("workflow pins packaging to checked commit and gates publishing after matrix builds", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8"
    )
  ) as any
  expect(workflow.concurrency).toEqual({
    group: "release-${{ inputs.tag || github.ref_name }}",
    "cancel-in-progress": false,
  })
  expect(workflow.jobs["build-tauri"].steps[0].with.ref).toBe(
    "${{ needs.create-release.outputs.commit }}"
  )
  const publish = workflow.jobs["publish-release"]
  expect(publish.needs).toEqual(["create-release", "build-tauri"])
  const checks = publish.steps.findIndex(
    (step: any) =>
      step.name === "Verify tag, current CI and signed updater artifacts"
  )
  const write = publish.steps.findIndex(
    (step: any) => step.name === "Publish release"
  )
  expect(checks).toBeGreaterThan(0)
  expect(write).toBeGreaterThan(checks)
  expect(publish.steps[checks].with.script).toContain("assertArtifacts")
  expect(publish.steps[write].with.script).toContain("assertCI")
})

test("complete signed manifests can be checked repeatedly; aliases download each artifact once", async () => {
  const f = fixture()
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      await assertArtifacts(f.github, repo, tag, 99, key, f.download)
    ).toBe(7)
  expect(
    f.downloaded.filter((name) => name === "Hibiki_0.5.2_amd64.AppImage")
  ).toHaveLength(2)
})

test("missing platforms, wrong versions, wrong-tag URLs and incomplete assets block publication", () => {
  for (const mutate of [
    (f: any) => {
      delete f.manifest.platforms["darwin-aarch64"]
    },
    (f: any) => {
      f.manifest.version = "0.5.1"
    },
    (f: any) => {
      f.manifest.platforms["linux-x86_64-deb"].url = f.manifest.platforms[
        "linux-x86_64-deb"
      ].url.replace(tag, "v0.5.1")
    },
    (f: any) => {
      f.release.assets.find((asset: any) => asset.name.endsWith(".sig")).state =
        "new"
    },
    (f: any) => {
      f.release.draft = false
    },
  ]) {
    const f = fixture()
    mutate(f)
    expect(() => artifactPlan(f.manifest, f.release, repo, tag)).toThrow()
  }
})

test("signatures for another asset cannot pass cryptographic verification", async () => {
  const f = fixture()
  const item = f.release.assets.find(
    (asset) => asset.name === "Hibiki_0.5.2_amd64.deb"
  )
  const replacement = Buffer.from("different artifact with same release name")
  f.bodies.set(item.id, replacement)
  item.size = replacement.length
  await expect(
    assertArtifacts(f.github, repo, tag, 99, key, f.download)
  ).rejects.toThrow("Invalid updater signature")
})

test("manifest signatures must match uploaded companions, and invalid trusted comments fail", async () => {
  const f = fixture()
  const companion = f.release.assets.find(
    (asset) => asset.name === "Hibiki_0.5.2_amd64.deb.sig"
  )
  const different = Buffer.from(signed(Buffer.from("different installer")))
  f.bodies.set(companion.id, different)
  companion.size = different.length
  await expect(
    assertArtifacts(f.github, repo, tag, 99, key, f.download)
  ).rejects.toThrow("Manifest signature differs")
  const broken = fixture()
  const entry = broken.manifest.platforms["linux-x86_64-deb"]
  entry.signature = Buffer.from(
    Buffer.from(entry.signature, "base64")
      .toString()
      .replace("timestamp:1", "timestamp:2")
  ).toString("base64")
  broken.update()
  await expect(
    assertArtifacts(broken.github, repo, tag, 99, key, broken.download)
  ).rejects.toThrow("trusted-comment signature")
})

test("truncated downloads fail, and redirect requests never forward GitHub authorization to CDN", async () => {
  const f = fixture()
  const item = f.release.assets.find(
    (asset) => asset.name === "Hibiki_0.5.2_amd64.deb"
  )
  f.bodies.set(item.id, Buffer.from("truncated"))
  await expect(
    assertArtifacts(f.github, repo, tag, 99, key, f.download)
  ).rejects.toThrow("truncated")
  const headers: any[] = []
  const response = await assetResponse(
    repo,
    item,
    async (_url: URL, options: any) => {
      headers.push(options.headers)
      return headers.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              Location: "https://release-assets.githubusercontent.com/fixture",
            },
          })
        : new Response("asset")
    },
    "synthetic-token"
  )
  expect(response.ok).toBe(true)
  expect(headers[0].Authorization).toBe("Bearer synthetic-token")
  expect(headers[1].Authorization).toBeUndefined()
})
