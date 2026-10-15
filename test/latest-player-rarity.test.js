import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DOMParser } from "linkedom";

const source = readFileSync(new URL("../src/modules/latest/background.js", import.meta.url), "utf8");
const worker = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("function toApiPlayer("), source.indexOf("function validateLookups(")), worker);

const validPlayer = {
  name: "Test Player", futbinPlayerId: 1001, qualityId: 1, rating: 82,
  positionId: 1, nationId: 1, priceConsole: 100, pricePc: 100,
  urlImgCard: "card.png", urlImgNation: "nation.png", urlImgLeague: "league.png", urlImgClub: "club.png"
};

test("Latest POST sends null rarity for every base quality, including previously mapped players", () => {
  for (const qualityCode of ["bronze", "silver", "gold"]) {
    for (const rarityId of [null, 1, 2]) {
      const player = { ...validPlayer, qualityCode, rarityId };
      assert.equal(worker.validateMappedPlayer(player).length, 0);
      assert.equal(JSON.parse(JSON.stringify(worker.toApiPlayer(player))).rarity_id, null);
    }
  }
});

test("Latest special players keep their rarity and require a valid rarity ID", () => {
  const player = { ...validPlayer, qualityCode: "special", rarityId: 99 };
  assert.equal(worker.validateMappedPlayer(player).length, 0);
  assert.equal(worker.toApiPlayer(player).rarity_id, 99);
  assert.ok(worker.validateMappedPlayer({ ...player, rarityId: null }).includes("player.rarity_id okunamadı"));
});

test("Latest payload preserves exact special definitions independently of portrait and FUTBIN IDs", () => {
  for (const [futbinPlayerId, definitionId, priceConsole] of [[22781, 67360430, 22750], [22782, 84137646, 12750]]) {
    const payload = worker.toApiPlayer({ ...validPlayer, futbinPlayerId, futbinAssetId: definitionId, definitionId, priceConsole, qualityCode: 'special', rarityId: 166 });
    assert.equal(payload.definition_id, definitionId);
    assert.equal(payload.futbin_asset_id, definitionId);
    assert.equal(payload.price_console, priceConsole);
  }
  assert.equal(worker.toApiPlayer({ ...validPlayer, futbinAssetId: 251566, definitionId: null }).definition_id, undefined);
});


test("Latest content and offscreen parse captured FC27 special-card images and prices", () => {
  const parser = vm.createContext({ DOMParser, URL, document: new DOMParser().parseFromString('<html><body></body></html>', 'text/html'), chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(readFileSync(new URL('../src/modules/latest/content.js', import.meta.url), 'utf8'), parser);
  vm.runInContext(readFileSync(new URL('../src/modules/latest/offscreen.js', import.meta.url), 'utf8'), parser);
  const result = parser.parseFetchedPage({ html: readFileSync(new URL('./fixtures/martinelli-27.html', import.meta.url), 'utf8'), page: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.errors)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(result.players.map(p => [p.futbinPlayerId, p.futbinAssetId, p.definitionId, p.priceConsole]))), [
    [22781, 67360430, 67360430, 22750], [22782, 84137646, 84137646, 12750], [22003, 251566, null, 650]
  ]);
});
