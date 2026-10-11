import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("cleared EQ profiles survive hydration and explicit Save re-enables profile persistence", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import assert from "node:assert/strict";
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("", { url: "https://hibiki.example.test" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    const { useEqStore: store } = await import("./src/stores/eqStore");
    const { engine } = await import("./src/audio/RustAudioEngine");
    engine.configureEq = async settings => settings.postgainDb ?? 0;
    const profile = { gains: [4, 3, 2, 1, 0, 0, 0, 0, 0, 0], enabled: true, autoPostgain: true, postgainDb: 4 };
    store.setState({ deviceProfiles: { Headphones: profile, Speakers: profile } });
    store.getState().setCurrentDevice("Headphones");
    store.getState().deleteProfileForDevice("Headphones");
    await Promise.resolve(); await Promise.resolve();
    const saved = JSON.parse(localStorage.getItem("plex-eq-v1"));
    assert.deepEqual(saved.state.clearedDeviceProfiles, ["Headphones"]);
    assert.equal(Object.hasOwn(saved.state.deviceProfiles, "Headphones"), false);
    store.persist.setOptions({ storage: { getItem: () => saved, setItem: () => {}, removeItem: () => {} } });
    store.setState({ currentDevice: "", deviceProfiles: {}, clearedDeviceProfiles: [] });
    await store.persist.rehydrate();
    store.getState().setCurrentDevice("Headphones");
    store.getState().setCurrentDevice("Speakers");
    assert.equal(Object.hasOwn(store.getState().deviceProfiles, "Headphones"), false);
    assert.deepEqual(store.getState().deviceProfiles.Speakers.gains, profile.gains);
    store.getState().setCurrentDevice("Headphones");
    store.getState().saveProfileForDevice("Headphones");
    assert.deepEqual(store.getState().clearedDeviceProfiles, []);
    assert.equal(Object.hasOwn(store.getState().deviceProfiles, "Headphones"), true);
    dom.window.close();
    console.log("EQ profile persistence verified");
  `,
    ],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
  expect(stdout.trim()).toBe("EQ profile persistence verified")
})
