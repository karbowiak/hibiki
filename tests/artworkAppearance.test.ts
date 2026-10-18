import { expect, test } from "bun:test"
import { resolve } from "node:path"
async function isolated(body: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
import assert from "node:assert/strict";
const values=new Map();let blockedRead=false,blockedWrite=false;
const { installLocalPreferenceBackend } = await import("./tests/helpers/localPreferenceBackend");
installLocalPreferenceBackend(values, { canRead: () => !blockedRead, canWrite: () => !blockedWrite });
const settle=async()=>{for(let i=0;i<32;i++)await Promise.resolve()};
${body}
`,
    ],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
}
const imports = `const {useArtworkAppearanceStore:store}=await import("./src/stores/artworkAppearanceStore");const {localPreferencePersistence:persistence}=await import("./src/stores/localPreferenceStorage");`
test("background defaults recover blocked storage and apply latest explicit session choices", async () =>
  isolated(`
values.set("plex-background-artwork","0");values.set("plex-interface-opacity","0.92");blockedRead=true;
${imports}
assert.equal(store.getState().backgroundArtworkEnabled,true);assert.equal(store.getState().interfaceOpacity,.76);assert.equal(store.getState().artworkColorsEnabled,true);
store.getState().setBackgroundArtworkEnabled(false);store.getState().setInterfaceOpacity(.55);await settle();assert.equal(store.getState().interfaceOpacity,.55);assert.equal(values.get("plex-interface-opacity"),"0.92");
blockedRead=false;await persistence.retry();await persistence.flushForShutdown();assert.equal(store.getState().backgroundArtworkEnabled,false);assert.equal(store.getState().interfaceOpacity,.55);assert.equal(values.get("plex-background-artwork"),"0");assert.equal(values.get("plex-interface-opacity"),"0.55");
`))
test("failed background/opacity writes are queued while invalid opacity never reaches CSS consumers", async () =>
  isolated(`
${imports}
await settle();blockedWrite=true;store.getState().setBackgroundArtworkEnabled(false);store.getState().setInterfaceOpacity(.63);await persistence.flush();assert.equal(store.getState().backgroundArtworkEnabled,false);assert.equal(store.getState().interfaceOpacity,.63);assert(persistence.snapshot().some(issue=>issue.key==="plex-interface-opacity"&&issue.hasPendingChanges));
blockedWrite=false;await persistence.retry();assert.equal(values.get("plex-interface-opacity"),"0.63");assert.equal(values.get("plex-background-artwork"),"0");
for(const invalid of [NaN,Infinity,-Infinity]){store.getState().setInterfaceOpacity(invalid);assert.equal(store.getState().interfaceOpacity,.76)}store.getState().setInterfaceOpacity(-1);assert.equal(store.getState().interfaceOpacity,.45);store.getState().setInterfaceOpacity(20);assert.equal(store.getState().interfaceOpacity,1);
assert.equal(store.getState().artworkColorsEnabled,true,"background preference must not change artwork button preference");
`))
test("unknown background and malformed opacity values stay untouched with safe defaults", async () =>
  isolated(`
values.set("plex-background-artwork","future");values.set("plex-interface-opacity","NaN");
${imports}
await settle();assert.equal(store.getState().backgroundArtworkEnabled,true);assert.equal(store.getState().interfaceOpacity,.76);await persistence.flush();assert.equal(values.get("plex-background-artwork"),"future");assert.equal(values.get("plex-interface-opacity"),"NaN");
`))
