let collectionInProgress = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COLLECT_SYNC_PAGE") return;
  if (collectionInProgress) {
    sendResponse({ ok: true, duplicate: true });
    return;
  }
  collectionInProgress = true;
  collectAndPublish(message).finally(() => { collectionInProgress = false; });
  sendResponse({ ok: true });
});

async function collectAndPublish(message) {
  try {
    const navigation = performance.getEntriesByType("navigation")[0];
    if (Number(navigation?.responseStatus) >= 400) {
      const result = await chrome.runtime.sendMessage({
        futbinSyncModule: "latest",
        type: "SYNC_PAGE_FAILED",
        page: Number(message.page),
        pageUrl: location.href,
        error: `Futbin HTTP ${navigation.responseStatus}: ${location.href}`
      });
      scheduleAdvance(result);
      return;
    }
    if (message.operation === "coin-card-latest") {
      await collectLatestCoinCardsAndPublish(message);
      return;
    }
    if (message.operation === "coin-cards") {
      await collectCoinCardAndPublish(message);
      return;
    }
    await waitForPlayerRows(60000);
    if (Number(message.page) === 1 && message.operation !== "coin-cards") validateSelectedFilters(message.job);
    const rows = [...document.querySelectorAll("tr.player-row, .player-row")];
    const errors = [];
    const players = [];
    rows.forEach((row, index) => {
      try {
        players.push(parsePlayerRow(row));
      } catch (error) {
        errors.push({
          stage: "parse",
          message: error.message?.replace(/^\[CRITICAL\]\s*/, "") || `Oyuncu satırı okunamadı. Row: ${index + 1}`,
          player: { rowIndex: index + 1 }
        });
      }
    });
    const totalPages = message.operation === "coin-cards"
      ? 1
      : Number(message.page) === 1 ? extractTotalPages() : undefined;
    const result = await chrome.runtime.sendMessage({
      futbinSyncModule: "latest",
      type: "SYNC_PAGE_RESULT",
      page: Number(message.page),
      pageUrl: location.href,
      totalPages,
      players,
      errors
    });
    scheduleAdvance(result);
  } catch (error) {
    await chrome.runtime.sendMessage({
      futbinSyncModule: "latest",
      type: "SYNC_PAGE_CRITICAL",
      page: Number(message.page),
      pageUrl: location.href,
      error: error.message?.includes("[CRITICAL]") ? error.message : `[CRITICAL] ${error.message || error}`
    }).catch(() => {});
  }
}

async function collectLatestCoinCardsAndPublish(message) {
  await waitForPlayerRows(60000);
  const rows = [...document.querySelectorAll("table.players-table tr.player-row, tr.player-row")];
  const sourceDate = normalize(rows[0]?.querySelector(".table-added-on")?.textContent) || null;
  const errors = [];
  const cards = [];
  rows.forEach((row, index) => {
    try {
      cards.push(parseLatestCoinCardRow(row));
    } catch (error) {
      errors.push({
        stage: "latest-parse",
        message: error.message || `Latest Coin Card satırı okunamadı. Row: ${index + 1}`,
        player: { rowIndex: index + 1 }
      });
    }
  });

  const result = await chrome.runtime.sendMessage({
    futbinSyncModule: "latest",
    type: "SYNC_PAGE_RESULT",
    page: Number(message.page) || 1,
    pageUrl: location.href,
    totalPages: Number(message.latestTotalPages) || 2,
    latestCoinCards: { sourceDate, cards },
    players: [],
    errors
  });
  scheduleAdvance(result);
}

