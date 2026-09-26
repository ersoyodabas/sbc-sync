chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "PARSE_FUTBIN_HTML") return;
  try { respond(parseDocument(message.html, message.pageUrl)); }
  catch (error) { respond({ players: [], totalPages: 1, errors: [error.message], confirmedEmpty: false }); }
});

function parseDocument(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = [...doc.querySelectorAll("tr.player-row")];
  const errors = [], players = [];
  rows.forEach((row, index) => { try { players.push(parsePlayerRow(row)); } catch (e) { errors.push(`Satır ${index + 1}: ${e.message}`); } });
  const emptyText = text(doc.querySelector(".no-results, .no-players, .empty-state")).toLowerCase();
  const result = { players, errors, totalPages: totalPages(doc), confirmedEmpty: !rows.length && /no results|oyuncu bulunamadı|no players/.test(emptyText), pageUrl };
  console.groupCollapsed(`[ImportantPlayersSync Parser] ${pageUrl}`);
  console.log("Satır sayısı:", rows.length);
  console.log("Parse edilen oyuncular:", players);
  console.log("Parse hataları:", errors);
  console.log("JSON:", JSON.stringify(result, null, 2));
  console.groupEnd();
  return result;
}
function totalPages(doc) {
  const nums = [...doc.querySelectorAll(".pagination-buttons-wrapper a.pagination-button")].map((a) => {
    const url = new URL(a.getAttribute("href") || "", "https://www.futbin.com");
    return Number(url.searchParams.get("page") || text(a));
  }).filter((n) => Number.isInteger(n) && n > 0);
  return Math.max(1, ...nums);
}
function parsePlayerRow(row) {
  const nameLink = row.querySelector("a.table-player-name[href]") || row.querySelector("td.table-name > a[href]");
  const playerLink = nameLink || row.querySelector("a.player-row-playercard");
  const url = absolute(playerLink?.getAttribute("href"));
  const id = Number(url.match(/\/player\/(\d+)/)?.[1]);
  if (!id) throw new Error("Futbin oyuncu ID/link okunamadı");
  const positionRaw = text(row.querySelector("td.table-pos"));
  const positions = positionRaw.replace(/\+\+/g, " ").split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^[A-Z]{1,3}$/.test(x));
  const clubLink = row.querySelector("a.table-player-club"), leagueLink = row.querySelector("a.table-player-league"), nationLink = row.querySelector("a.table-player-nation");
  const clubImg = clubLink?.querySelector("img") || row.querySelector("img[alt='Club']");
  const leagueImg = leagueLink?.querySelector("img") || row.querySelector("img[alt='League']");
  const nationImg = nationLink?.querySelector("img") || row.querySelector("td.table-name img.nation");
  const cardImg = row.querySelector("td.table-name img[class*='bg'], td.table-name img.playercard-s-26-bg");
  const playerImg = row.querySelector("td.table-name img[class*='special-img'], td.table-name img[src*='/img/players/'], td.table-name img[class*='base-img']");
  const footImageUrl = image(row.querySelector("td.table-foot img[src]"));
  const name = playerName(row, nameLink, playerImg);
  const fullName = playerFullName(row, nameLink, name);
  if (!name) throw new Error("Oyuncu ismi okunamadı");
  return {
    futbinPlayerId: id, futbinPlayerLink: url, name, fullName,
    rating: integer(text(row.querySelector("td.table-rating"))), positionName: positions[0] || "",
    alternativePositions: positions.slice(1), priceConsole: price(text(row.querySelector("td.table-price.platform-ps-only, td.platform-ps-only"))),
    pricePc: price(text(row.querySelector("td.table-price.platform-pc-only, td.platform-pc-only"))),
    nationName: title(nationImg), leagueName: title(leagueImg), clubName: title(clubImg),
    futbinRarityId: assetId(cardImg, /\/cards\/(?:tiny|hd)\/(\d+)_/i),
    futbinClubId: assetId(clubImg, /\/clubs\/(?:dark\/)?(\d+)\./i) || queryId(clubLink, "club"),
    futbinLeagueId: assetId(leagueImg, /\/league\/(?:dark\/)?(\d+)\./i) || queryId(leagueLink, "league"),
    futbinNationId: assetId(nationImg, /\/nation\/(\d+)\./i) || queryId(nationLink, "nation"),
    futbinCardRevision: text(row.querySelector(".table-player-revision")) || null,
    futbinItemScore: optionalInteger(text(row.querySelector("td.table-item-score"))),
    futbinFoot: footImageUrl.match(/\/foot-(left|right)\.svg(?:$|\?)/i)?.[1]?.toLowerCase() || null,
    futbinSkillMoves: optionalInteger(text(row.querySelector("td.table-skills"))),
    futbinWeakFoot: optionalInteger(text(row.querySelector("td.table-weak-foot"))),
    sourceDataAttributes: [row, ...row.querySelectorAll("*")].flatMap((node) => [...node.attributes]
      .filter((attribute) => attribute.name.startsWith("data-"))
      .map((attribute) => ({ element: node.tagName.toLowerCase(), name: attribute.name, value: attribute.value }))),
    cardImageAttributes: imageAttributes(cardImg), playerImageAttributes: imageAttributes(playerImg),
    cardImageUrl: image(cardImg), playerImageUrl: image(playerImg),
    extractedPlayerImageId: extractPlayerImageId(image(playerImg)),
    nationImageUrl: image(nationImg), leagueImageUrl: image(leagueImg), clubImageUrl: image(clubImg)
  };
}
function extractPlayerImageId(value) {
  try {
    const path = new URL(String(value || ""), "https://www.futbin.com").pathname;
    const match = path.match(/\/img\/players\/(\d+)\.png$/i);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}
function playerName(row, nameLink, playerImg) {
  return cleanPlayerName(
    attr(playerImg, "alt") ||
    attr(playerImg, "title") ||
    attr(row.querySelector("img[class*='base-img'], img[class*='special-img'], img[src*='/img/players/']"), "alt") ||
    attr(nameLink, "title") ||
    attr(nameLink, "aria-label") ||
    playerLinkText(nameLink)
  );
}
function playerFullName(row, nameLink, fallback) {
  return cleanPlayerName(
    playerLinkText(nameLink) ||
    attr(row.querySelector("a.table-player-name"), "title") ||
    fallback
  ) || fallback;
}
function playerLinkText(node) {
  if (!node) return "";
  const clone = node.cloneNode(true);
  clone.querySelectorAll("img, svg, .rating-square, .table-rating, [class*='rating'], .table-pos, [class*='price']").forEach((child) => child.remove());
  return text(clone);
}
function cleanPlayerName(value) {
  return String(value || "")
    .replace(/\b(?:[4-9]\d|1\d{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function price(value) {
  const token = String(value || "").toUpperCase().match(/(?:\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*[KM]?/i)?.[0];
  if (!token) return 0; let raw = token.replace(/\s/g, ""), mult = 1;
  if (raw.endsWith("K")) { mult = 1e3; raw = raw.slice(0, -1); } else if (raw.endsWith("M")) { mult = 1e6; raw = raw.slice(0, -1); }
  if (mult > 1) raw = raw.replace(",", "."); else if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, "");
  return Math.round((Number(raw) || 0) * mult);
}
function queryId(node, key) { try { return Number(new URL(node?.getAttribute("href") || "", "https://www.futbin.com").searchParams.get(key)); } catch { return 0; } }
function assetId(node, pattern) { return Number(image(node).match(pattern)?.[1]) || 0; }
function image(node) { return absolute(node?.getAttribute("src") || node?.getAttribute("data-src") || String(node?.getAttribute("srcset") || "").split(",")[0].trim().split(/\s+/)[0]); }
function imageAttributes(node) {
  if (!node) return null;
  return Object.fromEntries(["alt", "class", "src", "srcset", "title"].filter((name) => node.hasAttribute(name))
    .map((name) => [name, node.getAttribute(name)]));
}
function absolute(value) { try { return new URL(value || "", "https://www.futbin.com").href; } catch { return ""; } }
function title(node) { return text({ textContent: node?.getAttribute("title") || node?.getAttribute("alt") }); }
function text(node) { return String(node?.textContent || "").trim().replace(/\s+/g, " "); }
function attr(node, name) { return String(node?.getAttribute(name) || "").trim(); }
function integer(value) { return Number(String(value || "").match(/\d+/)?.[0]) || 0; }
function optionalInteger(value) { const match = String(value || "").match(/\d+/); return match ? Number(match[0]) : null; }
