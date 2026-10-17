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
function signed(bytes: Buffer, comment = "timestamp:1\tfile:fixture") {
  const signature = sign(
    null,
    createHash("blake2b512").update(bytes).digest(),
    keys.privateKey
  )
  const packet = Buffer.concat([Buffer.from("ED"), keyId, signature])
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    keys.privateKey
  )
  return Buffer.from(
    `untrusted comment: fixture\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`
  ).toString("base64")
}

function fixture(version = "0.5.2", legacyMacArchives = false) {
  const releaseTag = `v${version}`
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
  const modern =
    Number(version.split(".")[0]) > 0 || Number(version.split(".")[1]) >= 6
  for (const arch of ["aarch64", "x64"]) {
    const name = `Hibiki_${version}_${arch}.dmg`
    const bytes = modern
      ? Buffer.alloc(512, arch === "x64" ? 1 : 2)
      : Buffer.from(`${arch} dmg`)
    asset(name, bytes)
    if (modern)
      asset(
        `${name}.sig`,
        Buffer.from(
          signed(bytes, `timestamp:1\tfile:${name}\tversion:${version}`)
        )
      )
  }
  const entries = {
    "darwin-aarch64-app": legacyMacArchives
      ? "Hibiki_aarch64.app.tar.gz"
      : `Hibiki_${version}_aarch64.app.tar.gz`,
    "darwin-x86_64-app": legacyMacArchives
      ? "Hibiki_x64.app.tar.gz"
      : `Hibiki_${version}_x64.app.tar.gz`,
    "linux-x86_64-appimage": `Hibiki_${version}_amd64.AppImage`,
    "linux-x86_64-deb": `Hibiki_${version}_amd64.deb`,
    "linux-x86_64-rpm": `Hibiki-${version}-1.x86_64.rpm`,
    "windows-x86_64-msi": `Hibiki_${version}_x64_en-US.msi`,
    "windows-x86_64-nsis": `Hibiki_${version}_x64-setup.exe`,
  }
  const platforms: Record<string, any> = {}
  for (const [platform, name] of Object.entries(entries)) {
    const bytes = Buffer.from(`installer:${name}`),
      signature = signed(
        bytes,
        `timestamp:1\tfile:fixture${modern ? `\tversion:${version}` : ""}`
      )
    asset(name, bytes)
    asset(`${name}.sig`, Buffer.from(signature))
    platforms[platform] = {
      url: `https://github.com/owner/repo/releases/download/${releaseTag}/${name}`,
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
  const manifest = { version, platforms }
  const json = asset("latest.json", Buffer.from(JSON.stringify(manifest)))
  const release = { id: 99, tag_name: releaseTag, draft: true, assets }
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
  expect(publish.needs).toEqual(["create-release", "check-source", "build-tauri"])
  const checks = publish.steps.findIndex(
    (step: any) =>
      step.name === "Verify tag and signed updater artifacts"
  )
  const write = publish.steps.findIndex(
    (step: any) => step.name === "Publish release"
  )
  expect(checks).toBeGreaterThan(0)
  expect(write).toBeGreaterThan(checks)
  expect(publish.steps[checks].with.script).toContain("assertArtifacts")
  expect(publish.steps[write].with.script).toContain("getCommit")
  expect(workflow.jobs["build-tauri"].needs).toEqual(["create-release", "check-source"])
  expect(workflow.jobs["check-source"].uses).toBe("./.github/workflows/ci.yml")
  expect(workflow.jobs["check-source"].with.source_commit).toBe(
    "${{ needs.create-release.outputs.commit }}"
  )
  expect(publish.if).toContain("needs.check-source.result == 'success'")
  const ciWorkflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as any
  expect(ciWorkflow.on.workflow_call.inputs.source_commit.required).toBe(true)
  for (const job of Object.values(ciWorkflow.jobs) as any[]) {
    expect(job.steps.find((step: any) => step.uses === "actions/checkout@v7").with.ref)
      .toBe("${{ inputs.source_commit || github.sha }}")
  }
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

test("current versioned macOS archives retain all seven cryptographic installer checks", async () => {
  const f = fixture("0.5.3")
  expect(
    await assertArtifacts(f.github, repo, "v0.5.3", 99, key, f.download)
  ).toBe(7)
  expect(f.downloaded).toContain("Hibiki_0.5.3_aarch64.app.tar.gz")
  expect(f.downloaded).toContain("Hibiki_0.5.3_x64.app.tar.gz")
  for (const version of ["0.5.1", "0.5.2", "0.5.4"]) {
    const mismatched = fixture("0.5.3")
    mismatched.manifest.platforms["darwin-aarch64-app"].url =
      mismatched.manifest.platforms["darwin-aarch64-app"].url.replace(
        "Hibiki_0.5.3_",
        `Hibiki_${version}_`
      )
    expect(() =>
      artifactPlan(mismatched.manifest, mismatched.release, repo, "v0.5.3")
    ).toThrow("Wrong artifact")
  }
})

test("unversioned macOS archives are retained only for the verified legacy v0.5.1 format", async () => {
  const legacy = fixture("0.5.1", true)
  expect(
    await assertArtifacts(
      legacy.github,
      repo,
      "v0.5.1",
      99,
      key,
      legacy.download
    )
  ).toBe(7)
  for (const version of ["0.5.2", "0.5.3"]) {
    const obsolete = fixture(version, true)
    expect(() =>
      artifactPlan(obsolete.manifest, obsolete.release, repo, `v${version}`)
    ).toThrow("Wrong artifact")
  }
})

test("actual Tauri action v1 v0.5.2 matrix metadata maps to all seven installers", () => {
  const current = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/releases/tauri-action-v1-v0.5.2.json",
        import.meta.url
      ),
      "utf8"
    )
  )
  const plan = artifactPlan(
    current.manifest,
    current.release,
    current.repo,
    "v0.5.2"
  )
  expect(plan).toHaveLength(7)
  expect(plan.map((entry: any) => entry.artifact.name).sort()).toEqual(
    [
      "Hibiki_0.5.2_aarch64.app.tar.gz",
      "Hibiki_0.5.2_x64.app.tar.gz",
      "Hibiki_0.5.2_amd64.AppImage",
      "Hibiki_0.5.2_amd64.deb",
      "Hibiki-0.5.2-1.x86_64.rpm",
      "Hibiki_0.5.2_x64_en-US.msi",
      "Hibiki_0.5.2_x64-setup.exe",
    ].sort()
  )
})

