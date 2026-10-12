import { readFile, mkdir, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { execFileSync } from "node:child_process"
export function renderLinuxMetadata(
  template: string,
  version: string,
  date: string,
  development = false
): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw Error("Invalid Linux package version")
  const parsed = new Date(`${date}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw Error("Invalid Linux package release date")
  const result = template
    .replaceAll("@VERSION@", version)
    .replaceAll("@DATE@", date)
    .replaceAll("@RELEASE_TYPE@", development ? "development" : "stable")
  if (/@[A-Z_]+@/.test(result))
    throw Error("Unresolved Linux metadata placeholder")
  return result
}
async function main() {
  if (process.env.TAURI_ENV_PLATFORM !== "linux") return
  const root = resolve(import.meta.dir, "..")
  const config = JSON.parse(
    await readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8")
  )
  const epoch = process.env.SOURCE_DATE_EPOCH
  const date =
    epoch === undefined
      ? execFileSync("git", ["log", "-1", "--format=%cs"], {
          cwd: root,
          encoding: "utf8",
        }).trim()
      : /^\d+$/.test(epoch)
        ? new Date(Number(epoch) * 1000).toISOString().slice(0, 10)
        : ""
  const template = await readFile(
    resolve(root, "src-tauri/linux/app.hibiki.client.metainfo.xml.in"),
    "utf8"
  )
  const output = resolve(
    root,
    ".tmp/linux-metadata/app.hibiki.client.metainfo.xml"
  )
  await mkdir(dirname(output), { recursive: true })
  await writeFile(
    output,
    renderLinuxMetadata(
      template,
      config.version,
      date,
      process.env.TAURI_ENV_DEBUG === "true"
    )
  )
  console.log("Prepared Linux AppStream metadata for Hibiki " + config.version)
}
if (import.meta.main) await main()
