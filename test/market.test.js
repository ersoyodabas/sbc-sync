import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DOMParser } from "linkedom";
import { marketPayload, readMarket } from "../src/modules/market/parser.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const parse = (html) => readMarket(new DOMParser().parseFromString(html, "text/html"));

test("Market reads period, direction, platform, rank and the card values", () => {
  const market = parse(read("./fixtures/futbin-market.html"));
  assert.equal(market.ready, true);
  assert.equal(market.count, 5);
  assert.deepEqual(market.players.map((p) => [p.period, p.direction, p.platform, p.futbinPlayerId, p.rank]), [
    ["24h", "gain", "ps", 944, 1], ["24h", "gain", "ps", 1091, 2], ["24h", "gain", "pc", 756, 1], ["24h", "loss", "ps", 1082, 1], ["4h", "gain", "ps", 23412, 1]
  ]);
  assert.deepEqual(plain(market.players[0]), {
    period: "24h", direction: "gain", platform: "ps", futbinPlayerId: 944, rank: 1, price: 2600, priceText: "2.6K",
    itemScore: 2100, changePercent: 133.71, rating: 81, position: "CM"
  });
});

test("Market expands K/M amounts and thousands separators, fallers get a negative change, index movers are ignored", () => {
  const { players } = parse(read("./fixtures/futbin-market.html"));
  const byId = (id) => players.find((p) => p.futbinPlayerId === id);
  assert.equal(byId(1091).itemScore, 830);
  assert.equal(byId(756).price, 1120000);
  assert.equal(byId(756).itemScore, 1234);
  assert.equal(byId(1082).changePercent, -80.69);
  assert.equal(byId(23412).price, 3100000);
  assert.equal(byId(23412).itemScore, 16500);
  assert.equal(byId(1058), undefined);
});

test("Market payload is snake_case and carries no names or images", () => {
  const market = parse(read("./fixtures/futbin-market.html"));
  const payload = plain(marketPayload(market, { sourceUrl: "https://www.futbin.com/market", capturedAt: "2026-11-11T10:00:00.000Z" }));
  assert.equal(payload.source, "futbin_market");
  assert.equal(payload.captured_at, "2026-11-11T10:00:00.000Z");
  assert.deepEqual(payload.players[0], {
    period: "24h", direction: "gain", platform: "ps", futbin_player_id: 944, rank: 1, price: 2600, price_text: "2.6K",
    item_score: 2100, change_percent: 133.71, rating: 81, position: "CM"
  });
  assert.deepEqual(Object.keys(payload).sort(), ["captured_at", "players", "source", "source_url"]);
  for (const player of payload.players) assert.deepEqual(Object.keys(player).sort(), Object.keys(payload.players[0]).sort());
});

test("Market page without cards is not ready and a Cloudflare check page is flagged", () => {
  assert.deepEqual([parse("<html><head><title>Hi</title></head><body></body></html>").ready, parse("<html><head><title>Hi</title></head><body></body></html>").challenge], [false, false]);
  const check = parse("<html><head><title>Just a moment...</title></head><body></body></html>");
  assert.deepEqual([check.ready, check.challenge], [false, true]);
});

