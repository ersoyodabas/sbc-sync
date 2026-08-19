(function (global) {
  const FUTBIN_ORIGIN = "https://www.futbin.com";

  function normalizeText(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function normalizeDate(value) {
    const match = normalizeText(value).match(/\b(\d{4}-\d{2}-\d{2})\b/);
    return match ? match[1] : null;
  }

  function localDateString(date = new Date()) {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  }

  function parsePrice(value) {
    let text = normalizeText(value).toUpperCase().replace(/\s/g, "");
    if (!text || text === "-" || text === "N/A") return null;
    let multiplier = 1;
    if (text.endsWith("K")) { multiplier = 1_000; text = text.slice(0, -1); }
    else if (text.endsWith("M")) { multiplier = 1_000_000; text = text.slice(0, -1); }

    // FUTBIN uses both 1,500 and 1.5K forms. A separator followed by exactly
    // three digits is a thousands separator; otherwise it is decimal notation.
    const raw = text.replace(/[^\d.,-]/g, "");
    if (!raw) return null;
    const decimal = raw.replace(/[.,](?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
    const number = Number(decimal);
    return Number.isFinite(number) && number > 0 ? Math.round(number * multiplier) : null;
  }

  function parseRange(cell) {
    if (!cell) return { min: null, max: null, text: "" };
    const text = normalizeText(cell.textContent);
    const explicitMin = cell.querySelector(".pr-min, .min-price, [data-price='min'], [data-range='min']");
    const explicitMax = cell.querySelector(".pr-max, .max-price, [data-price='max'], [data-range='max']");
    if (explicitMin || explicitMax) {
      return {
        min: parsePrice(explicitMin?.textContent),
        max: parsePrice(explicitMax?.textContent),
        text
      };
    }
    const prices = text.match(/\d+(?:[.,]\d+)?\s*[KM]?/gi) || [];
    return { min: parsePrice(prices[0]), max: parsePrice(prices[1]), text };
  }

  function cellKey(cell) {
    return [cell.className, cell.getAttribute("data-label"), cell.getAttribute("aria-label")]
      .map(normalizeText).join(" ").toLowerCase();
  }

  function findCell(row, terms) {
    return [...row.querySelectorAll("td")].find((cell) => {
      const key = cellKey(cell);
      return terms.every((term) => key.includes(term));
    }) || null;
  }

  function normalizePlatform(value) {
    const text = normalizeText(value).toLowerCase();
    if (/\b(pc|computer|windows)\b/.test(text)) return "pc";
    if (/\b(cross|console|playstation|xbox|ps[45]?)\b/.test(text)) return "cross";
    return text || null;
  }

  function absoluteFutbinUrl(value) {
    try {
      const url = new URL(value || "", FUTBIN_ORIGIN);
      return (url.hostname === "futbin.com" || url.hostname.endsWith(".futbin.com")) ? url.href : null;
    } catch {
      return null;
    }
  }

  function playerIdFromUrl(value) {
    return Number(String(value || "").match(/\/player\/(\d+)/i)?.[1]) || null;
  }

  function playerNameFromUrl(value) {
    try {
      const parts = new URL(value, FUTBIN_ORIGIN).pathname.split("/").filter(Boolean);
      const playerIndex = parts.findIndex((part) => part === "player");
      const slug = parts[playerIndex + 2] || "";
      return decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
        .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("tr-TR")) || null;
    } catch {
      return null;
    }
  }

  function usablePlayerName(value) {
    const name = normalizeText(value);
    return name && !/^\d+$/.test(name) && !/^(view|player|futbin)$/i.test(name) ? name : null;
  }

  function imageUrl(node) {
    return node?.currentSrc || node?.src || node?.getAttribute("src") || null;
  }

  function parseRating(row) {
    const ratingNode = row.querySelector(".pr-rating, .rating-square, [class*='rating'], [data-rating]");
    const value = ratingNode?.getAttribute("data-rating") || ratingNode?.textContent || "";
    const rating = Number(String(value).match(/\d{1,3}/)?.[0]);
    return Number.isInteger(rating) && rating > 0 ? rating : null;
  }

  function priceRangeColumnMap(document) {
    const headers = [...document.querySelectorAll("thead th")];
    const indexFor = (terms) => headers.findIndex((header) => {
      const key = [header.textContent, header.className, header.getAttribute("data-label"), header.getAttribute("aria-label")]
        .map(normalizeText).join(" ").toLowerCase();
      return terms.every((term) => key.includes(term));
    });
    return {
      oldMin: indexFor(["old", "min"]),
      oldMax: indexFor(["old", "max"]),
      newMin: indexFor(["new", "min"]),
      newMax: indexFor(["new", "max"])
    };
  }

  function parseRow(row, columnMap = {}) {
    const playerCell = row.querySelector("td.pr-player");
    const link = playerCell?.querySelector("a[href*='/player/']") || row.querySelector(".pr-player a[href]");
    const playerUrl = absoluteFutbinUrl(link?.getAttribute("href"));
    const futbinPlayerId = playerIdFromUrl(playerUrl);
    const oldCell = findCell(row, ["old"]) || row.querySelector(".pr-old-range, .pr-range-old");
    const newCell = findCell(row, ["new"]) || row.querySelector(".pr-new-range, .pr-range-new");
    const rowCells = [...row.children].filter((cell) => cell.tagName === "TD");
    const oldMinCell = findCell(row, ["old", "min"]) || row.querySelector(".pr-old-min, .old-min-price, [data-price='old-min'], [data-range='old-min']") || rowCells[columnMap.oldMin];
    const oldMaxCell = findCell(row, ["old", "max"]) || row.querySelector(".pr-old-max, .old-max-price, [data-price='old-max'], [data-range='old-max']") || rowCells[columnMap.oldMax];
    const newMinCell = findCell(row, ["new", "min"]) || row.querySelector(".pr-new-min, .new-min-price, [data-price='new-min'], [data-range='new-min']") || rowCells[columnMap.newMin];
    const newMaxCell = findCell(row, ["new", "max"]) || row.querySelector(".pr-new-max, .new-max-price, [data-price='new-max'], [data-range='new-max']") || rowCells[columnMap.newMax];
    const platformCell = findCell(row, ["platform"]) || row.querySelector(".pr-platform");
    const playerImages = [...(playerCell?.querySelectorAll("img") || [])];
    const cardImage = playerImages.find((image) => /card|bg|background/i.test(image.className || "")) || playerImages[0] || null;
    const playerImage = playerImages.find((image) => /player|face|base/i.test(image.className || "")) || playerImages[1] || playerImages[0] || null;
    const parsedOldRange = parseRange(oldCell);
    const parsedNewRange = parseRange(newCell);
    const oldRange = {
      min: parsePrice(oldMinCell?.textContent) ?? parsedOldRange.min,
      max: parsePrice(oldMaxCell?.textContent) ?? parsedOldRange.max,
      text: parsedOldRange.text
    };
    const newRange = {
      min: parsePrice(newMinCell?.textContent) ?? parsedNewRange.min,
      max: parsePrice(newMaxCell?.textContent) ?? parsedNewRange.max,
      text: parsedNewRange.text
    };
    const updatedOn = normalizeDate(row.querySelector("td.pr-updated")?.textContent);
    const playerNameCandidates = [
      playerCell?.querySelector(".player-name, .pr-player-name, [data-player-name]")?.textContent,
      link?.getAttribute("data-player-name"),
      link?.getAttribute("data-name"),
      link?.getAttribute("title"),
      playerCell?.querySelector("img[alt]")?.getAttribute("alt"),
      link?.textContent,
      playerNameFromUrl(playerUrl)
    ];
    const playerName = playerNameCandidates.map(usablePlayerName).find(Boolean) || playerNameFromUrl(playerUrl);

    return {
      futbin_player_id: futbinPlayerId,
      player_name: playerName || null,
      player_url: playerUrl,
      rating: parseRating(row),
      position: normalizeText(row.querySelector(".pr-position, .table-pos, [data-position]")?.textContent) || null,
      version: normalizeText(row.querySelector(".pr-version, .table-version, [data-version-name]")?.textContent) || null,
      updated_on: updatedOn,
      old_min_price: oldRange.min,
      old_max_price: oldRange.max,
      new_min_price: newRange.min,
      new_max_price: newRange.max,
      platform: normalizePlatform(platformCell?.textContent || row.getAttribute("data-platform")),
      platform_label: normalizeText(platformCell?.textContent) || null,
      player_img_url: imageUrl(playerImage),
      card_img_url: imageUrl(cardImage),
      old_range_text: oldRange.text || null,
      new_range_text: newRange.text || null
    };
  }

  function parsePage(html, pageUrl) {
    const document = new DOMParser().parseFromString(String(html || ""), "text/html");
    const rows = [...document.querySelectorAll("tr.squad-row")];
    const columnMap = priceRangeColumnMap(document);
    const records = [];
    const errors = [];
    rows.forEach((row, index) => {
      try {
        const record = parseRow(row, columnMap);
        if (!record.futbin_player_id || !record.player_url || !record.updated_on) {
          throw new Error("futbin_player_id, player_url veya .pr-updated okunamadı");
        }
        records.push(record);
      } catch (error) {
        errors.push({ row: index + 1, message: error.message || String(error) });
      }
    });
    return { pageUrl, rowCount: rows.length, records, errors };
  }

  function parsePlayerDetail(html, playerUrl) {
    const document = new DOMParser().parseFromString(String(html || ""), "text/html");
    const psBox = document.querySelector(".price-box.platform-ps-only.price-box-original-player");
    const pcBox = document.querySelector(".price-box.platform-pc-only.price-box-original-player");
    const ps = parsePlatformPriceBox(psBox);
    const pc = parsePlatformPriceBox(pcBox);
    const futbinPlayerId = Number(psBox?.dataset.id || pcBox?.dataset.id || playerIdFromUrl(playerUrl)) || null;
    return {
      futbin_player_id: futbinPlayerId,
      player_name: normalizeText(document.querySelector(".playercard-26-name.text-ellipsis")?.textContent) || null,
      playerUrl: absoluteFutbinUrl(playerUrl),
      price_ps: ps.price,
      min_price_ps: ps.minPrice,
      max_price_ps: ps.maxPrice,
      price_updated_ps: ps.priceUpdated,
      price_pc: pc.price,
      min_price_pc: pc.minPrice,
      max_price_pc: pc.maxPrice,
      price_updated_pc: pc.priceUpdated
    };
  }

  function parsePlatformPriceBox(box) {
    if (!box) return { price: null, minPrice: null, maxPrice: null, priceUpdated: null };
    const priceNode = box.querySelector(".price.lowest-price-1, .lowest-price-1");
    // Match Latest's proven lookup: locate the container that directly owns
    // the "Price Range:" label, then parse its full range text.
    const range = priceRangeFromContainer(findPriceRangeContainer(box));
    const updatedText = normalizeText(box.querySelector(".prices-updated")?.textContent);
    return {
      // `lowest-price-1` is Futbin's semantic primary MARKET price element in
      // the original-player platform price box. Price Range is read separately.
      price: parsePrice(priceNode?.textContent),
      minPrice: range.min,
      maxPrice: range.max,
      priceUpdated: updatedText.replace(/^price\s*updated\s*:\s*/i, "") || null
    };
  }

  function findPriceRangeContainer(root) {
    if (!root) return null;

    return [...root.querySelectorAll("div")].find((node) =>
      [...node.children].some((child) => normalizeText(child.textContent) === "Price Range:"),
    ) || null;
  }

  function priceRangeFromContainer(container) {
    if (!container) return { min: null, max: null };

    const match = normalizeText(container.textContent).match(
      /([\d.,]+\s*[KM]?)\s*-\s*([\d.,]+\s*[KM]?)/i,
    );
    if (!match) return { min: null, max: null };

    return { min: parsePrice(match[1]), max: parsePrice(match[2]) };
  }

  function recordKey(record = {}) {
    return [
      record.futbin_player_id || "",
      record.platform || record.platform_label || "",
      record.updated_on || "",
      record.new_min_price ?? "",
      record.new_max_price ?? ""
    ].join("|");
  }

  global.FutbinPriceRangeParser = Object.freeze({
    parsePage,
    parseRow,
    parsePlayerDetail,
    parsePrice,
    normalizeDate,
    localDateString,
    recordKey,
    normalizePlatform,
    playerNameFromUrl
  });
})(globalThis);