function parseLatestCoinCardRow(row) {
  const nameLink = row.querySelector("a.table-player-name");
  const href = nameLink?.getAttribute("href")?.trim();
  if (!href) throw new Error("Latest Coin Card URL okunamadı.");
  const images = [...row.querySelectorAll("td.table-name a img")];
  const bgCard = row.querySelector("td.table-name img[class*='playercard'][class*='bg']");
  const nation = row.querySelector(".playercard-26-s-stats img.nation, td.table-name img.nation");
  const cells = [...row.children];
  const crossRange = parseLatestPriceRange(row.querySelector(".table-cross-range")?.textContent);
  const pcRange = parseLatestPriceRange(row.querySelector(".table-pc-range.platform-pc-text")?.textContent);

  const card = {
    playerName: normalize(nameLink.textContent),
    url: new URL(href, "https://www.futbin.com").href,
    playerImgUrl: imageUrl(images[1]),
    bgCardUrl: imageUrl(bgCard),
    nationImgUrl: imageUrl(nation),
    rating: integerFromText(cells[1]?.textContent),
    position: normalize(cells[2]?.textContent),
    minPriceCross: crossRange?.min ?? null,
    priceCross: priceFromNode(row.querySelector(".table-cross-price")) || null,
    maxPriceCross: crossRange?.max ?? null,
    minPricePc: pcRange?.min ?? null,
    pricePc: priceFromNode(row.querySelector(".table-pc-price.platform-pc-text")) || null,
    maxPricePc: pcRange?.max ?? null
  };
  assertValidLatestCoinCardPrices(card);
  return card;
}

function assertValidLatestCoinCardPrices(card) {
  if (hasCompletePlatformPriceSet(card, "Cross") || hasCompletePlatformPriceSet(card, "Pc")) return;
  throw new Error("Eksik fiyat bilgisi nedeniyle atlandı: Cross veya PC fiyat seti tamamlanmalı");
}

function hasCompletePlatformPriceSet(card, platform) {
  const suffix = platform === "Cross" ? "Cross" : "Pc";
  return [
    card?.[`price${suffix}`],
    card?.[`minPrice${suffix}`],
    card?.[`maxPrice${suffix}`]
  ].every((value) => Number.isFinite(Number(value)) && Number(value) > 0);
}

function parseLatestPriceRange(value) {
  const prices = normalize(value).match(/\d+(?:[.,]\d+)?\s*[KM]?/gi) || [];
  if (prices.length < 2) return null;
  return { min: parseCoinCardPrice(prices[0]), max: parseCoinCardPrice(prices[1]) };
}

async function collectCoinCardAndPublish(message) {
  const result = await chrome.runtime.sendMessage({
    futbinSyncModule: "latest",
    type: "SYNC_PAGE_RESULT",
    page: 1,
    pageUrl: location.href,
    totalPages: 1,
    coinCard: parseCoinCardDetail(),
    players: [],
    errors: []
  });
  scheduleAdvance(result);
}

function parseCoinCardDetail() {
  const playerName = readText(document, ".playercard-26-name.text-ellipsis");
  const ratingMatch = document.title.match(/-\s*(\d+)/);
  const position = readText(document, ".playercard-26-position") ||
    readText(document, ".pcdisplay-pos") || readText(document, ".player-position");
  const playerImgUrl = document.querySelector("meta[property='og:image']")?.getAttribute("content") || null;
  const bgCardUrl = imageUrl(document.querySelector("img[src*='img/cards/hd']"));
  const nationImgUrl = imageUrl(document.querySelector("img.nation, img[class*='nation']"));

  const crossPrice = priceFromNode(document.querySelector(".lowest-price-1"));
  const crossRange = priceRangeFromContainer(findPriceRangeContainer(document));
  const pcBox = document.querySelector(".price-box.platform-pc-only");
  const pcPrice = priceFromNode(pcBox?.querySelector(".price.lowest-price-1"));
  const pcRange = priceRangeFromContainer(findPriceRangeContainer(pcBox));

  return {
    playerName: playerName || null,
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    position,
    playerImgUrl,
    bgCardUrl,
    nationImgUrl,
    minPriceCross: crossRange?.min ?? null,
    priceCross: crossPrice || null,
    maxPriceCross: crossRange?.max ?? null,
    minPricePc: pcRange?.min ?? null,
    pricePc: pcPrice || null,
    maxPricePc: pcRange?.max ?? null
  };
}

function findPriceRangeContainer(root) {
  if (!root) return null;
  return [...root.querySelectorAll("div")].find((node) =>
    [...node.children].some((child) => normalize(child.textContent) === "Price Range:")) || null;
}

function priceRangeFromContainer(container) {
  if (!container) return null;
  const match = normalize(container.textContent).match(/([\d.,]+\s*[KM]?)\s*-\s*([\d.,]+\s*[KM]?)/i);
  if (!match) return null;
  return { min: parseCoinCardPrice(match[1]), max: parseCoinCardPrice(match[2]) };
}

