import { FUTBIN_CHALLENGE_MAX_WAIT_MS, futbinChallengeTimeoutError, isFutbinChallengeHtml } from "../futbin/challenge.js";

const STATE_KEY = "filteredPlayersSyncState";
const ALARM = "filtered-players-hourly";
const SOURCE_URL = "https://www.futbin.com/26/players?ps_price=300-45000&player_rating=82-95&sort=Player_Rating&order=asc&eUnt=1";
const API_CONFIG = globalThis.FutbinSyncApiConfig;
const PAGE_BATCH_SIZE = 5;
const REQUEST_DELAY_MS = 5000;
const FUTBIN_TARGET_DOM_MAX_WAIT_MS = 60000;
const LOOP_DELAY_MS = 60 * 60 * 1000;
const SINGLE_PAGE_DEBUG_MODE = false;
let activeController = null;
let runToken = 0;
let networkPort = null;
let networkTabId = null;
let networkRequestId = 0;
const networkPending = new Map();
let activeFetchTabId = null;
let cancelActiveTabWait = null;
const activeRequestControllers = new Set();
const pendingDelayResolvers = new Map();
const FINISHED_STATUS = "Finished";
const FC_SYNC_ENABLED_KEY = "fcSyncEnabled";

const initialState = {
  runnerId: "filtered-players", running: false, status: "Hazır", sourceUrl: SOURCE_URL,
  apiBaseUrl: "", currentPage: 0, totalPages: 0, pagesAttempted: 0,
  pagesSucceeded: 0, parsedPlayers: 0, mappedPlayers: 0, skippedPlayers: 0,
  savedPlayers: 0, insertedPlayers: 0, updatedPlayers: 0, errors: [], nextRunAt: null,
  startedAt: null, completedAt: null, updatedAt: null, logs: [], roundNumber: 0,
  waitingForNextRun: false, runOnce: false, centralManaged: false, centralRunId: null,
  awaitingFutbinVerification: false,
  futbinChallengeDetectedAt: null,
  futbinChallengeTabId: null,
  futbinChallengeUrl: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  await chrome.alarms.clear(ALARM);
  await setState({ ...(saved || initialState), apiBaseUrl: defaultApiBaseUrl(), running: false, waitingForNextRun: false, nextRunAt: null, status: "Hazır - merkezi başlatma bekleniyor" });
});
chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  if (state.runOnce || state.centralManaged || !await isFcSyncEnabled()) {
    await chrome.alarms.clear(ALARM);
    await setState({ ...state, running: false, waitingForNextRun: false, nextRunAt: null, status: "Hazır - merkezi başlatma bekleniyor" });
    return;
  }
  if (isFinishedState(state)) {
    await chrome.alarms.clear(ALARM);
    return;
  }
  if (!state.running && !state.nextRunAt) return;
  if (!state.running) await patchState({ running: true, waitingForNextRun: true, status: "Yeni tur bekleniyor" });
  if (state.waitingForNextRun && state.nextRunAt > Date.now()) await ensureAlarm();
  else {
    await patchState({ waitingForNextRun: true, nextRunAt: null, status: "Yarım kalan tur yeniden başlatılıyor" });
    await startSync({ scheduled: true });
  }
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  if (!await isFcSyncEnabled()) {
    await chrome.alarms.clear(ALARM);
    return;
  }
  const state = await getState();
  if (!state.running || !state.waitingForNextRun || !state.nextRunAt || isFinishedState(state)) {
    await chrome.alarms.clear(ALARM);
    return;
  }
  await startSync({ scheduled: true });
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.futbinSyncModule !== "important") return false;
  handleMessage(message).then(respond).catch((error) => respond({ ok: false, error: error.message }));
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "important-players-network") return;
  networkPort = port;
  networkTabId = port.sender?.tab?.id ?? networkTabId;
  port.onMessage.addListener((message) => {
    const pending = networkPending.get(message?.id);
    if (!pending) return;
    networkPending.delete(message.id);
    clearTimeout(pending.timeout);
    importantConsole("Network monitor API response", {
      id: message.id,
      ok: message.ok,
      status: message.status,
      responseOk: message.responseOk,
      data: message.data,
      error: message.error
    });
    message.ok ? pending.resolve(message) : pending.reject(new Error(message.error || "API request başarısız"));
  });
  port.onDisconnect.addListener(() => {
    if (networkPort !== port) return;
    networkPort = null;
    for (const pending of networkPending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Network Monitor sekmesi kapandı."));
    }
    networkPending.clear();
  });
});

