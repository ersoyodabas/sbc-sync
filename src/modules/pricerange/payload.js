function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function priceRangePayload(card, record) {
  const cross = {
    min: positive(card.min_price_cross ?? card.minPriceCross ?? card.min_price_console ?? card.minPriceConsole),
    max: positive(card.max_price_cross ?? card.maxPriceCross ?? card.max_price_console ?? card.maxPriceConsole)
  };
  const pc = {
    min: positive(card.min_price_pc ?? card.minPricePc),
    max: positive(card.max_price_pc ?? card.maxPricePc)
  };
  const psMin = positive(record.min_price_ps ?? record.minPricePs);
  const psMax = positive(record.max_price_ps ?? record.maxPricePs);
  const pcMin = positive(record.min_price_pc ?? record.minPricePc);
  const pcMax = positive(record.max_price_pc ?? record.maxPricePc);
  if (psMin && psMax) { cross.min = psMin; cross.max = psMax; }
  if (pcMin && pcMax) { pc.min = pcMin; pc.max = pcMax; }
  if (![cross.min, cross.max, pc.min, pc.max].every(Boolean)) {
    throw new Error("Coin Card için iki platformun min/max range bilgileri dolu olmalıdır.");
  }
  const priceCross = positive(record.price_ps ?? record.priceCross ?? record.price_cross);
  const pricePc = positive(record.pricePc ?? record.price_pc);
  if (!priceCross) throw new Error("Futbin oyuncu detay sayfasından PS/Cross fiyatı okunamadı.");
  // Field names and order intentionally mirror Latest's toApiCoinCard DTO.
  return {
    player_name: card.player_name || card.playerName || record.player_name,
    rating: Number(card.rating) || record.rating || null,
    position: card.position || card.positionName || record.position || null,
    player_img_url: card.player_img_url || card.playerImgUrl || record.player_img_url || null,
    bg_card_url: card.bg_card_url || card.bgCardUrl || record.card_img_url || null,
    nation_img_url: card.nation_img_url || card.nationImgUrl || null,
    min_price_cross: cross.min,
    price_cross: priceCross,
    max_price_cross: cross.max,
    min_price_pc: pc.min,
    price_pc: pricePc,
    max_price_pc: pc.max
  };
}

export function priceRangeInsertRequest(sourceDate, record) {
  const updatePayload = priceRangePayload({}, record);
  const url = String(record.player_url ?? record.playerUrl ?? record.url ?? "").trim();
  if (!url) throw new Error("Yeni Coin Card için Futbin oyuncu URL'si okunamadı.");

  // This is the exact single-card form consumed by Latest's insert endpoint.
  const card = {
    player_name: updatePayload.player_name,
    rating: updatePayload.rating,
    position: updatePayload.position,
    url,
    player_img_url: updatePayload.player_img_url,
    bg_card_url: updatePayload.bg_card_url,
    nation_img_url: updatePayload.nation_img_url,
    min_price_cross: updatePayload.min_price_cross,
    price_cross: updatePayload.price_cross,
    max_price_cross: updatePayload.max_price_cross,
    min_price_pc: updatePayload.min_price_pc,
    price_pc: updatePayload.price_pc,
    max_price_pc: updatePayload.max_price_pc
  };

  return { source_date: sourceDate, cards: [card] };
}
