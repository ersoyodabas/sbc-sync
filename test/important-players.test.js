import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { DOMParser } from "linkedom";
import * as challenge from "../src/modules/futbin/challenge.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const backgroundSource = read("../src/modules/important/background.js").replace(/^import .*;\n/, "");
const parserSource = read("../src/modules/important/offscreen-parser.js");
const plain = (value) => JSON.parse(JSON.stringify(value));
const quietConsole = { log() {}, warn() {}, error() {}, groupCollapsed() {}, groupEnd() {} };
const origin = "https://www.futbin.com";
const apiBase = "https://sync.invalid/api/";
const assertNoEaFields = (player) => assert.equal(Object.keys(player).some((key) => key.startsWith("ea_")), false);

// Synthetic regression markup for the existing selectors, NOT evidence of EA IDs.
function row(id = 1001, consolePrice = "1.2K", extra = "") {
  return `<tr class="player-row" ${extra}>
    <td class="table-name"><a href="/27/player/${id}/test-player">Test Player Full</a>
      <img class="playercard-s-26-bg" src="/content/fifa27/img/cards/tiny/1_gold.png">
      <img class="playercard-s-base-img" alt="Test Player" src="/content/fifa27/img/players/999999.png">
      <a class="table-player-club" href="/27/players?club=123"><img title="Test Club" src="/clubs/dark/123.png"></a>
      <a class="table-player-league" href="/27/players?league=456"><img title="Test League" src="/league/dark/456.png"></a>
      <a class="table-player-nation" href="/27/players?nation=789"><img title="Test Nation" src="/nation/789.png"></a>
    </td>
    <td class="table-rating"><span class="rating-square">82</span></td>
    <td class="table-pos">CM++ CAM, CDM</td>
    <td class="table-price platform-ps-only">${consolePrice}</td>
    <td class="table-price platform-pc-only">2,500</td>
  </tr>`;
}
function page(rows = row(), totalPages = 1) {
  return `<html><body><table class="players-table">${rows}</table>
    <div class="pagination-buttons-wrapper"><a class="pagination-button" href="/27/players?page=${totalPages}">${totalPages}</a></div>
    </body></html>`;
}

function harness({ fetch, fastDelays = true, defaultApiBaseUrl = apiBase } = {}) {
  const listeners = [];
  const stored = {};
  const timers = new Set();
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onInstalled: event(), onStartup: event(), onConnect: event(),
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => [{}],
      async sendMessage(message) {
        let result;
        for (const listener of listeners) listener(message, {}, (value) => { result = value; });
        return result;
      }
    },
    storage: { local: {
      async get(keys) {
        const selected = typeof keys === "string" ? [keys] : keys;
        return structuredClone(Object.fromEntries(selected.filter((key) => key in stored).map((key) => [key, stored[key]])));
      },
      async set(values) { Object.assign(stored, structuredClone(values)); }
    } },
    alarms: { onAlarm: event(), clear: async () => true, create: async () => {} },
    tabs: { remove: async () => {}, get: async () => { throw new Error("No test tab"); } }
  };
  const parser = vm.createContext({ DOMParser, URL, chrome, console: quietConsole });
  vm.runInContext(parserSource, parser);
  const worker = vm.createContext({
    ...challenge, chrome, URL, DOMException, AbortController, console: quietConsole,
    fetch: fetch || (() => { throw new Error("Unexpected network request"); }),
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, fastDelays && ms <= 5000 ? 0 : ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    FutbinSyncApiConfig: { ready: Promise.resolve(), defaultBaseUrl: () => defaultApiBaseUrl }
  });
  vm.runInContext(backgroundSource, worker);
  return {
    worker, parser, stored, chrome,
    evaluate: (code) => vm.runInContext(code, worker),
    parse: (html = page()) => parser.parseDocument(html, `${origin}/27/players`),
    dispose() { for (const timer of timers) clearTimeout(timer); }
  };
}

