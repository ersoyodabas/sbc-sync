import test from "node:test";
import assert from "node:assert/strict";
import { isDateBefore, isDateInRange, lookbackStartDate, paginationDecision, priceRangeRatioDecision } from "../src/modules/pricerange/policy.js";
import { priceRangeInsertRequest, priceRangePayload } from "../src/modules/pricerange/payload.js";
import { canonicalCoinCardUrl, indexCoinCards, matchCoinCard } from "../src/modules/pricerange/coincard-match.js";

await import("../src/modules/pricerange/parser.js");

const parser = globalThis.FutbinPriceRangeParser;

test("Price Range fiyatlarını FUTBIN biçimlerinden normalize eder", () => {
  assert.equal(parser.parsePrice("750"), 750);
  assert.equal(parser.parsePrice("1,500"), 1500);
  assert.equal(parser.parsePrice("35K"), 35000);
  assert.equal(parser.parsePrice("1.2M"), 1200000);
  assert.equal(parser.parsePrice("—"), null);
});

test("Price Range kimliği farklı platform/range güncellemelerini korur", () => {
  const common = { futbin_player_id: 28360, updated_on: "2026-08-19", new_min_price: 100000, new_max_price: 200000 };
  assert.notEqual(parser.recordKey({ ...common, platform: "cross" }), parser.recordKey({ ...common, platform: "pc" }));
  assert.notEqual(parser.recordKey({ ...common, platform: "cross" }), parser.recordKey({ ...common, platform: "cross", new_max_price: 210000 }));
});

test("Price Range oyuncu adı sayısal link metni yerine FUTBIN URL slug'ından türetilir", () => {
  assert.equal(parser.playerNameFromUrl("https://www.futbin.com/26/player/28400/alex-morgan"), "Alex Morgan");
});

test("Price Range tarihleri yalnız takvim gününü kabul eder", () => {
  assert.equal(parser.normalizeDate("Updated 2026-08-19"), "2026-08-19");
  assert.equal(parser.normalizeDate("19.08.2026"), null);
});

test("Price Range sayfalaması ilk eski kayıtta, boş sayfada güvenle durur", () => {
  assert.equal(paginationDecision({ rowCount: 30, parsedCount: 30, olderCount: 0 }).shouldContinue, true);
  assert.equal(paginationDecision({ rowCount: 30, parsedCount: 30, olderCount: 13 }).shouldContinue, false);
  assert.equal(paginationDecision({ rowCount: 30, parsedCount: 30, olderCount: 30 }).reason, "older-reached");
  assert.equal(paginationDecision({ rowCount: 0, parsedCount: 0, olderCount: 0 }).reason, "empty-page");
});

test("Price Range lookback penceresi takvim günlerine göre hesaplanır", () => {
  assert.equal(lookbackStartDate("2026-08-19", 1), "2026-08-19");
  assert.equal(lookbackStartDate("2026-08-19", 2), "2026-08-18");
  assert.equal(isDateInRange("2026-08-18", "2026-08-18", "2026-08-19"), true);
  assert.equal(isDateBefore("2026-08-17", "2026-08-18"), true);
});

test("Price Range yalnız max range, PS Buy Now fiyatının en az üç katıysa seçilir", () => {
  assert.deepEqual(priceRangeRatioDecision({ max_price_ps: 300000, price_ps: 100000 }), {
    ratio: 3,
    qualifies: true,
    reason: "qualified"
  });
  assert.equal(priceRangeRatioDecision({ max_price_ps: 299000, price_ps: 100000 }).qualifies, false);
  assert.equal(priceRangeRatioDecision({ max_price_ps: 300000, price_ps: null }).reason, "range-max-or-buy-now-missing");
});

test("Coin Card önce FUTBIN ID, sonra kanonik oyuncu URL'si ile eşleşir", () => {
  const idCard = { id: 10, futbin_player_id: 28400, url: "https://www.futbin.com/26/player/28400/alex-morgan" };
  const urlCard = { id: 11, url: "https://www.futbin.com/26/player/28401/sam-kerr/" };
  const index = indexCoinCards([idCard, urlCard]);

  assert.equal(matchCoinCard(index, { futbin_player_id: 28400, player_url: "https://www.futbin.com/26/player/99999/other" }).card, idCard);
  assert.equal(matchCoinCard(index, { futbin_player_id: 99999, player_url: "https://www.futbin.com/26/player/28401/sam-kerr?tab=prices#range" }).card, urlCard);
  assert.equal(matchCoinCard(index, { futbin_player_id: 99999, player_url: "https://www.futbin.com/26/player/12345/no-match" }).card, null);
  assert.equal(canonicalCoinCardUrl("https://www.futbin.com/26/player/28401/sam-kerr/?a=1#prices"), "https://www.futbin.com/26/player/28401/sam-kerr");
});