test("GitHub API updater URLs are bound to the exact release's signed installer IDs", async () => {
  const f = fixture("0.5.3")
  for (const entry of Object.values(f.manifest.platforms)) {
    const name = entry.url.split("/").at(-1)
    const asset = f.release.assets.find((asset) => asset.name === name)!
    entry.url = `https://api.github.com/repos/owner/repo/releases/assets/${asset.id}`
  }
  f.update()
  expect(
    await assertArtifacts(f.github, repo, "v0.5.3", 99, key, f.download)
  ).toBe(7)
  for (const url of [
    "https://api.github.com/repos/another/repo/releases/assets/3",
    "https://api.github.com/repos/owner/another/releases/assets/3",
    "https://api.github.com/repos/owner/repo/releases/assets/999999",
    "https://api.github.com/repos/owner/repo/releases/assets/1", // DMG, not updater archive
    "https://api.github.com/repos/owner/repo/releases/assets/03",
    "https://api.github.com/repos/owner/repo/releases/assets/3?download=1",
    "https://api.github.com:8443/repos/owner/repo/releases/assets/3",
    `https://api.github.com/repos/owner/repo/releases/assets/${f.release.assets.find((asset) => asset.name === "Hibiki_0.5.3_x64.app.tar.gz")!.id}`,
  ]) {
    const bad = structuredClone(f.manifest)
    bad.platforms["darwin-aarch64-app"].url = url
    expect(() => artifactPlan(bad, f.release, repo, "v0.5.3")).toThrow()
  }
})

