import { expect, test } from "bun:test"
import { SqliteKeyValue, memoryTransport, localStore, type ClientStore } from "../src/storage/keyValue"

test("frontend and worker updates use one revisioned record without losing either edit", async () => {
  const transport = memoryTransport(), frontend = new SqliteKeyValue(transport), worker = new SqliteKeyValue(transport)
  await frontend.set("journal", { occurrences: [], count: 0 })
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? worker : frontend).update<{ occurrences: number[]; count: number }>("journal", old => ({ occurrences: [...old!.occurrences, index], count: old!.count + 1 }))))
  const saved = await frontend.get<{ occurrences: number[]; count: number }>("journal")
  expect(saved?.count).toBe(20)
  expect(new Set(saved?.occurrences).size).toBe(20)
})
test("a rejected write preserves the journal and stale writers cannot resurrect a deletion", async () => {
  const transport = memoryTransport(), store = new SqliteKeyValue(transport)
  const journal: ClientStore = { namespace: "playlist-sync" }
  await store.set("playlist", { write: { id: "receipt", afterIds: ["a", "b"], state: "unknown" } }, journal)
  const write = transport.write
  transport.write = async () => { throw Error("disk unavailable") }
  await expect(store.set("playlist", { write: undefined }, journal)).rejects.toThrow("disk unavailable")
  expect(await store.get("playlist", journal)).toEqual({ write: { id: "receipt", afterIds: ["a", "b"], state: "unknown" } })
  transport.write = write
  const stale = await transport.read("playlist-sync", "playlist")
  await store.del("playlist", journal)
  expect(await transport.write("playlist-sync", "playlist", '{"old":true}', stale.revision)).toBe(false)
  expect(await transport.write("playlist-sync", "playlist", '{"old":true}', 0)).toBe(false)
  expect(await store.get("playlist", journal)).toBeUndefined()
})
test("local scalar preferences retain their exact representation in SQLite records", async () => {
  const transport = memoryTransport(), store = new SqliteKeyValue(transport)
  for (const [key, value] of [['pinned', '1'], ['columns', '["artist"]'], ['future', 'malformed']]) await store.set(key, value, localStore)
  expect(await store.get("pinned", localStore)).toBe("1")
  expect(await store.get("columns", localStore)).toBe('["artist"]')
  expect(await store.get("future", localStore)).toBe("malformed")
})

test("desktop startup loads SQLite directly without accessing browser storage", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { mock } from "bun:test";
    const calls = [];
    for (const key of ["indexedDB", "localStorage"]) Object.defineProperty(globalThis, key, { get() { throw Error("Browser storage accessed"); } });
    mock.module("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: async (command) => {
      calls.push(command);
      if (command === "client_storage_local") return [["pinned", JSON.stringify("1")]];
      throw Error("Unexpected command " + command);
    }}));
    const { initializeClientStorage, sqliteLocalStorage } = await import("./src/storage/clientStorage");
    await initializeClientStorage();
    if (sqliteLocalStorage.getItem("pinned") !== "1" || calls.join() !== "client_storage_local") throw Error("Wrong startup source");
  `], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
})