globalThis.FutbinSyncModuleControls = globalThis.FutbinSyncModuleControls || {};
globalThis.FutbinSyncModuleControls.important = {
  getSnapshot: async () => ({ ok: true, state: await getState() }),
  start: async (options = {}) => startSync({ ...options, apiBaseUrl: options.apiBaseUrl || defaultApiBaseUrl() }),
  stop: stopSync,
  startAfterLatest: async () => {
    await API_CONFIG.ready;
    const state = await getState();
    if (state.running || state.waitingForNextRun || state.nextRunAt) {
      return { ok: true, skipped: true, reason: "already-active", state };
    }
    await appendLog("Latest Player Sync tamamlandı; Important Players otomatik başlatılıyor.");
    return startSync({ apiBaseUrl: defaultApiBaseUrl(), runOnce: true });
  }
};

async function handleMessage(message) {
  await API_CONFIG.ready;
  if (message?.type === "GET_SNAPSHOT") return { ok: true, state: await getState() };
  if (message?.type === "START_SYNC") return startSync({ apiBaseUrl: message.apiBaseUrl, runOnce: true });
  if (message?.type === "STOP_SYNC") return stopSync();
  if (message?.type === "CLEAR_SYNC") {
    await stopSync();
    await setState({ ...initialState, apiBaseUrl: normalizeApi(message.apiBaseUrl || defaultApiBaseUrl()) });
    return { ok: true };
  }
  if (message?.type === "OPEN_NETWORK_MONITOR") {
    const tab = await ensureNetworkMonitor(true);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  }
  if (message?.type === "PARSE_FUTBIN_HTML_RESULT") return { ok: true };
  return { ok: false, error: "Bilinmeyen mesaj" };
}

async function startSync({ scheduled = false, apiBaseUrl: rawApiBaseUrl, runOnce = false, centralManaged = false, centralRunId = null } = {}) {
  if (!centralManaged && await isFcSyncEnabled()) {
    return { ok: false, error: "Merkezi sync çalışırken tekil Important Players başlatılamaz." };
  }
  const existing = await getState();
  if (scheduled && isFinishedState(existing)) return { ok: false, finished: true, state: existing };
  if (existing.running && !existing.waitingForNextRun) return { ok: true, state: existing, alreadyRunning: true };
  const token = ++runToken;
  const apiBaseUrl = allowedApiBaseUrl(rawApiBaseUrl || existing.apiBaseUrl || defaultApiBaseUrl());
  const startedAt = Date.now();
  const roundNumber = (Number(existing.roundNumber) || 0) + 1;
  await setState({ ...initialState, running: true, waitingForNextRun: false, runOnce, centralManaged, centralRunId, roundNumber,
    status: `${roundNumber}. tur başladı`, apiBaseUrl, startedAt, updatedAt: Date.now(),
    logs: [...(existing.logs || []), logEntry(`${roundNumber}. çalışma turu başladı · API: ${apiBaseUrl}`)].slice(-500) });
  runSync(token, apiBaseUrl).catch((error) => failRun(token, error));
  return { ok: true, scheduled, state: await getState() };
}

