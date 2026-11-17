import test from "node:test";
import assert from "node:assert/strict";

const DASH = "chrome-extension://abc/index.html";

function setup(tabs, pingResult) {
  const reloaded = [];
  const session = {};
  globalThis.chrome = {
    runtime: { getURL: (p) => `chrome-extension://abc/${p}` },
    alarms: { onAlarm: { addListener() {} }, get: async () => ({}), create: async () => {} },
    storage: {
      session: {
        get: async (k) => ({ [k]: session[k] }),
        set: async (o) => Object.assign(session, o)
      }
    },
    tabs: {
      query: async () => tabs,
      sendMessage: async (id) => { if (!pingResult(id)) throw new Error("Could not establish connection."); return { ok: true }; },
      reload: async (id) => { reloaded.push(id); }
    }
  };
  return reloaded;
}

setup([], () => true);
const { checkDashboardTabs } = await import("../src/watchdog.js");

test("watchdog reloads a dashboard tab that stops answering after 2 silent pings, leaves healthy/other tabs alone", async () => {
  const tabs = [
    { id: 1, url: DASH, status: "complete" },
    { id: 2, url: `${DASH}?x=1#y`, status: "complete" },
    { id: 3, url: "https://www.futbin.com/market", status: "complete" },
    { id: 4, url: DASH, status: "loading" },
    { id: 5, url: DASH, status: "complete", discarded: true }
  ];
  const reloaded = setup(tabs, (id) => id === 1);
  await checkDashboardTabs();
  assert.deepEqual(reloaded, [], "first silent ping only counts");
  await checkDashboardTabs();
  assert.deepEqual(reloaded, [2], "second silent ping reloads only the unresponsive dashboard tab");
  await checkDashboardTabs();
  assert.deepEqual(reloaded, [2], "counter reset after reload");
});

test("a tab that answers in between resets its failure count", async () => {
  let alive = false;
  const reloaded = setup([{ id: 7, url: DASH, status: "complete" }], () => alive);
  await checkDashboardTabs();
  alive = true;
  await checkDashboardTabs();
  alive = false;
  await checkDashboardTabs();
  assert.deepEqual(reloaded, []);
});