test("Price Range payload fiyat ve range alanlarını oyuncu detay sayfasından gönderir", () => {
  const payload = priceRangePayload({
    player_name: "Sophia Wilson",
    rating: 95,
    position: "ST",
    min_price_cross: 10000,
    max_price_cross: 20000,
    min_price_pc: 8000,
    max_price_pc: 16000
  }, {
    min_price_ps: 100000,
    max_price_ps: 300000,
    price_ps: 145000,
    min_price_pc: 90000,
    max_price_pc: 250000,
    price_pc: 128000
  });
  assert.equal(payload.min_price_cross, 100000);
  assert.equal(payload.max_price_cross, 300000);
  assert.equal(payload.min_price_pc, 90000);
  assert.equal(payload.max_price_pc, 250000);
  assert.equal(payload.price_cross, 145000);
  assert.equal(payload.price_pc, 128000);
  assert.deepEqual(Object.keys(payload), [
    "player_name", "rating", "position", "player_img_url", "bg_card_url", "nation_img_url",
    "min_price_cross", "price_cross", "max_price_cross",
    "min_price_pc", "price_pc", "max_price_pc"
  ]);
});

test("Price Range payload PC fiyatı yoksa null gönderir; PS/Cross fiyatı zorunludur", () => {
  const payload = priceRangePayload({
    player_name: "Sophia Wilson",
    min_price_cross: 10000,
    max_price_cross: 20000,
    min_price_pc: 8000,
    max_price_pc: 16000
  }, {
    platform: "pc",
    new_min_price: 100000,
    new_max_price: 300000,
    price_ps: 145000
  });
  assert.equal(payload.price_cross, 145000);
  assert.equal(payload.price_pc, null);
  assert.throws(() => priceRangePayload({
    player_name: "Sophia Wilson",
    min_price_cross: 10000,
    max_price_cross: 20000,
    min_price_pc: 8000,
    max_price_pc: 16000
  }, {
    platform: "pc",
    new_min_price: 100000,
    new_max_price: 300000
  }), /PS\/Cross/);
});

test("Price Range payload PS ve PC detay range'lerini tek istekte birleştirir", () => {
  const payload = priceRangePayload({
    player_name: "Alex Morgan",
    min_price_cross: 1,
    max_price_cross: 2,
    min_price_pc: 3,
    max_price_pc: 4
  }, {
    price_ps: 2380000,
    price_pc: 2500000,
    min_price_ps: 280000,
    max_price_ps: 5300000,
    min_price_pc: 300000,
    max_price_pc: 6000000
  });
  assert.equal(payload.min_price_cross, 280000);
  assert.equal(payload.max_price_cross, 5300000);
  assert.equal(payload.min_price_pc, 300000);
  assert.equal(payload.max_price_pc, 6000000);
});

test("Eşleşmeyen Coin Card için Latest insert gövdesi URL ve güncel fiyatları içerir", () => {
  const request = priceRangeInsertRequest("2026-08-19", {
    player_name: "Alex Morgan",
    rating: 94,
    position: "ST",
    player_url: "https://www.futbin.com/26/player/28400/alex-morgan",
    player_img_url: "https://cdn.example/player.png",
    card_img_url: "https://cdn.example/card.png",
    price_ps: 2_380_000,
    min_price_ps: 280_000,
    max_price_ps: 5_300_000,
    price_pc: 2_500_000,
    min_price_pc: 300_000,
    max_price_pc: 6_000_000
  });

  assert.equal(request.source_date, "2026-08-19");
  assert.equal(request.cards.length, 1);
  assert.deepEqual(request.cards[0], {
    player_name: "Alex Morgan",
    rating: 94,
    position: "ST",
    url: "https://www.futbin.com/26/player/28400/alex-morgan",
    player_img_url: "https://cdn.example/player.png",
    bg_card_url: "https://cdn.example/card.png",
    nation_img_url: null,
    min_price_cross: 280_000,
    price_cross: 2_380_000,
    max_price_cross: 5_300_000,
    min_price_pc: 300_000,
    price_pc: 2_500_000,
    max_price_pc: 6_000_000
  });
});