async function runSync(token, apiBaseUrl) {
  importantConsole("Run started", { apiBaseUrl, sourceUrl: SOURCE_URL });
  await appendLog("API lookup GET yapılmayacak; mapping Futbin raw ID'leriyle POST tarafında çözülecek");
  const sentPlayerIds = new Set();
  let batchPlayers = new Map();
  let batchErrors = [];
  let batchPageFrom = 1;
  let parsedTotal = 0, mappedTotal = 0, skippedTotal = 0;
  let saved = 0, inserted = 0, updated = 0;
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    assertActive(token);
    await patchState({ currentPage: page, totalPages, pagesAttempted: page, status: `Futbin sayfası okunuyor: ${page} / ${totalPages}` });
    const parsed = await fetchAndParsePage(page, token);
    importantConsole(`Futbin page ${page} parse result`, {
      page,
      totalPages: parsed.totalPages,
      confirmedEmpty: parsed.confirmedEmpty,
      errors: parsed.errors,
      playerCount: parsed.players.length,
      players: parsed.players
    });
    if (page === 1) totalPages = SINGLE_PAGE_DEBUG_MODE ? 1 : parsed.totalPages;
    if (!parsed.players.length && !parsed.confirmedEmpty) throw new Error(`Sayfa ${page} oyuncu içermiyor; sonuç güvenli kabul edilmedi.`);
    parsedTotal += parsed.players.length;
    for (const raw of parsed.players) {
      const playerId = String(raw.futbinPlayerId);
      if (sentPlayerIds.has(playerId)) continue;
      try {
        const mapped = toPayloadPlayer(raw);
        batchPlayers.set(playerId, preferPlayer(batchPlayers.get(playerId), mapped));
      } catch (error) {
          importantConsole("Mapping error", {
            error: error.message,
            rawPlayer: raw,
            extractedIds: {
            futbinNationId: raw.futbinNationId,
            futbinLeagueId: raw.futbinLeagueId,
            futbinClubId: raw.futbinClubId,
            futbinRarityId: raw.futbinRarityId
          }
        });
        batchErrors.push({
          player: raw.name || raw.fullName || "(isimsiz)",
          futbin_player_id: raw.futbinPlayerId,
          futbin_club_id: raw.futbinClubId,
          futbin_league_id: raw.futbinLeagueId,
          futbin_nation_id: raw.futbinNationId,
          futbin_rarity_id: raw.futbinRarityId,
          position_name: raw.positionName,
          quality_code: inferQualityCode(raw, inferRarity(raw)),
          futbin_player_link: raw.futbinPlayerLink,
          message: error.message
        });
      }
    }
    const state = await getState();
    await patchState({ totalPages, pagesSucceeded: page, parsedPlayers: parsedTotal, errors: [...state.errors, ...parsed.errors] });
    await appendLog(`Futbin ${page}/${totalPages}: ${parsed.players.length} oyuncu çekildi · batch ${batchPlayers.size} mapped`);

    const batchReady = SINGLE_PAGE_DEBUG_MODE || page - batchPageFrom + 1 === PAGE_BATCH_SIZE || page === totalPages;
    if (batchReady) {
      assertActive(token);
      const players = [...batchPlayers.values()];
      mappedTotal += players.length;
      skippedTotal += batchErrors.length;
      const batchState = await getState();
      await patchState({ mappedPlayers: mappedTotal, skippedPlayers: skippedTotal, errors: [...batchState.errors, ...batchErrors], status: `Sayfa ${batchPageFrom}-${page} API'ye gönderiliyor` });
      await appendLog(`Sayfa ${batchPageFrom}-${page}: ${players.length} oyuncu API için hazır · ${batchErrors.length} atlandı`);
      await delay(REQUEST_DELAY_MS);
      const body = {
        page_from: batchPageFrom, page_to: page, pages_attempted: page - batchPageFrom + 1,
        pages_succeeded: page - batchPageFrom + 1, players, sync_mode: "filtered_partial",
      disable_missing_delete: true, source: "futbin_filtered_players", source_url: SOURCE_URL,
      filter: { ps_price: "300-45000", player_rating: "82-95" }
      };
      importantConsole(`API POST payload pages ${batchPageFrom}-${page}`, body);
      let response;
      try {
        response = await apiRequestWithRetry(apiBaseUrl, "sync/futbin-player-clubs", {
          method: "POST", body: JSON.stringify(body)
        }, token, batchPageFrom, page);
      } catch (error) {
        const failedPlayers = players.map((player) => ({
          player: player.name || player.full_name || "(isimsiz)",
          futbin_player_id: player.futbin_player_id,
          futbin_club_id: player.futbin_club_id,
          futbin_league_id: player.futbin_league_id,
          futbin_nation_id: player.futbin_nation_id,
          futbin_rarity_id: player.futbin_rarity_id,
          position_name: player.position_name,
          quality_code: player.quality_code,
          futbin_player_link: player.futbin_player_link || player.url,
          message: `Sayfa ${batchPageFrom}-${page} API batch gönderimi başarısız: ${error.message}`
        }));
        skippedTotal += failedPlayers.length;
        const failedState = await getState();
        await patchState({
          skippedPlayers: skippedTotal,
          errors: [...failedState.errors, ...failedPlayers],
          status: `Sayfa ${batchPageFrom}-${page} atlandı; işleme devam ediliyor`
        });
        batchPlayers = new Map();
        batchErrors = [];
        batchPageFrom = page + 1;
        if (page < totalPages) await delay(REQUEST_DELAY_MS);
        continue;
      }
      importantConsole(`API POST response pages ${batchPageFrom}-${page}`, response);
      saved += Number(response?.data?.saved) || 0;
      inserted += Number(response?.data?.inserted) || 0;
      updated += Number(response?.data?.updated) || 0;
      skippedTotal += Number(response?.data?.skipped) || 0;
      players.forEach((player) => sentPlayerIds.add(String(player.futbin_player_id)));
      const responseState = await getState();
      const apiIssues = formatApiIssues(response?.data?.errors || [], players);
      await patchState({ savedPlayers: saved, insertedPlayers: inserted, updatedPlayers: updated, skippedPlayers: skippedTotal, errors: [...responseState.errors, ...apiIssues] });
      await appendLog(`API sayfa ${batchPageFrom}-${page}: ${players.length} gönderildi · saved ${response?.data?.saved || 0} · insert ${response?.data?.inserted || 0} · update ${response?.data?.updated || 0} · skip ${response?.data?.skipped || 0}`);
      batchPlayers = new Map();
      batchErrors = [];
      batchPageFrom = page + 1;
    }
    if (page < totalPages) await delay(REQUEST_DELAY_MS);
  }
  assertActive(token);
  if (SINGLE_PAGE_DEBUG_MODE) {
    await chrome.alarms.clear(ALARM);
    await appendLog(`Tek sayfa debug işlemi tamamlandı · çekilen ${parsedTotal} · API'ye gönderilen ${saved} · insert ${inserted} · update ${updated} · işlemler durduruldu`);
    await closeWorkingTabs();
    const finished = await patchState({ running: false, status: "Tek sayfa tamamlandı — durduruldu", completedAt: Date.now(), nextRunAt: null });
    if (finished.centralManaged) await notifyCentralRoundFinished(finished, true);
    return;
  }
  const completedState = await getState();
  const oneShot = Boolean(completedState.runOnce || completedState.centralManaged);
  const nextRunAt = oneShot ? null : Date.now() + LOOP_DELAY_MS;
  if (!await isActiveRun(token)) return;
  await closeWorkingTabs();
  if (nextRunAt) await chrome.alarms.create(ALARM, { when: nextRunAt }); else await chrome.alarms.clear(ALARM);
  if (!await isActiveRun(token)) {
    await chrome.alarms.clear(ALARM);
    return;
  }
  const state = await getState();
  await appendLog(oneShot
    ? `${state.roundNumber}. tur tamamlandı · çekilen ${parsedTotal} · API'ye gönderilen ${saved} · insert ${inserted} · update ${updated}`
    : `${state.roundNumber}. tur tamamlandı · çekilen ${parsedTotal} · API'ye gönderilen ${saved} · insert ${inserted} · update ${updated} · sonraki tur 1 saat sonra`);
  const finished = await patchState({ running: !oneShot, waitingForNextRun: !oneShot, status: oneShot ? "Finished" : `${state.roundNumber}. tur tamamlandı — yeni tur bekleniyor`, completedAt: Date.now(), nextRunAt });
  if (finished.centralManaged) await notifyCentralRoundFinished(finished, true);
}