test("v0.6 verifies nine signed artifacts without adding fake DMG updater targets", async () => {
  const f = fixture("0.6.0")
  expect(
    await assertArtifacts(f.github, repo, "v0.6.0", 99, key, f.download)
  ).toBe(9)
  expect(f.downloaded.filter((name) => name.endsWith(".dmg"))).toHaveLength(2)
  expect(
    Object.keys(f.manifest.platforms).some((name) => name.includes("dmg"))
  ).toBe(false)
})
test("modern DMGs reject missing companions, one-byte images and tampered complete bytes", async () => {
  const missing = fixture("0.6.0")
  missing.release.assets = missing.release.assets.filter(
    (asset) => asset.name !== "Hibiki_0.6.0_x64.dmg.sig"
  )
  await expect(
    assertArtifacts(missing.github, repo, "v0.6.0", 99, key, missing.download)
  ).rejects.toThrow("Missing or incomplete")
  const short = fixture("0.6.0")
  short.release.assets.find(
    (asset) => asset.name === "Hibiki_0.6.0_x64.dmg"
  ).size = 1
  expect(() =>
    artifactPlan(short.manifest, short.release, repo, "v0.6.0")
  ).toThrow("DMG is too small")
  const tampered = fixture("0.6.0")
  const image = tampered.release.assets.find(
    (asset) => asset.name === "Hibiki_0.6.0_x64.dmg"
  )
  tampered.bodies.set(image.id, Buffer.alloc(image.size, 9))
  await expect(
    assertArtifacts(tampered.github, repo, "v0.6.0", 99, key, tampered.download)
  ).rejects.toThrow("Invalid updater signature")
})
test("tampered DMG signature companion blocks publication", async () => {
  const f = fixture("0.6.0"),
    companion = f.release.assets.find(
      (asset) => asset.name === "Hibiki_0.6.0_x64.dmg.sig"
    )
  const bytes = Buffer.from(f.bodies.get(companion.id)!)
  bytes[20] = bytes[20] === 65 ? 66 : 65
  f.bodies.set(companion.id, bytes)
  await expect(
    assertArtifacts(f.github, repo, "v0.6.0", 99, key, f.download)
  ).rejects.toThrow()
})

test("modern signatures bind signed version for all archives and exact DMG filename", async () => {
  for (const name of [
    "Hibiki_0.6.0_x64.dmg",
    "Hibiki_0.6.0_aarch64.app.tar.gz",
  ]) {
    for (const comment of [
      `timestamp:1\tfile:${name}`,
      `timestamp:1\tfile:${name}\tversion:0.5.4`,
      `timestamp:1\tfile:${name}\tversion:0.6.0\tversion:0.6.0`,
      `timestamp:bad\tfile:${name}\tversion:0.6.0`,
      `timestamp:1\tfile:\tversion:0.6.0`,
      `timestamp:1\tfile:${name}\tversion:0.6.0\tmalformed`,
    ]) {
      const f = fixture("0.6.0"),
        asset = f.release.assets.find((asset) => asset.name === name),
        companion = f.release.assets.find(
          (asset) => asset.name === name + ".sig"
        )
      const encoded = signed(f.bodies.get(asset.id)!, comment)
      f.bodies.set(companion.id, Buffer.from(encoded))
      companion.size = Buffer.byteLength(encoded)
      for (const entry of Object.values(f.manifest.platforms) as any[])
        if (entry.url.endsWith(name)) entry.signature = encoded
      f.update()
      await expect(
        assertArtifacts(f.github, repo, "v0.6.0", 99, key, f.download)
      ).rejects.toThrow()
    }
  }
  const f = fixture("0.6.0"),
    asset = f.release.assets.find(
      (asset) => asset.name === "Hibiki_0.6.0_x64.dmg"
    ),
    companion = f.release.assets.find(
      (candidate) => candidate.name === asset.name + ".sig"
    )
  const wrong = signed(
    f.bodies.get(asset.id)!,
    "timestamp:1\tfile:Other.dmg\tversion:0.6.0"
  )
  f.bodies.set(companion.id, Buffer.from(wrong))
  companion.size = Buffer.byteLength(wrong)
  await expect(
    assertArtifacts(f.github, repo, "v0.6.0", 99, key, f.download)
  ).rejects.toThrow("filename differs")
})
test("macOS workflow validates DMG before signing with version and environment-only key", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8"
    )
  ) as any
  const steps = workflow.jobs["build-tauri"].steps
  const signing = steps.find(
    (step: any) => step.name === "Verify and sign macOS disk image"
  )
  expect(signing.run.indexOf("hdiutil verify")).toBeLessThan(
    signing.run.indexOf("tauri signer sign")
  )
  expect(signing.run).toContain('--app-version "$VERSION"')
  expect(signing.run).not.toContain("--private-key")
  expect(signing.env.TAURI_SIGNING_PRIVATE_KEY).toBe(
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
  )
  expect(
    steps.find(
      (step: any) => step.name === "Upload verified macOS disk image signature"
    ).with.script
  ).toContain("uploadDmgSignature")
  expect(
    JSON.parse(
      readFileSync(
        new URL("../src-tauri/tauri.conf.json", import.meta.url),
        "utf8"
      )
    ).plugins.updater.requireSignedVersion
  ).toBe(true)
})
