import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTBIN_CHALLENGE_MAX_WAIT_MS,
  futbinChallengeTimeoutError,
  isFutbinChallengeHtml
} from "../src/modules/futbin/challenge.js";

test("Futbin Cloudflare challenge HTML'ini algılar", () => {
  assert.equal(isFutbinChallengeHtml("<h1>Güvenlik doğrulaması yapılıyor</h1><p>Cloudflare</p>"), true);
  assert.equal(isFutbinChallengeHtml("Checking your browser before accessing futbin.com"), true);
});

test("hedef Futbin HTML'ini challenge olarak işaretlemez", () => {
  assert.equal(isFutbinChallengeHtml('<table class="players-table"><tr class="player-row"></tr></table>'), false);
  assert.equal(isFutbinChallengeHtml(""), false);
});

test("doğrulama bekleme süresi beş dakikadır", () => {
  assert.equal(FUTBIN_CHALLENGE_MAX_WAIT_MS, 5 * 60 * 1000);
  assert.match(futbinChallengeTimeoutError("https://www.futbin.com/latest"), /300 saniye/);
});