async function fetchAndParsePage(page, token) {
  const url = new URL(SOURCE_URL); url.searchParams.set("page", String(page));
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assertActive(token); activeController = new AbortController();
    try {
      importantConsole(`Futbin request page ${page} attempt ${attempt}`, {
        method: "GET",
        url: url.href,
        credentials: "include",
        cache: "no-store"
      });
      const response = await fetch(url.href, { credentials: "include", cache: "no-store", signal: activeController.signal });
      importantConsole(`Futbin response page ${page} attempt ${attempt}`, {
        url: url.href,
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        responseUrl: response.url,
        contentType: response.headers.get("content-type")
      });
      if (response.status === 403 || response.status === 429) return fetchViaTab(url.href, token);
      if (!response.ok) throw new Error(`Futbin HTTP ${response.status}: ${url.href}`);
      const html = await response.text();
      importantConsole(`Futbin HTML page ${page} attempt ${attempt}`, htmlSummary(html));
      if (html.length < 1000) throw new Error(`Futbin HTML yanıtı çok küçük: ${url.href}`);
      const parsed = await parseHtml(html, url.href);
      assertActive(token);
      return parsed;
    } catch (error) {
      importantConsole(`Futbin request failed page ${page} attempt ${attempt}`, {
        url: url.href,
        error: error.message || String(error),
        stack: error.stack
      });
      lastError = error; if (error.name === "AbortError") throw error;
      if (attempt < 3) await delay(REQUEST_DELAY_MS);
    } finally { activeController = null; }
  }
  throw lastError;
}

async function fetchViaTab(url, token) {
  assertActive(token);
  importantConsole("Futbin tab fallback request", { method: "TAB", url });
  await appendLog(`Futbin sekmesi açılıyor: ${url}`);
  const tab = await chrome.tabs.create({ url, active: false });
  await appendLog(`Futbin sekmesi açıldı · tab ${tab.id || "--"}`);
  activeFetchTabId = tab.id;
  try {
    await appendLog(`Futbin hedef DOM polling başladı · tab ${tab.id || "--"}`);
    assertActive(token);
    const html = await waitForFutbinTabHtml(tab.id, url, token);
    importantConsole("Futbin tab fallback HTML", { url, ...htmlSummary(html) });
    await appendLog(`Futbin hedef HTML okundu · ${String(html || "").length} karakter`);
    if (!html || html.length < 1000) throw new Error(`Futbin sekme HTML yanıtı geçersiz: ${url}`);
    const parsed = await parseHtml(html, url);
    assertActive(token);
    return parsed;
  } finally {
    cancelActiveTabWait = null;
    activeFetchTabId = null;
    await appendLog(`Futbin sekmesi kapatılıyor · tab ${tab.id || "--"}`);
    await closeImportantTab(tab.id);
  }
}