test("Market run opens the page, reads it, POSTs to sync/futbin-market and reports the central round", () => {
  const manifestEntry = new URL("../src/background.js", import.meta.url).href;
  const parserEntry = new URL("../src/modules/market/parser.js", import.meta.url).href;
  const linkedom = new URL("../node_modules/linkedom/esm/index.js", import.meta.url).href;
  const html = JSON.stringify(read("./fixtures/futbin-market.html"));
  const script = `
    import assert from "node:assert/strict";
    import { DOMParser } from ${JSON.stringify(linkedom)};
    import { readMarket } from ${JSON.stringify(parserEntry)};
    const event = { addListener() {} };
    const store = {};
    const closed = [];
    const posts = [];
    const doc = new DOMParser().parseFromString(${html}, "text/html");
    globalThis.chrome = {
      runtime: { onInstalled: event, onStartup: event, onMessage: event, onConnect: event, getURL: path => 'chrome-extension://test/' + path, sendMessage: async () => {} },
      storage: { onChanged: event, local: {
        get: async (key) => typeof key === 'string' ? { [key]: store[key] } : {},
        set: async (values) => Object.assign(store, JSON.parse(JSON.stringify(values)))
      } },
      alarms: { onAlarm: event },
      tabs: {
        onUpdated: { addListener() {}, removeListener() {} }, onRemoved: event,
        create: async ({ url }) => { assert.equal(url, 'https://www.futbin.com/market'); return { id: 7, status: 'complete' }; },
        get: async () => ({ id: 7, status: 'complete' }),
        remove: async (id) => { closed.push(id); }
      },
      scripting: { executeScript: async ({ func }) => [{ result: func === readMarket ? readMarket(doc) : null }] },
      action: { onClicked: event }
    };
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('chrome-extension://')) return new Response('API_BASE_URL=https://sync.invalid/api/');
      posts.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ result: true, message: 'Market: 5 kayit kaydedildi.', data: { saved: 4, deleted: 2, skipped: 1, unmatched_futbin_player_ids: [1091], errors: [] } }));
    };
    const finished = [];
    await import(${JSON.stringify(manifestEntry)});
    await globalThis.FutbinSyncApiConfig.ready;
    globalThis.FutbinSyncCentralOrchestrator = { moduleRoundFinished: async (message) => { finished.push(message); } };
    const control = globalThis.FutbinSyncModuleControls.market;
    assert.equal((await control.start({ centralManaged: true, centralRunId: 3 })).ok, true);
    for (let i = 0; i < 100 && !finished.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(posts.length, 1, JSON.stringify((await control.getSnapshot()).state));
    assert.equal(posts[0].url, globalThis.FutbinSyncApiConfig.defaultBaseUrl() + 'sync/futbin-market');
    assert.equal(posts[0].body.players.length, 5);
    assert.equal(posts[0].body.players[0].item_score, 2100);
    assert.deepEqual(finished.map(({ module, runId, ok }) => ({ module, runId, ok })), [{ module: 'market', runId: 3, ok: true }]);
    assert.deepEqual(closed, [7]);
    const { state } = await control.getSnapshot();
    assert.deepEqual([state.running, state.parsedPlayers, state.savedPlayers, state.skippedPlayers, state.unmatchedPlayers, state.replacedPlayers], [false, 5, 4, 1, 1, 2]);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 15000, stdio: "pipe" });
});

test("Central sync forces Market every 10 minutes, also market-only, and STOP clears the timer", () => {
  const entry = new URL("../src/background.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const listeners = { message: [], alarm: [] };
    const store = {};
    const alarms = { created: [], cleared: [] };
    const event = (name) => ({ addListener(listener) { if (name) listeners[name].push(listener); } });
    globalThis.chrome = {
      runtime: { onInstalled: event(), onStartup: event(), onMessage: event("message"), onConnect: event(), getURL: path => 'chrome-extension://test/' + path, sendMessage: async () => {} },
      storage: { onChanged: event(), local: {
        get: async (key) => typeof key === 'string' ? { [key]: store[key] } : {},
        set: async (values) => Object.assign(store, JSON.parse(JSON.stringify(values)))
      } },
      alarms: { onAlarm: event("alarm"), create: async (name, info) => { alarms.created.push([name, info]); }, clear: async (name) => { alarms.cleared.push(name); } },
      tabs: { onUpdated: event(), onRemoved: event() }, action: { onClicked: event() }
    };
    globalThis.fetch = async () => new Response('API_BASE_URL=https://sync.invalid/api/');
    await import(${JSON.stringify(entry)});
    await globalThis.FutbinSyncApiConfig.ready;
    const calls = [];
    for (const name of ['latest', 'pricerange', 'important', 'market']) {
      globalThis.FutbinSyncModuleControls[name] = {
        getSnapshot: async () => ({ ok: true, state: {} }),
        start: async (options) => { calls.push([name, options]); return { ok: true }; },
        stop: async () => ({ ok: true })
      };
    }
    const send = (message) => new Promise((resolve) => { const handled = listeners.message.filter((listener) => listener({ futbinSyncModule: 'fc-sync', ...message }, {}, resolve) === true); assert.equal(handled.length, 1); });
    const fire = async () => { listeners.alarm.forEach((listener) => listener({ name: 'fc-sync-market-interval' })); await new Promise((resolve) => setTimeout(resolve, 20)); };

    // Everything enabled: round-robin starts with latest, Market runs now and is armed for every 10 minutes.
    await send({ type: 'START_SYNC', enabledModules: ['latest', 'pricerange', 'important', 'market'] });
    assert.deepEqual(calls.map(([name]) => name), ['latest', 'market']);
    assert.equal(calls[1][1].scheduled, true);
    assert.deepEqual(alarms.created.at(-1), ['fc-sync-market-interval', { delayInMinutes: 10, periodInMinutes: 10 }]);
    await fire();
    assert.deepEqual(calls.map(([name]) => name), ['latest', 'market', 'market']);

    // Market switched off: no timer.
    alarms.created.length = 0; calls.length = 0;
    await send({ type: 'START_SYNC', enabledModules: ['latest'] });
    assert.deepEqual(calls.map(([name]) => name), ['latest']);
    assert.equal(alarms.created.length, 0);
    await fire();
    assert.deepEqual(calls.map(([name]) => name), ['latest']);

    // Market only: no round-robin module, just the timer.
    calls.length = 0;
    await send({ type: 'START_SYNC', enabledModules: ['market'] });
    assert.deepEqual(calls.map(([name]) => name), ['market']);
    assert.equal(store.fcSyncOrchestratorState.activeModule, null);
    assert.equal(alarms.created.length, 1);

    // STOP: timer cleared, a late tick does nothing.
    alarms.cleared.length = 0; calls.length = 0;
    await send({ type: 'STOP_SYNC' });
    assert.ok(alarms.cleared.includes('fc-sync-market-interval'));
    await fire();
    assert.equal(calls.length, 0);

    // Nothing enabled at all is still refused.
    const refused = await send({ type: 'START_SYNC', enabledModules: ['nothing'] });
    assert.equal(refused.ok, false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 15000, stdio: "pipe" });
});
