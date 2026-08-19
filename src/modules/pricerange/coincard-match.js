function playerIdFromUrl(value) {
  return Number(String(value || "").match(/\/player\/(\d+)/i)?.[1]) || null;
}

export function canonicalCoinCardUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href.toLowerCase();
  } catch {
    return String(value || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

export function indexCoinCards(cards = []) {
  const byPlayerId = new Map();
  const byUrl = new Map();

  for (const card of cards) {
    if (!card || !Number.isInteger(Number(card.id)) || Number(card.id) <= 0) continue;

    const playerId = Number(card.futbin_player_id ?? card.futbinPlayerId ?? playerIdFromUrl(card.url));
    if (Number.isInteger(playerId) && playerId > 0) byPlayerId.set(playerId, card);

    const url = canonicalCoinCardUrl(card.url);
    if (url) byUrl.set(url, card);
  }

  return { byPlayerId, byUrl };
}

export function matchCoinCard(index, player = {}) {
  const playerId = Number(player.futbin_player_id ?? player.futbinPlayerId);
  const idMatch = Number.isInteger(playerId) && playerId > 0
    ? index?.byPlayerId?.get(playerId)
    : null;
  if (idMatch) return { card: idMatch, matchedBy: "id" };

  const url = canonicalCoinCardUrl(player.player_url ?? player.playerUrl ?? player.url);
  const urlMatch = url ? index?.byUrl?.get(url) : null;
  return urlMatch ? { card: urlMatch, matchedBy: "url" } : { card: null, matchedBy: null };
}