test("offscreen message parses existing fields; mapper preserves the complete legacy payload", async () => {
  const h = harness();
  const parsed = await h.chrome.runtime.sendMessage({ type: "PARSE_FUTBIN_HTML", html: page(row(), 6), pageUrl: `${origin}/27/players` });
  assert.equal(parsed.totalPages, 6);
  assert.deepEqual(plain(parsed.errors), []);
  assert.equal(parsed.players.length, 1);
  assert.deepEqual(plain(h.worker.toPayloadPlayer(parsed.players[0])), {
    futbin_club_id: 123, futbin_league_id: 456, futbin_nation_id: 789, futbin_rarity_id: 1,
    name: "Test Player", full_name: "Test Player Full", rating: 82, futbin_player_id: 1001,
    futbin_player_link: `${origin}/27/player/1001/test-player`, url: `${origin}/27/player/1001/test-player`,
    url_img_player: `${origin}/content/fifa27/img/players/999999.png`, price_console: 1200, price_pc: 2500,
    url_img_card: `${origin}/content/fifa27/img/cards/tiny/1_gold.png`,
    url_img_nation: `${origin}/nation/789.png`, url_img_league: `${origin}/league/dark/456.png`, url_img_club: `${origin}/clubs/dark/123.png`,
    position_name: "CM", quality_code: "gold", nation_name: "Test Nation", league_name: "Test League", club_name: "Test Club",
    alternative_positions: "CAM,CDM", active: true,
    futbin_asset_id: 999999
  });
});

test("player-image IDs map to futbin_asset_id while Futbin identity and URL remain unchanged", () => {
  const h = harness();
  const extract = (url) => h.parser.extractPlayerImageId(url);
  assert.equal(extract("https://cdn3.futbin.com/content/fifa27/img/players/83766.png?fm=png&x=1"), 83766);
  assert.equal(extract("https://cdn3.futbin.com/content/fifa27/img/players/278196.png"), 278196);
  assert.equal(extract("https://cdn3.futbin.com/content/fifa27/img/players/81634.png?x=1"), 81634);
  assert.equal(extract(null), null);
  assert.equal(extract("https://cdn3.futbin.com/content/fifa27/img/cards/83766.png"), null);
  assert.equal(extract("https://cdn3.futbin.com/content/fifa27/img/players/player.png"), null);
  assert.equal(extract("https://cdn3.futbin.com/content/fifa27/img/players/0.png"), null);
  assert.equal(extract("not a valid URL: %%%"), null);

  for (const [futbinId, imageId, query] of [[20849, 83766, "?fm=png"], [20909, 278196, ""], [22911, 81634, "?x=1"], [22334, 70780, ""], [13095, 81634, ""], [22911, 81634, ""]]) {
    const html = page(row(futbinId).replace("999999.png", `${imageId}.png${query}`));
    const parsed = h.parse(html).players[0];
    const payload = h.worker.toPayloadPlayer(parsed);
    assert.equal(parsed.extractedPlayerImageId, imageId);
    assert.equal(payload.futbin_asset_id, imageId);
    assert.equal(payload.futbin_player_id, futbinId);
    assert.equal(payload.url_img_player, parsed.playerImageUrl);
    assertNoEaFields(payload);
  }

  for (const imageUrl of ["/content/fifa27/img/players/not-a-number.png", null]) {
    const html = imageUrl
      ? page(row(444).replace("/content/fifa27/img/players/999999.png", imageUrl))
      : page(row(445).replace(/<img class="playercard-s-base-img"[^>]*>/, ""));
    const parsed = h.parse(html).players[0];
    assert.equal(parsed.extractedPlayerImageId, null);
    const payload = h.worker.toPayloadPlayer(parsed);
    assert.equal(payload.futbin_asset_id, null);
    assertNoEaFields(payload);
  }
});

