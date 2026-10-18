import { expect, test } from "bun:test"
import { resolve } from "node:path"
async function isolated(body: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import assert from "node:assert/strict";
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("", {url:"https://hibiki.test"});
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    let light = true; const listeners = new Set();
    window.matchMedia = () => ({get matches(){return light},addEventListener(event, fn){listeners.add(fn)},removeEventListener(event,fn){listeners.delete(fn)}});
    const values = new Map(); let readBlocked=false, writeBlocked=false;
    const { installLocalPreferenceBackend } = await import("./tests/helpers/localPreferenceBackend");
    installLocalPreferenceBackend(values, { canRead: () => !readBlocked, canWrite: () => !writeBlocked });
    const settle=async()=>{for(let i=0;i<32;i++)await Promise.resolve()};
    ${body}
    dom.window.close();
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
const imports = `
const font=await import("./src/stores/fontStore");
const theme=await import("./src/stores/themeStore");
const {useCardSizeStore:size}=await import("./src/stores/cardSizeStore");
const {localPreferencePersistence:persistence}=await import("./src/stores/localPreferenceStorage");
`
test("blocked startup keeps appearance defaults and recovery merges newer session choices", async () =>
  isolated(`
values.set("plex-font","inter");values.set("plex-theme","light");values.set("plex-card-size","200");readBlocked=true;
${imports}
assert.equal(font.getFont().name,"circular");assert.equal(theme.getTheme(),"dark");assert.equal(size.getState().cardSize,160);
font.setFont("system");theme.setTheme("system");size.getState().setCardSize(240);await settle();
assert.equal(document.documentElement.getAttribute("data-theme"),"light");assert.equal(document.documentElement.style.getPropertyValue("--card-size"),"240px");
assert.equal(values.get("plex-font"),"inter");assert.equal(persistence.snapshot().filter(issue=>issue.hasPendingChanges).length,3);
readBlocked=false;await persistence.retry();await persistence.flushForShutdown();
assert.equal(font.getFont().name,"system");assert.equal(theme.getTheme(),"system");assert.equal(size.getState().cardSize,240);
assert.equal(values.get("plex-font"),"system");assert.equal(values.get("plex-theme"),"system");assert.equal(values.get("plex-card-size"),"240");
`))
test("blocked writes still update appearance and notify subscribers then retry legacy scalar formats", async () =>
  isolated(`
${imports}
await settle();writeBlocked=true;const fonts=[],themes=[];
font.subscribeFont(value=>fonts.push(value.name));theme.subscribeTheme(value=>themes.push(value));
font.setFont("inter");theme.setTheme("light");size.getState().setCardSize(210);await persistence.flush();
assert.equal(font.getFont().name,"inter");assert.equal(theme.getTheme(),"light");assert.equal(size.getState().cardSize,210);
assert.deepEqual(fonts,["inter"]);assert.deepEqual(themes,["light"]);assert.match(document.documentElement.style.getPropertyValue("--font-family"),/Inter/);
assert.equal(document.documentElement.style.getPropertyValue("--card-size"),"210px");assert.equal(persistence.snapshot().length,3);
writeBlocked=false;await persistence.retry();assert.equal(values.get("plex-font"),"inter");assert.equal(values.get("plex-theme"),"light");assert.equal(values.get("plex-card-size"),"210");
`))
test("invalid saved values remain untouched and invalid setters never emit unknown fonts or NaN CSS", async () =>
  isolated(`
values.set("plex-font","future-font");values.set("plex-theme","future-theme");values.set("plex-card-size","160invalid");
${imports}
await settle();assert.equal(font.getFont().name,"circular");assert.equal(theme.getTheme(),"dark");assert.equal(size.getState().cardSize,160);
assert.equal(values.get("plex-font"),"future-font");assert.equal(values.get("plex-theme"),"future-theme");assert.equal(values.get("plex-card-size"),"160invalid");
font.setFont("unknown");theme.setTheme("unknown");for(const invalid of [NaN,Infinity,-Infinity]){size.getState().setCardSize(invalid);assert.equal(size.getState().cardSize,160);assert.equal(document.documentElement.style.getPropertyValue("--card-size"),"160px")}
size.getState().setCardSize(1000);assert.equal(size.getState().cardSize,280);size.getState().setCardSize(-5);assert.equal(size.getState().cardSize,140);size.getState().setCardSize(179.6);assert.equal(size.getState().cardSize,180);
await persistence.flush();assert.equal(values.get("plex-font"),"future-font");assert.equal(values.get("plex-theme"),"future-theme");assert.equal(values.get("plex-card-size"),"160invalid");
`))