function priceFromNode(node) {
  return node ? parseCoinCardPrice(node.textContent) : 0;
}

function parseCoinCardPrice(value) {
  const text = normalize(value).toUpperCase();
  if (text.endsWith("K") || text.endsWith("M")) return parseFutbinPrice(text);
  const digits = [...text].filter((char) => /\d/.test(char)).join("");
  return Number(digits) || 0;
}

function imageUrl(node) {
  return node?.currentSrc || node?.src || node?.getAttribute("src") || null;
}

function scheduleAdvance(result) {
  if (result?.action !== "WAIT_AND_ADVANCE" || !result.nextUrl) {
    console.log("[LatestPlayerSync Content] Geçiş planlanmadı", result);
    return;
  }
  console.log("[LatestPlayerSync Content] Yedek geçiş zamanlayıcısı kuruldu", {
    nextUrl: result.nextUrl,
    waitMs: result.waitMs,
    at: new Date().toISOString()
  });
  setTimeout(() => {
    console.log("[LatestPlayerSync Content] Yedek geçiş isteği gönderiliyor", {
      nextUrl: result.nextUrl,
      at: new Date().toISOString()
    });
    chrome.runtime.sendMessage({ futbinSyncModule: "latest", type: "ADVANCE_SYNC", url: result.nextUrl })
      .then((response) => console.log("[LatestPlayerSync Content] Geçiş yanıtı", response))
      .catch((error) => console.error("[LatestPlayerSync Content] Geçiş mesajı gönderilemedi", error));
  }, Math.max(0, Number(result.waitMs) || 0));
}