test("captured Futbin FC27 Smith HTML preserves Futbin source metadata", () => {
  const h = harness();
  const html = read("./fixtures/futbin-important-player-smith.html");
  const raw = h.parse(html).players[0];
  assert.equal(raw.futbinPlayerId, 14754);
  assert.equal(raw.fullName, "Bastian Smith");
  assert.equal(raw.futbinClubId, 1938);
  assert.equal(raw.futbinLeagueId, 60);
  assert.equal(raw.futbinNationId, 14);
  assert.equal(raw.futbinRarityId, 0);
  assert.equal(raw.positionName, "GK");
  assert.deepEqual(plain(raw.alternativePositions), []);
  assert.equal(raw.extractedPlayerImageId, 78402);
  assert.equal(raw.futbinCardRevision, "Normal");
  assert.equal(raw.futbinItemScore, 20);
  assert.equal(raw.futbinFoot, "right");
  assert.equal(raw.futbinSkillMoves, 1);
  assert.equal(raw.futbinWeakFoot, 2);
  assert.ok(raw.sourceDataAttributes.some((attribute) => attribute.name === "data-player-hover-location" && attribute.value === "/27/playerhover/14754"));

  const payload = h.worker.toPayloadPlayer(raw);
  assert.equal(payload.futbin_player_id, 14754);
  assert.equal(payload.futbin_club_id, 1938);
  assert.equal(payload.futbin_league_id, 60);
  assert.equal(payload.futbin_rarity_id, 0);
  assert.equal(payload.position_name, "GK");
  assert.equal(payload.futbin_asset_id, 78402);
  assertNoEaFields(payload);
  assert.equal(payload.futbin_card_revision, "Normal");
  assert.equal(payload.futbin_item_score, 20);
  assert.equal(payload.futbin_foot, "right");
  assert.equal(payload.futbin_skill_moves, 1);
  assert.equal(payload.futbin_weak_foot, 2);
});

test("missing player-image ID is null and Futbin HTML data attributes create no EA payload fields", () => {
  const h = harness();
  const raw = h.parse(page(row(1001, "1.2K", 'data-id="111" data-resource-id="222" data-ea-asset-id="333"'))).players[0];
  assert.equal(Object.keys(raw).some((key) => key.startsWith("ea")), false);
  const payload = h.worker.toPayloadPlayer({ ...raw, extractedPlayerImageId: null });
  assert.equal(payload.futbin_asset_id, null);
  assertNoEaFields(payload);
});

test("rarity zero, quality, errors and confirmed-empty parsing remain compatible", () => {
  const h = harness();
  for (const [card, rating, quality] of [["0_bronze", 60, "bronze"], ["1_silver", 70, "silver"], ["1_gold", 82, "gold"], ["99_special", 90, "special"]]) {
    const raw = h.parse().players[0];
    Object.assign(raw, { futbinRarityId: Number(card.split("_")[0]), cardImageUrl: `${origin}/cards/tiny/${card}.png`, rating });
    const payload = h.worker.toPayloadPlayer(raw);
    assert.equal(payload.quality_code, quality);
    assert.equal(payload.futbin_rarity_id, raw.futbinRarityId);
  }
  assert.equal(h.parse('<div class="no-results">No players</div>').confirmedEmpty, true);
  assert.equal(h.parse("<html><body>unexpected response</body></html>").confirmedEmpty, false);
  const invalid = h.parse(page('<tr class="player-row"><td>No player link</td></tr>'));
  assert.equal(invalid.errors.length, 1);
  assert.equal(invalid.players.length, 0);
  assert.throws(() => h.worker.toPayloadPlayer({ ...h.parse().players[0], futbinClubId: 0 }), /futbin_club_id/);
});