async function waitForFutbinTabHtml(tabId, url, token) {
  const startedAt = Date.now();
  let deadline = startedAt + FUTBIN_TARGET_DOM_MAX_WAIT_MS;
  let challengeLogged = false;
  let challengeDetectedAt = null;
  let lastHtml = "";
  let lastError = null;
  let cancelled = false;
  cancelActiveTabWait = () => {
    cancelled = true;
  };
  while (Date.now() < deadline) {
    if (cancelled) throw new DOMException("Sync finished", "AbortError");
    assertActive(token);
    try {
      lastHtml = await readTabOuterHtml(tabId);
      lastError = null;
    } catch (error) {
      lastError = error;
      await delay(250);
      continue;
    }
    const status = futbinHtmlReadiness(lastHtml);
    if (status.ready) {
      if (challengeLogged) await setFutbinVerificationState(token, { resolved: true });
      await appendLog(`Futbin hedef DOM hazır · ${String(lastHtml || "").length} karakter`);
      return lastHtml;
    }
    if (status.cloudflare && !challengeLogged) {
      challengeLogged = true;
      challengeDetectedAt = Date.now();
      deadline = challengeDetectedAt + FUTBIN_CHALLENGE_MAX_WAIT_MS;
      await focusFutbinChallengeTab(tabId);
      await setFutbinVerificationState(token, { waiting: true, tabId, url, detectedAt: challengeDetectedAt });
      importantConsole("Futbin Cloudflare doğrulaması algılandı; hedef HTML bekleniyor", {
        url,
        tabId,
        maxWaitMs: FUTBIN_CHALLENGE_MAX_WAIT_MS
      });
      await appendLog(`Futbin Cloudflare doğrulaması algılandı; açık sekmede doğrulama bekleniyor · ${url}`);
    }
    await delay(250);
  }
  cancelActiveTabWait = null;
  const status = futbinHtmlReadiness(lastHtml);
  if (challengeLogged) await setFutbinVerificationState(token, { waiting: false });
  if (lastError && !lastHtml) throw lastError;
  throw new Error(status.cloudflare
    ? futbinChallengeTimeoutError(url)
    : `Futbin hedef HTML 60 saniye içinde okunamadı: ${url}`);
}

async function focusFutbinChallengeTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    importantConsole("Futbin doğrulama sekmesi öne getirilemedi", { tabId, error: error.message || String(error) });
  }
}

async function setFutbinVerificationState(token, { waiting = false, tabId = null, url = null, detectedAt = null, resolved = false } = {}) {
  if (!await isActiveRun(token)) return;
  const patch = {
    awaitingFutbinVerification: waiting,
    futbinChallengeDetectedAt: waiting ? detectedAt : null,
    futbinChallengeTabId: waiting ? tabId : null,
    futbinChallengeUrl: waiting ? url : null
  };
  if (waiting) patch.status = "Futbin doğrulaması bekleniyor — açık sekmede devam edin";
  if (resolved) patch.status = "Futbin doğrulaması tamamlandı; işleme devam ediliyor";
  await patchState(patch);
}

async function readTabOuterHtml(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML
  });
  return results?.[0]?.result || "";
}

function futbinHtmlReadiness(html) {
  const text = String(html || "");
  const cloudflare = isFutbinChallengeHtml(text);
  const targetDomReady = /table[^>]+class=["'][^"']*players-table|tr[^>]+class=["'][^"']*player-row|class=["'][^"']*table-player-name|class=["'][^"']*selected-filters-wrapper|class=["'][^"']*pagination-buttons-wrapper/i.test(text);
  return {
    cloudflare,
    targetDomReady,
    ready: targetDomReady
  };
}

async function parseHtml(html, pageUrl) {
  await ensureOffscreen();
  importantConsole("Parse HTML request", { pageUrl, ...htmlSummary(html) });
  const parsed = await chrome.runtime.sendMessage({ type: "PARSE_FUTBIN_HTML", html, pageUrl });
  importantConsole("Parse HTML response", {
    pageUrl,
    totalPages: parsed?.totalPages,
    confirmedEmpty: parsed?.confirmedEmpty,
    playerCount: Array.isArray(parsed?.players) ? parsed.players.length : 0,
    errors: parsed?.errors || [],
    players: parsed?.players || []
  });
  return parsed;
}
async function ensureOffscreen() {
  const url = chrome.runtime.getURL("src/offscreen.html");
  if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length) return;
  try {
    await chrome.offscreen.createDocument({ url: "src/offscreen.html", reasons: ["DOM_SCRAPING"], justification: "Futbin HTML oyuncu listelerini ayrıştırmak" });
  } catch (error) {
    if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length) return;
    throw error;
  }
}

