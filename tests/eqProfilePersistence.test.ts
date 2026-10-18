import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("SQLite EQ profiles retain manual gain and later Auto gain opt-ins", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", `
    import assert from "node:assert/strict";
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("", { url: "https://hibiki.example.test" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const { get: readPreference, set: writePreference } = await import("./src/storage/clientStorage");
    const { localStore } = await import("./src/storage/keyValue");
    const auto = { gains: [4, 3, 2, 1, 0, 0, 0, 0, 0, 0], enabled: true, autoPostgain: false, postgainDb: 0 };
    const manual = { ...auto, autoPostgain: false, postgainDb: 2.5 };
    const output = { ...auto, name: "USB DAC", automatic: true, correctionId: "correction", correctionEnabled: true };
    const old = { ...auto, deviceProfiles: { Headphones: auto, Manual: manual }, outputProfiles: { dac: output, manual: { ...output, ...manual } }, corrections: { correction: { label: "Keep correction" } } };
    await writePreference("plex-eq-v1", JSON.stringify({ state: old, version: 1 }), localStore);
    const { useEqStore: store } = await import("./src/stores/eqStore");
    const { localPreferencePersistence } = await import("./src/stores/localPreferenceStorage");
    await store.persist.rehydrate();
    await localPreferencePersistence.flushForShutdown();
    const { engine } = await import("./src/audio/RustAudioEngine");
    engine.configureEq = async settings => settings.postgainDb ?? -6;
    const current = store.getState();
    for (const profile of [current, current.deviceProfiles.Headphones, current.outputProfiles.dac]) {
      assert.equal(profile.autoPostgain, false);
      assert.equal(profile.postgainDb, 0);
      assert.deepEqual(profile.gains, auto.gains);
      assert.equal(profile.enabled, true);
    }
    assert.equal(current.deviceProfiles.Manual.postgainDb, 2.5);
    assert.equal(current.outputProfiles.manual.postgainDb, 2.5);
    assert.equal(current.outputProfiles.dac.correctionId, "correction");
    assert.deepEqual(current.corrections, old.corrections);
    assert.equal(JSON.parse(await readPreference("plex-eq-v1", localStore)).version, 1);
    current.setCurrentDevice("Headphones");
    assert.equal(store.getState().autoPostgain, false);
    store.getState().setAutoPostgain(true);
    store.getState().saveProfileForDevice("Headphones");
    await localPreferencePersistence.flushForShutdown();
    const optedIn = JSON.parse(await readPreference("plex-eq-v1", localStore));
    assert.equal(optedIn.version, 1);
    store.persist.setOptions({ storage: { getItem: () => optedIn, setItem: () => {}, removeItem: () => {} } });
    store.setState({ autoPostgain: false, postgainDb: 0, deviceProfiles: {} });
    await store.persist.rehydrate();
    assert.equal(store.getState().autoPostgain, true);
    assert.equal(store.getState().deviceProfiles.Headphones.autoPostgain, true);
    dom.window.close();
    `],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output: output + errors }).toEqual({ status: 0, output: "" })
})

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
    const { get: readPreference, set: writePreference } = await import("./src/storage/clientStorage");
    const { localStore } = await import("./src/storage/keyValue");
    const { useEqStore: store } = await import("./src/stores/eqStore");
    const { localPreferencePersistence } = await import("./src/stores/localPreferenceStorage");
    await store.persist.rehydrate();
    await localPreferencePersistence.flushForShutdown();
    const { engine } = await import("./src/audio/RustAudioEngine");
    engine.configureEq = async settings => settings.postgainDb ?? 0;
    const profile = { gains: [4, 3, 2, 1, 0, 0, 0, 0, 0, 0], enabled: true, autoPostgain: true, postgainDb: 4 };
    store.setState({ deviceProfiles: { Headphones: profile, Speakers: profile } });
    store.getState().setCurrentDevice("Headphones");
    store.getState().deleteProfileForDevice("Headphones");
    await localPreferencePersistence.flushForShutdown();
    const saved = JSON.parse(await readPreference("plex-eq-v1", localStore));
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