test("HTML → offscreen → payload → POST keeps five-page batches, dedupe and identical retries", async (t) => {
  const requests = [], pagesRead = [];
  const h = harness({ fetch: async (url, options) => {
    if (url.startsWith(origin)) {
      const n = Number(new URL(url).searchParams.get("page"));
      pagesRead.push(n);
      const rows = row(1000 + n) + (n === 2 ? row(1001, "9K") : n === 3 ? row(1001, "0").replace("2,500", "0") : n === 6 ? row(1001) : "");
      return new Response(page(rows, 6));
    }
    requests.push({ url, ...options });
    if (requests.length === 1) return new Response('{"message":"temporary error"}', { status: 503 });
    const count = JSON.parse(options.body).players.length;
    return new Response(JSON.stringify({ data: { saved: count, inserted: count } }));
  } });
  t.after(() => h.dispose());
  await h.evaluate('setState({ ...initialState, running: true, runOnce: true })');
  await h.worker.runSync(0, apiBase);
  assert.deepEqual(pagesRead, [1, 2, 3, 4, 5, 6]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body, requests[1].body);
  const bodies = [requests[1], requests[2]].map((request) => {
    assert.equal(request.url, `${apiBase}sync/futbin-player-clubs`);
    assert.equal(request.method, "POST");
    assert.equal(request.headers["Content-Type"], "application/json");
    return JSON.parse(request.body);
  });
  assert.deepEqual(bodies.map((body) => [body.page_from, body.page_to, body.pages_attempted, body.pages_succeeded]), [[1, 5, 5, 5], [6, 6, 1, 1]]);
  assert.deepEqual(bodies[0].players.map((player) => player.futbin_player_id), [1001, 1002, 1003, 1004, 1005]);
  assert.equal(bodies[0].players[0].price_console, 9000);
  assert.deepEqual(bodies[1].players.map((player) => player.futbin_player_id), [1006]);
  for (const body of bodies) {
    assert.equal(body.sync_mode, "filtered_partial");
    assert.equal(body.disable_missing_delete, true);
    assert.equal(body.source, "futbin_filtered_players");
    assert.deepEqual(body.filter, { ps_price: "300-45000", player_rating: "55-99" });
    assert.ok(body.players.every((player) => player.futbin_asset_id === 999999));
    for (const player of body.players) assertNoEaFields(player);
  }
  assert.equal(h.stored.filteredPlayersSyncState.savedPlayers, 6);
  assert.equal(h.stored.filteredPlayersSyncState.status, "Finished");
});

test("actual POST JSON sends Hutchinson Futbin IDs and no EA-prefixed properties", async (t) => {
  let body, serializedBody, requestUrl;
  const h = harness({ defaultApiBaseUrl: "https://api.sbcmonster.com/api/", fetch: async (url, options) => {
    requestUrl = url;
    serializedBody = options.body;
    body = JSON.parse(serializedBody);
    return new Response('{"data":{"saved":1}}');
  } });
  t.after(() => h.dispose());
  const hutchinsonRow = row(14450)
    .replace("test-player", "hutchinson")
    .replace("999999.png", "252895.png")
    .replace("Test Player Full", "Hutchinson").replace("Test Player", "Hutchinson");
  const parsed = h.parse(page(hutchinsonRow));
  h.worker.fetchAndParsePage = async () => parsed;
  await h.evaluate('setState({ ...initialState, running: true, runOnce: true })');
  await h.worker.runSync(0, "https://api.sbcmonster.com/api/");
  assert.equal(requestUrl, "https://api.sbcmonster.com/api/sync/futbin-player-clubs");
  const player = body.players[0];
  assert.equal(player.futbin_player_id, 14450);
  assert.equal(player.position_name, "CM");
  assert.match(player.url_img_player, /\/players\/252895\.png/);
  assert.equal(player.futbin_asset_id, 252895);
  assertNoEaFields(player);

  const serializedPlayer = JSON.parse(serializedBody).players[0];
  assert.equal(serializedPlayer.futbin_player_id, 14450);
  assert.equal(serializedPlayer.position_name, "CM");
  assert.match(serializedPlayer.url_img_player, /\/players\/252895\.png/);
  assert.equal(serializedPlayer.futbin_asset_id, 252895);
  assertNoEaFields(serializedPlayer);
});