function waitForPlayerRows(timeoutMs) {
  if (document.querySelector("tr.player-row, .player-row")) return Promise.resolve();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (document.querySelector("tr.player-row, .player-row") || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

function validateSelectedFilters(job) {
  const filterNodes = [...document.querySelectorAll(".selected-filters-wrapper a")];
  if (!filterNodes.length) {
    throw new Error(`[CRITICAL] Seçili filtreler bulunamadı. League: '${job.league_name}', Club: '${job.club_name}'`);
  }
  const filterTexts = filterNodes.map((node) => normalize(node.textContent));
  const leagueExists = filterTexts.some((text) => sameText(text, job.league_name));
  const clubExists = filterTexts.some((text) => sameText(text, job.club_name));
  if (!leagueExists || !clubExists) {
    throw new Error(`[CRITICAL] Futbin filtreleri uyuşmuyor. Beklenen League: '${job.league_name}', Club: '${job.club_name}'. Gelen: ${filterTexts.join(", ")}`);
  }
}

function extractTotalPages() {
  const wrapper = document.querySelector(".pagination-buttons-wrapper");
  if (!wrapper) return 1;
  const pages = [...wrapper.querySelectorAll("a, span")]
    .map((node) => Number(normalize(node.textContent)))
    .filter((value) => Number.isInteger(value) && value > 0);
  return pages.length ? Math.max(...pages) : 1;
}

function parsePlayerRow(row) {
  const linkNode = row.querySelector("a.player-row-playercard");
  const href = linkNode?.getAttribute("href") || "";
  if (!href) throw new Error("[CRITICAL] Player link node (href) bulunamadı!");
  const playerLink = new URL(href, "https://www.futbin.com").href;
  const idMatch = playerLink.match(/\/player\/(\d+)/);
  if (!idMatch) throw new Error(`[CRITICAL] Futbin ID ayrıştırılamadı! URL: ${playerLink}`);

  const fullName = readText(row, "a.table-player-name");
  const cardPlayerImage = row.querySelector("img.playercard-s-base-img, img[class*='special-img'], img[class*='base-img']");
  const name = normalize(cardPlayerImage?.getAttribute("alt")) || fullName;
  if (!name) throw new Error(`[CRITICAL] Oyuncu ismi okunamadı! ID: ${idMatch[1]}`);

  const rating = integerFromText(readText(row, ".table-rating .rating-square") || readText(row, ".table-rating"));
  if (!rating) throw new Error(`[CRITICAL] Rating okunamadı! Oyuncu: ${name} (${idMatch[1]})`);

  const fallbackPriceNode = row.querySelector(".table-price .price");
  const consolePriceNode = row.querySelector(".platform-ps-only .price") || fallbackPriceNode;
  const pcPriceNode = row.querySelector(".platform-pc-only .price") || fallbackPriceNode;
  if (!consolePriceNode || !pcPriceNode) throw new Error(`[CRITICAL] Fiyat düğümü bulunamadı! Oyuncu: ${name}`);

  const nationImage = row.querySelector("img.nation, .table-player-nation img, img[alt='Nation']");
  const nationName = normalize(nationImage?.getAttribute("title") || nationImage?.getAttribute("alt"));
  if (!nationName) throw new Error(`[CRITICAL] Ulus ismi okunamadı! Oyuncu: ${name}`);

  const positionName = readText(row, ".table-pos .table-pos-main span") || readText(row, ".table-pos-main");
  if (!positionName) throw new Error(`[CRITICAL] Pozisyon ismi okunamadı! Oyuncu: ${name}`);

  const cardImage = row.querySelector("img.playercard-s-26-bg, img[class*='playercard'][class*='bg'], img[src*='/cards/']");
  const cardImageUrl = cardImage?.currentSrc || cardImage?.src || "";
  if (!cardImageUrl) throw new Error(`[CRITICAL] Kart görseli bulunamadı! Oyuncu: ${name}`);

  const playerImage = row.querySelector(".table-name img.playercard-s-base-img, img[class*='special-img'], img[class*='base-img'], img[src*='/players/']");
  const playerImageUrl = firstSrcSetUrl(playerImage?.getAttribute("srcset")) || playerImage?.currentSrc || playerImage?.src || null;
  const leagueImage = row.querySelector(".table-player-league img, img[alt='League']");
  const clubImage = row.querySelector(".table-player-club img, img[alt='Club']");
  const leagueName = normalize(leagueImage?.getAttribute("title"));
  const clubName = normalize(clubImage?.getAttribute("title"));

  return {
    futbinPlayerId: Number(idMatch[1]),
    futbinAssetId: Number(new URL(playerImageUrl || "", "https://www.futbin.com").pathname.match(/\/img\/players\/p?([1-9]\d*)\.png$/i)?.[1]) || null,
    definitionId: Number(new URL(playerImageUrl || "", "https://www.futbin.com").pathname.match(/\/img\/players\/p([1-9]\d*)\.png$/i)?.[1]) || null,
    futbinPlayerLink: playerLink,
    name,
    fullName,
    rating,
    priceConsole: parseFutbinPrice(consolePriceNode.textContent),
    pricePc: parseFutbinPrice(pcPriceNode.textContent),
    nationName,
    leagueName,
    clubName,
    nationImageUrl: nationImage?.currentSrc || nationImage?.src || null,
    leagueImageUrl: leagueImage?.currentSrc || leagueImage?.src || null,
    clubImageUrl: clubImage?.currentSrc || clubImage?.src || null,
    positionName,
    alternativePositions: readText(row, ".xs-font.text-faded.bold") || null,
    cardImageUrl,
    playerImageUrl
  };
}

function readText(root, selector) {
  return normalize(root.querySelector(selector)?.textContent);
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function sameText(left, right) {
  return normalize(left).localeCompare(normalize(right), undefined, { sensitivity: "accent" }) === 0;
}

function integerFromText(value) {
  const parsed = Number(String(value || "").replace(/[^\d-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFutbinPrice(value) {
  let text = normalize(value).toUpperCase();
  let multiplier = 1;
  if (text.endsWith("K")) { multiplier = 1000; text = text.slice(0, -1); }
  else if (text.endsWith("M")) { multiplier = 1000000; text = text.slice(0, -1); }
  const clean = [...text].filter((char) => /[\d.,]/.test(char)).join("").replace(",", ".");
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : 0;
}

function firstSrcSetUrl(srcset) {
  const first = String(srcset || "").split(",").map((value) => value.trim()).filter(Boolean)[0];
  return first ? first.split(/\s+/)[0] : null;
}
