import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