function toPayloadPlayer(raw) {
  const rarityInfo = inferRarity(raw);
  const qualityCode = inferQualityCode(raw, rarityInfo);
  const name = cleanPayloadPlayerName(raw.name);
  const fullName = cleanPayloadPlayerName(raw.fullName || raw.name) || name;
  for (const [label, value] of [
    ["futbin_player_id", raw.futbinPlayerId],
    ["futbin_club_id", raw.futbinClubId],
    ["futbin_league_id", raw.futbinLeagueId],
    ["futbin_nation_id", raw.futbinNationId],
    ["name", name],
    ["full_name", fullName],
    ["rating", raw.rating],
    ["position_name", raw.positionName],
    ["quality_code", qualityCode]
  ]) {
    if (value === null || value === undefined || value === "" || Number(value) === 0) {
      throw new Error(`${label} okunamadı`);
    }
  }
  if (rarityInfo.futbinId === null || rarityInfo.futbinId === undefined || Number.isNaN(Number(rarityInfo.futbinId))) {
    throw new Error("futbin_rarity_id okunamadı");
  }
  return {
    futbin_club_id: Number(raw.futbinClubId),
    futbin_league_id: Number(raw.futbinLeagueId),
    futbin_nation_id: Number(raw.futbinNationId),
    futbin_rarity_id: Number(rarityInfo.futbinId),
    name,
    full_name: fullName,
    rating: raw.rating,
    futbin_player_id: raw.futbinPlayerId,
    futbin_player_link: raw.futbinPlayerLink,
    url: raw.futbinPlayerLink,
    url_img_player: raw.playerImageUrl,
    price_console: raw.priceConsole,
    price_pc: raw.pricePc,
    url_img_card: raw.cardImageUrl,
    url_img_nation: raw.nationImageUrl,
    url_img_league: raw.leagueImageUrl,
    url_img_club: raw.clubImageUrl,
    position_name: raw.positionName,
    quality_code: qualityCode,
    nation_name: raw.nationName,
    league_name: raw.leagueName,
    club_name: raw.clubName,
    alternative_positions: (raw.alternativePositions || []).join(","),
    active: true
  };
}
function cleanPayloadPlayerName(value) {
  const normalized = String(value || "")
    .replace(/\b(?:[4-9]\d|1\d{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[A-Za-zÀ-ž]/.test(normalized) ? normalized : "";
}
function inferRarity(raw) {
  const file = String(raw.cardImageUrl || "").split("/").pop()?.split("?")[0] || "";
  const match = file.match(/^(\d+)_([^.]*)/);
  const futbinId = Number(raw.futbinRarityId || match?.[1]);
  return { futbinId, cardCode: String(match?.[2] || "").toLowerCase() };
}
function inferQualityCode(raw, rarityInfo) {
  if (rarityInfo.futbinId !== 0 && rarityInfo.futbinId !== 1) return "special";
  return rarityInfo.cardCode.match(/^(bronze|silver|gold)/)?.[1] || (raw.rating >= 75 ? "gold" : raw.rating >= 65 ? "silver" : "bronze");
}
function preferPlayer(old, next) { if (!old) return next; return (next.price_console || next.price_pc || next.priceConsole || next.pricePc) ? next : old; }
function assertActive(token) { if (token !== runToken) throw new DOMException("Sync finished", "AbortError"); }
async function isActiveRun(token) { const state = await getState(); return Boolean(token === runToken && state.running && !isFinishedState(state)); }
function isFinishedState(state) { return !state?.running && state?.status === FINISHED_STATUS; }
async function isFcSyncEnabled() { return Boolean((await chrome.storage.local.get(FC_SYNC_ENABLED_KEY))[FC_SYNC_ENABLED_KEY]); }
async function stopSync() {
  await cancelActiveWork("Sync finished");
  await patchState({
    running: false,
    runOnce: false,
    centralManaged: false,
    centralRunId: null,
    waitingForNextRun: false,
    awaitingFutbinVerification: false,
    futbinChallengeDetectedAt: null,
    futbinChallengeTabId: null,
    futbinChallengeUrl: null,
    status: "Hazır",
    nextRunAt: null
  });
  return { ok: true };
}

async function cancelActiveWork(reason = "Sync finished") {
  runToken++;
  activeController?.abort();
  activeController = null;
  activeRequestControllers.forEach((controller) => controller.abort());
  activeRequestControllers.clear();
  cancelActiveTabWait?.();
  cancelActiveTabWait = null;
  cancelPendingDelays();
  for (const [id, pending] of networkPending) {
    clearTimeout(pending.timeout);
    pending.reject(new DOMException(reason, "AbortError"));
    networkPending.delete(id);
  }
  await closeWorkingTabs();
  await chrome.alarms.clear(ALARM);
}

async function closeWorkingTabs() {
  const tabIds = [...new Set([activeFetchTabId, networkTabId].filter((tabId) => Number.isInteger(Number(tabId))))];
  activeFetchTabId = null;
  networkPort?.disconnect();
  networkPort = null;
  networkTabId = null;
  await Promise.all(tabIds.map((tabId) => closeImportantTab(tabId)));
}

async function closeImportantTab(tabId) {
  if (!Number.isInteger(Number(tabId))) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await chrome.tabs.remove(tabId); } catch { /* Sekme zaten kapalı olabilir. */ }
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return true;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await appendLog(`Çalışma sekmesi kapatılamadı · tab ${tabId}`);
  return false;
}
async function failRun(token, error) {
  if (!await isActiveRun(token)) return;
  importantConsole("Run failed", {
    error: error.message || String(error),
    stack: error.stack
  });
  const stateBeforeFailure = await getState();
  const oneShot = Boolean(stateBeforeFailure.runOnce || stateBeforeFailure.centralManaged);
  const nextRunAt = oneShot || SINGLE_PAGE_DEBUG_MODE ? null : Date.now() + LOOP_DELAY_MS;
  await closeWorkingTabs();
  if (nextRunAt) await chrome.alarms.create(ALARM, { when: nextRunAt }); else await chrome.alarms.clear(ALARM);
  if (!await isActiveRun(token)) { await chrome.alarms.clear(ALARM); return; }
  const state = await getState();
  const failed = await patchState({ running: !!nextRunAt, waitingForNextRun: !!nextRunAt, status: nextRunAt ? `Tur tamamlanamadı — yeniden deneme bekleniyor` : "Tur tamamlanamadı", errors: [...state.errors, error.message], logs: [...(state.logs || []), logEntry(`${state.roundNumber || 1}. tur tamamlanamadı${nextRunAt ? " · sonraki tur planlandı" : ""}`)].slice(-500), nextRunAt });
  if (failed.centralManaged) await notifyCentralRoundFinished(failed, false);
}
function notifyCentralRoundFinished(state, ok) {
  const message = { futbinSyncModule: "fc-sync", type: "MODULE_ROUND_FINISHED", module: "important", runId: state.centralRunId, ok, error: ok ? null : state.status };
  const directOrchestrator = globalThis.FutbinSyncCentralOrchestrator;
  if (typeof directOrchestrator?.moduleRoundFinished === "function") {
    void directOrchestrator.moduleRoundFinished(message);
    return;
  }
  chrome.runtime.sendMessage(message).catch(() => {
    // Merkezi background yeniden başlatılmış olabilir; stale olay merkezi runId ile yok sayılır.
  });
}
async function ensureAlarm() { const state = await getState(); if (await isFcSyncEnabled() && state.running && !isFinishedState(state) && state.nextRunAt > Date.now()) await chrome.alarms.create(ALARM, { when: state.nextRunAt }); else await chrome.alarms.clear(ALARM); }
async function apiRequest(base, path, options = {}) {
  await API_CONFIG.ready;
  void base;
  const url = new URL(path, API_CONFIG.defaultBaseUrl()).href;
  importantConsole("API request", {
    method: options.method || "GET",
    url,
    body: parseJsonForDebug(options.body)
  });
  const result = await networkApiRequest(url, options);
  importantConsole("API response", {
    method: options.method || "GET",
    url,
    status: result.status,
    ok: result.responseOk,
    data: result.data
  });
  if (!result.responseOk || result.data?.result === false) throw new Error(result.data?.message || `API HTTP ${result.status}`);
  return result.data;
}
async function apiRequestWithRetry(base, path, options, token, pageFrom, pageTo) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assertActive(token);
    await patchState({ status: `Sayfa ${pageFrom}-${pageTo} API'ye gönderiliyor · deneme ${attempt}/3` });
    try {
      const response = await apiRequest(base, path, options);
      assertActive(token);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(REQUEST_DELAY_MS);
    }
  }
  throw lastError;
}
async function networkApiRequest(url, options = {}) {
  if (!networkPort) {
    importantConsole("API request transport", { url, transport: "direct-fetch" });
    return directApiRequest(url, options);
  }
  const id = ++networkRequestId;
  importantConsole("API request transport", { id, url, transport: "network-monitor" });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { networkPending.delete(id); reject(new Error(`API timeout (30 sn): ${url}`)); }, 30000);
    networkPending.set(id, { resolve, reject, timeout });
    networkPort.postMessage({ id, url, method: options.method || "GET", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, body: options.body });
  });
}
async function directApiRequest(url, options = {}) {
  const controller = new AbortController();
  activeRequestControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      body: options.body,
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    importantConsole("Direct API raw response", {
      url,
      status: response.status,
      ok: response.ok,
      bodyText: text.slice(0, 5000),
      bodyLength: text.length
    });
    return { responseOk: response.ok, status: response.status, data };
  } catch (error) {
    importantConsole("Direct API request failed", {
      url,
      error: error.message || String(error),
      stack: error.stack
    });
    if (error.name === "AbortError") throw new Error(`API timeout (30 sn): ${url}`);
    throw error;
  } finally {
    clearTimeout(timeout);
    activeRequestControllers.delete(controller);
  }
}
async function ensureNetworkMonitor(focus = false) {
  if (networkPort && networkTabId) {
    try {
      const tab = await chrome.tabs.get(networkTabId);
      if (focus) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return tab;
    } catch { networkPort = null; networkTabId = null; }
  }
  const monitorUrl = chrome.runtime.getURL("src/modules/important/network.html");
  const existing = (await chrome.tabs.query({ url: `${monitorUrl}*` }))[0];
  const tab = existing || await chrome.tabs.create({ url: monitorUrl, active: focus });
  networkTabId = tab.id;
  if (focus && existing) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  const started = Date.now();
  while (!networkPort && Date.now() - started < 10000) await delay(100);
  if (!networkPort) throw new Error("Network Monitor sekmesi bağlanamadı.");
  return tab;
}
function defaultApiBaseUrl() { return API_CONFIG.defaultBaseUrl(); }
function normalizeApi(value) { return API_CONFIG.normalizeBaseUrl(value); }
function allowedApiBaseUrl(value) { return API_CONFIG.allowedBaseUrl(value); }
async function getState() { return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || { ...initialState }; }
async function setState(state) { await chrome.storage.local.set({ [STATE_KEY]: state }); chrome.runtime.sendMessage({ type: "STATE_CHANGED", futbinSyncModule: "important", state }).catch(() => {}); return state; }
async function patchState(patch) { return setState({ ...(await getState()), ...patch, updatedAt: Date.now() }); }
async function appendLog(message) { const state = await getState(); await patchState({ logs: [...(state.logs || []), logEntry(message)].slice(-200) }); }
async function appendLogs(messages) { const state = await getState(); await patchState({ logs: [...(state.logs || []), ...messages.map(logEntry)].slice(-500) }); }
function logEntry(message) { return { at: Date.now(), message }; }
function formatApiIssues(errors, players = []) {
  const playersById = new Map(
    players.map((player) => [String(player?.futbin_player_id || ""), player]).filter(([id]) => id)
  );
  return (Array.isArray(errors) ? errors : [])
    .filter((error) => typeof error === "string" ? error.trim() : error && typeof error === "object")
    .map((error) => {
      const message = typeof error === "string"
        ? error
        : String(error.message || error.error || "");
      const playerId = String(
        (typeof error === "object" && (error.futbin_player_id || error.futbinPlayerId)) ||
        message.match(/futbin_player_id\s*[=:]\s*(\d+)/i)?.[1] ||
        ""
      );
      const player = playersById.get(playerId);
      const playerLink = player?.futbin_player_link || player?.url;
      if (!playerLink) return error;
      return {
        ...(typeof error === "object" ? error : {}),
        message,
        futbin_player_id: playerId,
        futbin_player_link: playerLink
      };
    });
}
function importantConsole(label, value) {
  console.groupCollapsed(`[Important Players] ${label}`);
  console.log(value);
  try { console.log("JSON:", JSON.stringify(value, null, 2)); }
  catch (error) { console.warn("JSON stringify başarısız", error); }
  console.groupEnd();
}
function debugConsole(label, value) {
  importantConsole(label, value);
}
function htmlSummary(html) {
  const text = String(html || "");
  return {
    length: text.length,
    title: text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "",
    hasPlayerRows: /player-row|players-table|table-player-name/i.test(text),
    snippet: text.slice(0, 2000)
  };
}
function parseJsonForDebug(value) {
  if (!value || typeof value !== "string") return value || null;
  try { return JSON.parse(value); } catch { return value.slice(0, 5000); }
}
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDelayResolvers.delete(timer);
      resolve();
    }, ms);
    pendingDelayResolvers.set(timer, resolve);
  });
}
function cancelPendingDelays() {
  for (const [timer, resolve] of pendingDelayResolvers) {
    clearTimeout(timer);
    resolve();
  }
  pendingDelayResolvers.clear();
}
