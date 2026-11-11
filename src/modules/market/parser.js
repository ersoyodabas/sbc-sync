// Reads the price risers / fallers of https://www.futbin.com/market. readMarket also runs inside the Futbin tab through
// chrome.scripting.executeScript, so it must stay self-contained (nothing from outside its own body); the tests call it with a parsed document.
//
// Page structure: .market-24-hours | .market-4-hours > .market-gain | .market-losers > .platform-ps-only | .platform-pc-only
//   > a.market-player-card[href="/27/player/{futbinId}/{slug}"] with .playercard-s-27-rating, .playercard-s-27-position,
//   .market-price-wrapper .price-segment ("2.6K"), .item-score-segment ("2.1K"), .market-player-change (".day-change-percentage").
// Names, clubs, leagues, nations and images are on the player row in the database, so they are not read here.
export function readMarket(doc) {
  doc = doc || document;
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  // "700" -> 700, "2.1K" -> 2100, "1,234" / "1.234" -> 1234, "1.12M" -> 1120000. Anything else is null.
  const amount = (value) => {
    const raw = String(value || "").replace(/\s+/g, "");
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) return Number(raw.replace(/[.,]/g, ""));
    const match = /^(\d+(?:[.,]\d+)?)([KkMm]?)$/.exec(raw);
    if (!match) return null;
    const number = Number(match[1].replace(",", "."));
    const factor = { k: 1e3, m: 1e6 }[match[2].toLowerCase()] || 1;
    return Number.isFinite(number) ? Math.round(number * factor) : null;
  };
  const percent = (value) => {
    const match = /(\d+(?:[.,]\d+)?)\s*%/.exec(String(value || ""));
    return match ? Number(match[1].replace(",", ".")) : null;
  };

  const players = [];
  const ranks = new Map();
  for (const card of doc.querySelectorAll("a.market-player-card")) {
    const period = card.closest(".market-24-hours") ? "24h" : card.closest(".market-4-hours") ? "4h" : null;
    const direction = card.closest(".market-gain") ? "gain" : card.closest(".market-losers") ? "loss" : null;
    const platform = card.closest(".platform-pc-only") ? "pc" : card.closest(".platform-ps-only") ? "ps" : null;
    const idMatch = /\/player\/(\d+)(?:\/|$|\?|#)/.exec(card.getAttribute("href") || "");
    if (!period || !direction || !platform || !idMatch) continue;

    const list = `${period}/${direction}/${platform}`;
    const rank = (ranks.get(list) || 0) + 1;
    ranks.set(list, rank);
    const priceText = text(card.querySelector(".market-price-wrapper .price-segment") || card.querySelector(".price-segment"));
    const scoreText = text(card.querySelector(".market-price-wrapper .item-score-segment") || card.querySelector(".item-score-segment"));
    const magnitude = percent(text(card.querySelector(".market-player-change")));
    players.push({
      period, direction, platform,
      futbinPlayerId: Number(idMatch[1]),
      rank,
      price: amount(priceText),
      priceText,
      itemScore: amount(scoreText),
      // Positive for risers, negative for fallers.
      changePercent: magnitude === null ? null : direction === "gain" ? magnitude : -magnitude,
      rating: Number(text(card.querySelector(".playercard-s-27-rating"))) || null,
      position: text(card.querySelector(".playercard-s-27-position"))
    });
  }

  const title = text(doc.querySelector("title"));
  const challenge = /just a moment|attention required|verify you are human|güvenlik/i.test(title) || !!doc.querySelector("#challenge-form, .cf-turnstile, #cf-challenge-running");
  return { ready: players.length > 0, challenge, count: players.length, players, pageTitle: title };
}

// The request body of POST sync/futbin-market (snake_case, like the other FutbinSync payloads).
export function marketPayload(market, { sourceUrl, capturedAt }) {
  return {
    source: "futbin_market",
    source_url: sourceUrl,
    captured_at: capturedAt,
    players: market.players.map((player) => ({
      period: player.period,
      direction: player.direction,
      platform: player.platform,
      futbin_player_id: player.futbinPlayerId,
      rank: player.rank,
      price: player.price,
      price_text: player.priceText || null,
      item_score: player.itemScore,
      change_percent: player.changePercent,
      rating: player.rating,
      position: player.position || null
    }))
  };
}