test("exhausted API retries still skip the failed batch and continue to the next five-page boundary", async (t) => {
  const requests = [];
  const h = harness({ fetch: async (url, options) => {
    if (url.startsWith(origin)) return new Response(page(row(1000 + Number(new URL(url).searchParams.get("page"))), 6));
    const body = JSON.parse(options.body);
    requests.push(body);
    return body.page_from === 1
      ? new Response('{"message":"temporary error"}', { status: 503 })
      : new Response('{"data":{"saved":1}}');
  } });
  t.after(() => h.dispose());
  await h.evaluate('setState({ ...initialState, running: true, runOnce: true })');
  await h.worker.runSync(0, apiBase);
  assert.deepEqual(requests.map((body) => [body.page_from, body.page_to]), [[1, 5], [1, 5], [1, 5], [6, 6]]);
  assert.equal(h.stored.filteredPlayersSyncState.skippedPlayers, 5);
  assert.equal(h.stored.filteredPlayersSyncState.savedPlayers, 1);
  assert.equal(h.stored.filteredPlayersSyncState.status, "Finished");
});

for (const phase of ["Futbin fetch", "API POST"]) {
  test(`Stop immediately aborts ${phase} and prevents retries or stale state writes`, async (t) => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let signal, requests = 0;
    const h = harness({ fetch: async (url, options) => {
      if (phase === "API POST" && url.startsWith(origin)) return new Response(page());
      requests++;
      signal = options.signal;
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    } });
    t.after(() => h.dispose());
    await h.evaluate('setState({ ...initialState, running: true, runOnce: true })');
    const run = h.worker.runSync(0, apiBase);
    const rejected = assert.rejects(run, { name: "AbortError" });
    await ready;
    await h.worker.stopSync();
    assert.equal(signal.aborted, true);
    await rejected;
    assert.equal(requests, 1);
    assert.equal(h.stored.filteredPlayersSyncState.running, false);
    assert.equal(h.stored.filteredPlayersSyncState.status, "Hazır");
    assert.equal(h.stored.filteredPlayersSyncState.skippedPlayers, 0);
    assert.equal(h.stored.filteredPlayersSyncState.errors.length, 0);
  });
}

test("Stop cancels pending delays, tab polling and monitor requests, invalidating runToken", async (t) => {
  const h = harness({ fastDelays: false });
  t.after(() => h.dispose());
  await h.evaluate('setState({ ...initialState, running: true, runOnce: true })');
  let tabCancelled = false, disconnected = false;
  h.worker.onCancelTab = () => { tabCancelled = true; };
  h.worker.onDisconnect = () => { disconnected = true; };
  h.evaluate('cancelActiveTabWait = onCancelTab; networkPort = { postMessage() {}, disconnect: onDisconnect }');
  const pending = h.worker.networkApiRequest(`${apiBase}sync/futbin-player-clubs`, { method: "POST" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const delayed = h.worker.delay(5000);
  await h.worker.stopSync();
  await Promise.all([delayed, rejected]);
  assert.equal(tabCancelled, true);
  assert.equal(disconnected, true);
  assert.equal(h.evaluate("pendingDelayResolvers.size + networkPending.size + activeRequestControllers.size"), 0);
  assert.throws(() => h.worker.assertActive(0), { name: "AbortError" });
});

test("manifest service-worker module graph initializes without JavaScript errors with Chrome APIs mocked", () => {
  const manifest = JSON.parse(read("../manifest.json"));
  assert.equal(manifest.background.type, "module");
  const entry = new URL(`../${manifest.background.service_worker}`, import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    const event = { addListener() {} };
    globalThis.chrome = {
      runtime: { onInstalled: event, onStartup: event, onMessage: event, onConnect: event, getURL: path => 'chrome-extension://test/' + path },
      storage: { onChanged: event, local: { get: async () => ({}) } },
      alarms: { onAlarm: event }, tabs: { onUpdated: event, onRemoved: event }, action: { onClicked: event }
    };
    globalThis.fetch = async url => {
      assert.ok(url.startsWith('chrome-extension://test/.env?'));
      return new Response('API_BASE_URL=https://sync.invalid/api/');
    };
    await import(${JSON.stringify(entry)});
    await globalThis.FutbinSyncApiConfig.ready;
    assert.deepEqual(Object.keys(globalThis.FutbinSyncModuleControls).sort(), ['important', 'latest', 'pricerange']);
    assert.equal(typeof globalThis.FutbinSyncModuleControls.important.stop, 'function');
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 10000 });
});
