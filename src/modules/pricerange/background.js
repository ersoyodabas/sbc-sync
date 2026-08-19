import { FUTBIN_CHALLENGE_MAX_WAIT_MS, futbinChallengeTimeoutError, isFutbinChallengeHtml } from "../futbin/challenge.js";
import { isDateBefore, isDateInRange, lookbackStartDate, paginationDecision, priceRangeRatioDecision } from "./policy.js";
import { priceRangeInsertRequest, priceRangePayload } from "./payload.js";
import { indexCoinCards, matchCoinCard } from "./coincard-match.js";

const MODULE = "pricerange";
const STATE_KEY = "priceRangeSyncState";
const LOGS_KEY = "priceRangeSyncLogs";
const ERRORS_KEY = "priceRangeSyncErrors";
const LOOP_ALARM = "pricerange-sync-loop";
const SOURCE_URL = "https://www.futbin.com/26/priceranges?page=1";
const LOOP_DELAY_MS = 60 * 60 * 1000;
const MIN_REQUEST_DELAY_MS = 5_000;
const MAX_PAGE_ATTEMPTS = 3;
const MAX_LOGS = 150;
const MAX_ERRORS = 50;
const TARGET_DOM_WAIT_MS = 60_000;
const API_CONFIG = globalThis.FutbinSyncApiConfig;

let runToken = 0;
let activeController = null;
let activeTabId = null;
let detailTabId = null;
let cancelTabWait = null;
let stateWriteQueue = Promise.resolve();
let lastExternalRequestCompletedAt = 0;
const pendingDelays = new Map();

const emptyState = {
  running: false,
  userStarted: false,
  waitingForNextRun: false,
  status: "Hazır",
  error: null,
  runStartedAt: null,
  completedAt: null,
  nextRunAt: null,
  scanDate: null,
  scanStartDate: null,
  lookbackDays: 1,
  minimumRatio: 3,
  currentPage: 0,
  pagesRead: 0,
  rowsParsed: 0,
  matchingRecords: 0,
  oldRecordsSkipped: 0,
  ratioQualified: 0,
  ratioSkipped: 0,
  platformSkipped: 0,
  stage: "idle",
  detailQueue: [],
  priceRangeDetailQueue: [],
  currentDetailIndex: -1,
  currentDetailPlayer: null,
  detailPagesRead: 0,
  detailSuccessful: 0,
  detailRemaining: 0,
  detailPricesLoaded: 0,
  detailPricesMissing: 0,
  apiProcessed: 0,
  apiMatched: 0,
  apiInserted: 0,
  apiUpdated: 0,
  apiNotFound: 0,
  apiSkipped: 0,
  apiFailed: 0,
  priceRangePlayers: [],
  priceRangeDetailResults: [],
  tabId: null,
  currentUrl: null,
  failedPages: [],
  awaitingFutbinVerification: false,
  futbinChallengeTabId: null,
  futbinChallengeUrl: null,
  futbinChallengeDetectedAt: null,
  updatedAt: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get([STATE_KEY, LOGS_KEY, ERRORS_KEY]);
  if (!stored[STATE_KEY]) await writeState(emptyState);
  if (!stored[LOGS_KEY]) await chrome.storage.local.set({ [LOGS_KEY]: [] });
  if (!stored[ERRORS_KEY]) await chrome.storage.local.set({ [ERRORS_KEY]: [] });
});

chrome.runtime.onStartup.addListener(async () => {
  await API_CONFIG.ready;
  const state = await getState();
  if (!state.userStarted) return;
  if (state.running) {
    const token = ++runToken;
    await freshCycleState({ userStarted: true, status: "Önceki çalışma yeniden başlatılıyor" });
    void runCycle(token).catch((error) => handleCycleFailure(error, token));
    return;
  }
  if (state.nextRunAt) await ensureLoopAlarm(state);
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.futbinSyncModule !== MODULE) return false;
  handleMessage(message)
    .then(respond)
    .catch((error) => respond({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LOOP_ALARM) return;
  void startScheduledCycle();
});

globalThis.FutbinSyncModuleControls = globalThis.FutbinSyncModuleControls || {};
globalThis.FutbinSyncModuleControls[MODULE] = {
  getSnapshot: async () => getSnapshot(),
  start: async () => startSync(),
  stop: async () => stopSync(),
  clear: async () => clearSync()
};

async function handleMessage(message) {
  switch (message.type) {
    case "GET_SNAPSHOT": return { ok: true, ...(await getSnapshot()) };
    case "START_SYNC": return startSync();
    case "STOP_SYNC": return stopSync();
    case "CLEAR_SYNC": return clearSync();
    default: return { ok: false, error: "Bilinmeyen Price Range Sync mesajı." };
  }
}

async function getSnapshot() {
  const stored = await chrome.storage.local.get([STATE_KEY, LOGS_KEY, ERRORS_KEY]);
  return {
    [STATE_KEY]: normalizeState(stored[STATE_KEY]),
    [LOGS_KEY]: Array.isArray(stored[LOGS_KEY]) ? stored[LOGS_KEY] : [],
    [ERRORS_KEY]: Array.isArray(stored[ERRORS_KEY]) ? stored[ERRORS_KEY] : []
  };
}

async function getState() {
  return normalizeState((await chrome.storage.local.get(STATE_KEY))[STATE_KEY]);
}

function normalizeState(value) {
  return { ...emptyState, ...(value || {}) };
}

async function writeState(next) {
  return enqueueStateWrite(async () => {
    const state = { ...emptyState, ...next, updatedAt: Date.now() };
    await chrome.storage.local.set({ [STATE_KEY]: state });
    chrome.runtime.sendMessage({ futbinSyncModule: MODULE, type: "STATE_CHANGED", state }).catch(() => {});
    return state;
  });
}

async function patchState(patch) {
  const current = await getState();
  return writeState({ ...current, ...patch });
}

function enqueueStateWrite(task) {
  const next = stateWriteQueue.then(task, task);
  stateWriteQueue = next.catch(() => {});
  return next;
}

async function startSync() {
  await API_CONFIG.ready;
  const state = await getState();
  if (state.running) return { ok: true, state, alreadyRunning: true };
  await chrome.alarms.clear(LOOP_ALARM);
  const token = ++runToken;
  const started = await freshCycleState({ userStarted: true, status: "Starting..." });
  void runCycle(token).catch((error) => handleCycleFailure(error, token));
  return { ok: true, state: started };
}

async function startScheduledCycle() {
  await API_CONFIG.ready;
  await chrome.alarms.clear(LOOP_ALARM);
  const previous = await getState();
  if (!previous.userStarted || previous.running) return;
  const token = ++runToken;
  await freshCycleState({ userStarted: true, status: "Yeni saatlik Price Range taraması başlıyor" });
  void runCycle(token).catch((error) => handleCycleFailure(error, token));
}

async function freshCycleState(extra = {}) {
  const previous = await getState();
  const scanDate = localDateString();
  const lookbackDays = resolveLookbackDays();
  const minimumRatio = resolveMinimumRangeRatio();
  const state = {
    ...emptyState,
    userStarted: true,
    running: true,
    runStartedAt: Date.now(),
    scanDate,
    scanStartDate: lookbackStartDate(scanDate, lookbackDays),
    lookbackDays,
    minimumRatio,
    status: "Starting...",
    ...extra,
    failedPages: []
  };
  await writeState(state);
  await appendLog(`Scan date: ${state.scanDate} · window: ${state.scanStartDate} → ${state.scanDate} (${lookbackDays} gün) · Ratio eşiği: ${minimumRatio}x`, "scan-date");
  return { ...previous, ...state };
}

async function stopSync() {
  ++runToken;
  if (activeController) activeController.abort();
  activeController = null;
  cancelTabWait?.();
  cancelTabWait = null;
  cancelPendingDelays();
  await chrome.alarms.clear(LOOP_ALARM);
  if (activeTabId) await chrome.tabs.remove(activeTabId).catch(() => {});
  activeTabId = null;
  if (detailTabId) await chrome.tabs.remove(detailTabId).catch(() => {});
  detailTabId = null;
  const state = await patchState({
    running: false,
    userStarted: false,
    waitingForNextRun: false,
    nextRunAt: null,
    status: "Finished",
    error: null,
    awaitingFutbinVerification: false,
    futbinChallengeTabId: null,
    futbinChallengeUrl: null,
    futbinChallengeDetectedAt: null,
    completedAt: Date.now()
  });
  await appendLog("Price Range Sync kullanıcı tarafından sonlandırıldı", "finished");
  return { ok: true, state };
}

async function clearSync() {
  await stopSync();
  await chrome.storage.local.set({ [STATE_KEY]: { ...emptyState, updatedAt: Date.now() }, [LOGS_KEY]: [], [ERRORS_KEY]: [] });
  return { ok: true, state: emptyState };
}

async function runCycle(token) {
  await API_CONFIG.ready;
  assertActive(token);
  let page = 1;
  let records = [];
  const { scanDate, scanStartDate } = await getState();
  const seenPageSignatures = new Set();

  while (true) {
    assertActive(token);
    const url = pageUrl(page);
    await patchState({ currentPage: page, status: `Reading Price Range page ${page}...` });
    await appendLog(`Reading Price Range page ${page}`, "page-reading", { page, url });

    let parsed;
    try {
      parsed = await fetchAndParsePage(url, page, token);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      const failure = { page, url, reason: error.message || String(error), attempt: MAX_PAGE_ATTEMPTS, at: Date.now() };
      await appendError(failure);
      await appendLog(`Price Range page ${page} failed · ${failure.reason}`, "page-failed", failure);
      await finishCycle(token, { status: `Page ${page} failed; sonraki tarama 1 saat sonra`, error: failure.reason });
      return;
    }
    assertActive(token);

    const matchingRows = parsed.records.filter((record) => isDateInRange(record.updated_on, scanStartDate, scanDate));
    const olderRows = parsed.records.filter((record) => isDateBefore(record.updated_on, scanStartDate));
    const futureOrInvalidRows = parsed.records.filter((record) => !isDateInRange(record.updated_on, scanStartDate, scanDate) && !isDateBefore(record.updated_on, scanStartDate));
    records = dedupeRecords([...records, ...matchingRows]);
    const state = await getState();
    await patchState({
      currentPage: page,
      pagesRead: state.pagesRead + 1,
      rowsParsed: state.rowsParsed + parsed.records.length,
      matchingRecords: records.length,
      oldRecordsSkipped: state.oldRecordsSkipped + olderRows.length,
      priceRangePlayers: records,
      status: `${matchingRows.length} kayıt seçildi (${scanStartDate} → ${scanDate})`
    });
    await appendParseErrors(parsed.errors, page, url);
    logPageDiagnostics(page, url, parsed.records, matchingRows, olderRows, futureOrInvalidRows);
    await appendLog(`Page ${page} · ${parsed.records.length} parsed · ${matchingRows.length} aralıkta · ${olderRows.length} eski`, "page-parsed", {
      page, url, parsed: parsed.records.length, matching: matchingRows.length, old: olderRows.length
    });

    const signature = parsed.records.map(recordKey).sort().join(";");
    if (signature && seenPageSignatures.has(signature)) {
      await appendLog("Tekrarlanan Price Range sayfası algılandı · pagination stopped", "pagination-finished", { page });
      break;
    }
    seenPageSignatures.add(signature);
    // Page N detail jobs are deliberately completed before page N + 1 is read.
    // This keeps one sequential player-detail workload tied to the source page.
    await processRecords(dedupeRecords(matchingRows), token);
    assertActive(token);
    const decision = paginationDecision({ rowCount: parsed.rowCount, parsedCount: parsed.records.length, olderCount: olderRows.length });
    if (!decision.shouldContinue) {
      await appendLog(decision.older ? "Older records reached · pagination stopped" : "Price Range sayfasında yeni kayıt bulunamadı · pagination stopped", "pagination-finished", { page });
      break;
    }
    page += 1;
    await delay(requestDelayMs(), token);
  }

  assertActive(token);
  records = dedupeRecords(records);
  await patchState({
    matchingRecords: records.length,
    priceRangePlayers: records,
    status: `Price Range scan completed · ${records.length} kayıt işlendi`
  });
  logAllRecords(records);
  await appendLog(`Price Range scan completed · ${records.length} kayıt işlendi`, "scan-completed", {
    records: records.length,
    qualified: (await getState()).ratioQualified,
    threshold: (await getState()).minimumRatio
  });
  await finishCycle(token, { status: "Finished" });
}

async function fetchAndParsePage(url, page, token) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
    assertActive(token);
    try {
      const html = await fetchFutbinHtml(url, token);
      assertActive(token);
      const parsed = await parseHtml(html, url);
      if (parsed.rowCount === 0 && !looksLikePriceRangeHtml(html)) {
        throw new Error("Price Range hedef HTML bulunamadı");
      }
      return parsed;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      const details = { page, url, attempt, reason: error.message || String(error) };
      console.warn(`[PriceRange] Page ${page} failed · attempt ${attempt}/${MAX_PAGE_ATTEMPTS}`, details);
      await appendLog(`Page ${page} failed · attempt ${attempt}/${MAX_PAGE_ATTEMPTS} · ${details.reason}`, "page-retry", details);
      if (attempt < MAX_PAGE_ATTEMPTS) await delay(requestDelayMs(), token);
    }
  }
  throw lastError || new Error(`Price Range page ${page} okunamadı.`);
}

async function fetchFutbinHtml(url, token, targetReady = looksLikePriceRangeHtml) {
  const controller = new AbortController();
  activeController = controller;
  try {
    try {
      await waitForExternalRequestSlot(token);
      const response = await fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal });
      if (response.status === 403 || response.status === 429) {
        lastExternalRequestCompletedAt = Date.now();
        return fetchViaTab(url, token, targetReady);
      }
      if (!response.ok) throw new Error(`Futbin HTTP ${response.status}: ${url}`);
      const html = await response.text();
      if (isFutbinChallengeHtml(html)) {
        lastExternalRequestCompletedAt = Date.now();
        return fetchViaTab(url, token, targetReady);
      }
      if (html.length < 500) throw new Error(`Futbin HTML yanıtı çok küçük: ${url}`);
      if (!targetReady(html)) {
        lastExternalRequestCompletedAt = Date.now();
        return fetchViaTab(url, token, targetReady);
      }
      return html;
    } catch (error) {
      lastExternalRequestCompletedAt = Date.now();
      if (error.name === "AbortError") throw error;
      console.warn("[PriceRange] Direct Futbin fetch failed; tab fallback kullanılacak", error);
      return fetchViaTab(url, token, targetReady);
    }
  } finally {
    lastExternalRequestCompletedAt = Date.now();
    if (activeController === controller) activeController = null;
  }
}

async function fetchViaTab(url, token, targetReady = looksLikePriceRangeHtml) {
  assertActive(token);
  await waitForExternalRequestSlot(token);
  const tab = await chrome.tabs.create({ url, active: false });
  activeTabId = tab.id || null;
  try {
    const html = await waitForTabHtml(tab.id, url, token, targetReady);
    assertActive(token);
    return html;
  } finally {
    if (activeTabId === tab.id) activeTabId = null;
    await chrome.tabs.remove(tab.id).catch(() => {});
    lastExternalRequestCompletedAt = Date.now();
  }
}

async function waitForTabHtml(tabId, url, token, targetReady = looksLikePriceRangeHtml) {
  let deadline = Date.now() + TARGET_DOM_WAIT_MS;
  let challengeDetected = false;
  let lastHtml = "";
  let cancelled = false;
  cancelTabWait = () => { cancelled = true; };
  while (Date.now() < deadline) {
    if (cancelled) throw new DOMException("Price Range Sync finished", "AbortError");
    assertActive(token);
    try {
      lastHtml = await readTabOuterHtml(tabId);
    } catch {
      await delay(250, token);
      continue;
    }
    if (targetReady(lastHtml)) {
      if (challengeDetected) await patchVerification(token, { resolved: true });
      return lastHtml;
    }
    if (isFutbinChallengeHtml(lastHtml) && !challengeDetected) {
      challengeDetected = true;
      deadline = Date.now() + FUTBIN_CHALLENGE_MAX_WAIT_MS;
      await focusTab(tabId);
      await patchVerification(token, { waiting: true, tabId, url, detectedAt: Date.now() });
      await appendLog("Futbin Cloudflare doğrulaması algılandı; açık sekmede doğrulama bekleniyor", "cloudflare", { url, tabId });
    }
    await delay(250, token);
  }
  if (challengeDetected) await patchVerification(token, { waiting: false });
  throw new Error(isFutbinChallengeHtml(lastHtml)
    ? futbinChallengeTimeoutError(url)
    : `Futbin Price Range hedef HTML 60 saniye içinde okunamadı: ${url}`);
}

function looksLikePriceRangeHtml(html) {
  return /tr[^>]+class=["'][^"']*squad-row|td[^>]+class=["'][^"']*pr-player|td[^>]+class=["'][^"']*pr-updated/i.test(String(html || ""));
}

function looksLikePlayerDetailHtml(html) {
  const source = String(html || "");
  return /class=["'][^"']*lowest-price-1/i.test(source)
    && /class=["'][^"']*platform-ps-only/i.test(source);
}

async function readTabOuterHtml(tabId) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement.outerHTML });
  return result?.[0]?.result || "";
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* Kullanıcı odağına geçiş yalnızca Cloudflare için en iyi çabadır. */ }
}

async function patchVerification(token, { waiting = false, tabId = null, url = null, detectedAt = null, resolved = false } = {}) {
  if (!await isActive(token)) return;
  const patch = {
    awaitingFutbinVerification: waiting,
    futbinChallengeTabId: waiting ? tabId : null,
    futbinChallengeUrl: waiting ? url : null,
    futbinChallengeDetectedAt: waiting ? detectedAt : null
  };
  if (waiting) patch.status = "Futbin doğrulaması bekleniyor — açık sekmede devam edin";
  else if (resolved) patch.status = "Futbin doğrulaması tamamlandı; işleme devam ediliyor";
  await patchState(patch);
}

async function parseHtml(html, pageUrl) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ type: "PARSE_PRICE_RANGE_HTML", html, pageUrl });
  if (!result?.ok) throw new Error(result?.error || "Price Range HTML ayrıştırılamadı.");
  return result;
}

async function parsePlayerDetailHtml(html, playerUrl) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ type: "PARSE_PRICE_RANGE_PLAYER_HTML", html, playerUrl });
  if (!result?.ok) throw new Error(result?.error || "Futbin oyuncu detay HTML'i ayrıştırılamadı.");
  return result;
}

async function fetchAndParsePlayerDetail(job, index, token) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
    assertActive(token);
    try {
      const html = await navigateAndReadPlayerDetail(job, index, token);
      assertActive(token);
      const detail = await parsePlayerDetailHtml(html, job.url);
      if (Number(detail.futbin_player_id) !== Number(job.futbinPlayerId)) {
        throw new Error(`Eski oyuncu sonucu yok sayıldı: ${detail.futbin_player_id || "bilinmiyor"} ≠ ${job.futbinPlayerId}`);
      }
      if (!hasCompleteDetailPrices(detail)) throw new Error("Futbin detay sayfasında PS/Cross MARKET fiyatı okunamadı.");
      return detail;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      const details = { url: job.url, futbinPlayerId: job.futbinPlayerId, index, attempt, reason: error.message || String(error) };
      console.warn(`[PriceRange] Player detail failed · attempt ${attempt}/${MAX_PAGE_ATTEMPTS}`, details);
      await appendLog(`Oyuncu detay fiyatı okunamadı · attempt ${attempt}/${MAX_PAGE_ATTEMPTS} · ${details.reason}`, "detail-retry", details);
      if (attempt < MAX_PAGE_ATTEMPTS) await delay(requestDelayMs(), token);
    }
  }
  throw lastError || new Error(`Futbin oyuncu detay sayfası okunamadı: ${job.url}`);
}

function hasCompleteDetailPrices(detail) {
  return Number(detail?.price_ps) > 0;
}

async function ensureDetailWorkingTab(token) {
  assertActive(token);
  // A fresh, owned tab for each player avoids carrying over a previous page's
  // live state. It is closed in the job's finally block before the next row.
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  detailTabId = tab.id || null;
  await patchState({ tabId: detailTabId });
  return tab;
}

async function navigateAndReadPlayerDetail(job, index, token) {
  const tab = await ensureDetailWorkingTab(token);
  const tabId = tab.id;
  if (!tabId) throw new Error("Price Range çalışma sekmesi oluşturulamadı.");
  const state = await getState();
  await patchState({
    stage: "player-details",
    tabId,
    currentUrl: job.url,
    currentDetailIndex: index,
    currentDetailPlayer: job,
    status: `Player Details · ${index + 1}/${state.detailQueue.length} · ${job.playerName || job.futbinPlayerId} · açılıyor`
  });
  await appendLog(`Oyuncu detay sayfası açılıyor · ${job.playerName || job.futbinPlayerId}`, "detail-navigation", {
    tabId, index, url: job.url, futbinPlayerId: job.futbinPlayerId
  });
  await waitForExternalRequestSlot(token);
  await assertCurrentDetailContext(token, tabId, job, index);
  await chrome.tabs.update(tabId, { url: job.url, active: false });
  return waitForPlayerDetailHtml(tabId, job, index, token);
}

async function assertCurrentDetailContext(token, tabId, job, index) {
  assertActive(token);
  const state = await getState();
  if (!state.running || state.tabId !== tabId || state.currentDetailIndex !== index ||
    !sameUrl(state.currentUrl, job.url) || Number(state.currentDetailPlayer?.futbinPlayerId) !== Number(job.futbinPlayerId)) {
    throw new DOMException("Eski veya durdurulmuş oyuncu detay işi", "AbortError");
  }
}

async function waitForPlayerDetailHtml(tabId, job, index, token) {
  let deadline = Date.now() + TARGET_DOM_WAIT_MS;
  let challengeDetected = false;
  let lastHtml = "";
  while (Date.now() < deadline) {
    await assertCurrentDetailContext(token, tabId, job, index);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error("Price Range çalışma sekmesi kapatıldı."); }
    if (!sameUrl(tab.url, job.url)) {
      await delay(250, token);
      continue;
    }
    try { lastHtml = await readTabOuterHtml(tabId); } catch {
      await delay(250, token);
      continue;
    }
    if (looksLikePlayerDetailHtml(lastHtml)) {
      if (challengeDetected) await patchVerification(token, { resolved: true });
      lastExternalRequestCompletedAt = Date.now();
      return lastHtml;
    }
    if (isFutbinChallengeHtml(lastHtml) && !challengeDetected) {
      challengeDetected = true;
      deadline = Date.now() + FUTBIN_CHALLENGE_MAX_WAIT_MS;
      await focusTab(tabId);
      await patchVerification(token, { waiting: true, tabId, url: job.url, detectedAt: Date.now() });
      await appendLog("Futbin Cloudflare doğrulaması algılandı; açık sekmede doğrulama bekleniyor", "cloudflare", { tabId, url: job.url });
    }
    await delay(250, token);
  }
  if (challengeDetected) await patchVerification(token, { waiting: false });
  throw new Error(isFutbinChallengeHtml(lastHtml)
    ? futbinChallengeTimeoutError(job.url)
    : `Futbin oyuncu detay hedef HTML 60 saniye içinde okunamadı: ${job.url}`);
}

function sameUrl(left, right) {
  try {
    const a = new URL(left); const b = new URL(right);
    a.hash = ""; b.hash = "";
    return a.href === b.href;
  } catch { return left === right; }
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("src/offscreen.html");
  if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length) return;
  try {
    await chrome.offscreen.createDocument({ url: "src/offscreen.html", reasons: ["DOM_SCRAPING"], justification: "Futbin Price Range HTML satırlarını ayrıştırmak" });
  } catch (error) {
    if (!(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length) throw error;
  }
}

async function processRecords(records, token) {
  if (!records.length) return;
  const detailQueue = buildDetailQueue(records);
  await patchState({
    stage: "player-details",
    detailQueue,
    priceRangeDetailQueue: detailQueue,
    currentDetailIndex: -1,
    currentDetailPlayer: null,
    detailRemaining: detailQueue.length,
    status: `Player Details · 0/${detailQueue.length}`
  });
  await appendLog(`PRICE RANGE STAGE 2 · ${detailQueue.length} oyuncu detay işi hazır`, "detail-queue", { count: detailQueue.length });
  const coinCards = await fetchCoinCards(token);
  const coinCardIndex = indexCoinCards(coinCards);

  for (let index = 0; index < detailQueue.length; index += 1) {
    assertActive(token);
    const job = detailQueue[index];
    const record = job.records[0];
    const playerKey = `player:${job.futbinPlayerId}`;
    await upsertPlayerLog(record, "processing", `Processing · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, { playerKey, url: job.url });
    const state = await getState();
    await patchState({
      apiProcessed: state.apiProcessed + 1,
      currentDetailIndex: index,
      currentDetailPlayer: job,
      detailRemaining: Math.max(0, detailQueue.length - index),
      status: `Player Details · ${index + 1}/${detailQueue.length} · ${job.playerName || job.futbinPlayerId}`
    });
    try {
      let detail;
      try {
        detail = await fetchAndParsePlayerDetail(job, index, token);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        await addApiStats({ detailPricesMissing: 1, apiFailed: 1 });
        await appendDetailResult(job, { success: false, reason: error.message || String(error) });
        await appendError({ player: record, reason: error.message || String(error), stage: "detail-price", url: job.url, at: Date.now() });
        await upsertPlayerLog(record, "failed", `Failed · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, {
          playerKey, url: job.url, error: error.message || String(error)
        });
        continue;
      }
      const enrichedRecord = {
        ...record,
        price_ps: detail.price_ps,
        priceCross: detail.price_ps,
        min_price_ps: detail.min_price_ps,
        max_price_ps: detail.max_price_ps,
        price_pc: detail.price_pc,
        pricePc: detail.price_pc,
        min_price_pc: detail.min_price_pc,
        max_price_pc: detail.max_price_pc
      };
      await addApiStats({ detailPagesRead: 1, detailSuccessful: 1, detailPricesLoaded: 1 });
      await appendDetailResult(job, { ...detail, success: true });
      consolePlayerDetail(index, detailQueue.length, job, detail);
      const ratioDecision = await registerDetailRatio(record, detail, playerKey);
      await appendFinalPlayerRangeLogs(job, detail, ratioDecision);
      if (!ratioDecision.qualifies) continue;
      await patchState({ status: `Sending API · ${detailLogLabel(enrichedRecord, detail.playerUrl)}` });
      await upsertPlayerLog(enrichedRecord, "processing", `Processing · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, {
        playerKey, url: detail.playerUrl || job.url, pricePs: detail.price_ps, pricePc: detail.price_pc
      });
      const coinCardMatch = matchCoinCard(coinCardIndex, {
        futbinPlayerId: job.futbinPlayerId,
        playerUrl: detail.playerUrl || job.url
      });
      const coinCard = coinCardMatch.card;
      if (!coinCard) {
        const stateForInsert = await getState();
        const insertRequest = priceRangeInsertRequest(stateForInsert.scanDate, {
          ...enrichedRecord,
          player_url: detail.playerUrl || job.url
        });
        await appendLog(
          `${job.rating || "—"} · ${job.playerName || job.futbinPlayerId} · Coin Card eşleşmedi · API insert gönderiliyor`,
          "coin-card-insert-posting",
          {
            page: stateForInsert.currentPage,
            futbinPlayerId: job.futbinPlayerId,
            playerName: job.playerName || record.player_name || null,
            rating: job.rating || record.rating || null,
            ratio: ratioDecision.ratio,
            threshold: ratioDecision.threshold,
            url: detail.playerUrl || job.url
          },
        );
        // The request is deliberately awaited before the next player starts.
        const response = await apiRequest("futbin-sync/coin-card-latest", {
          method: "POST",
          body: JSON.stringify(insertRequest)
        }, token);
        assertActive(token);
        const data = response?.data || {};
        const inserted = Number(data.inserted) || 0;
        const updated = Number(data.updated) || Number(data.saved) || 0;
        const notFound = Number(data.notFound ?? data.not_found) || 0;
        const failed = Number(data.failed) || 0;
        const skipped = Number(data.skipped) || 0;
        if (notFound || failed || skipped) {
          const insertFailed = Boolean(notFound || failed);
          await addApiStats({ apiFailed: (failed || notFound) || 0, apiSkipped: skipped || (!insertFailed ? 1 : 0) });
          await upsertPlayerLog(enrichedRecord, "failed", `Insert ${insertFailed ? "başarısız" : "atlandı"} · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, {
            playerKey, response: data, url: detail.playerUrl || job.url
          });
          await appendLog(
            `${job.rating || "—"} · ${job.playerName || job.futbinPlayerId} · Insert ${insertFailed ? "başarısız" : "atlandı"} · skipped ${skipped} · failed ${failed} · notFound ${notFound}`,
            "coin-card-insert-failed",
            { page: stateForInsert.currentPage, futbinPlayerId: job.futbinPlayerId, response: data, url: detail.playerUrl || job.url },
          );
          continue;
        }
        await addApiStats({ apiInserted: inserted, apiUpdated: updated });
        const insertedLabel = inserted > 0 ? "API'ye eklendi" : "API'de güncellendi";
        await upsertPlayerLog(enrichedRecord, inserted > 0 ? "inserted" : "updated", `${insertedLabel} · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, {
          playerKey, response: data, url: detail.playerUrl || job.url
        });
        await appendLog(
          `${job.rating || "—"} · ${job.playerName || job.futbinPlayerId} · ${insertedLabel}`,
          "coin-card-inserted",
          {
            page: stateForInsert.currentPage,
            futbinPlayerId: job.futbinPlayerId,
            playerName: job.playerName || record.player_name || null,
            rating: job.rating || record.rating || null,
            inserted,
            updated,
            ratio: ratioDecision.ratio,
            threshold: ratioDecision.threshold,
            url: detail.playerUrl || job.url
          },
        );
        continue;
      }
      await addApiStats({ apiMatched: 1 });
      if (coinCardMatch.matchedBy === "url") {
        await appendLog(
          `${job.rating || "—"} · ${job.playerName || job.futbinPlayerId} · Coin Card URL ile eşleşti`,
          "coin-card-url-match",
          {
            page: (await getState()).currentPage,
            futbinPlayerId: job.futbinPlayerId,
            playerName: job.playerName || record.player_name || null,
            rating: job.rating || record.rating || null,
            matchMethod: "url",
            coinCardId: coinCard.id,
            url: detail.playerUrl || job.url
          },
        );
      }
      const payload = priceRangePayload(coinCard, enrichedRecord);
      await appendLog(
        `${job.rating || "—"} · ${job.playerName || job.futbinPlayerId} · ${ratioLogText(ratioDecision.ratio)} (${ratioDecision.threshold}x eşiğini geçti) · API POST gönderiliyor`,
        "player-api-posting",
        {
          page: (await getState()).currentPage,
          futbinPlayerId: job.futbinPlayerId,
          playerName: job.playerName || record.player_name || null,
          rating: job.rating || record.rating || null,
          ratio: ratioDecision.ratio,
          threshold: ratioDecision.threshold,
          url: detail.playerUrl || job.url
        },
      );
      // This await intentionally blocks the sequential detail queue: the
      // current qualifying player is persisted before the next player opens.
      const response = await apiRequest(`futbin-sync/coin-card-jobs/${coinCard.id}`, { method: "POST", body: JSON.stringify(payload) }, token);
      assertActive(token);
      const data = response?.data || {};
      const notFound = Number(data.notFound ?? data.not_found) || 0;
      const failed = Number(data.failed) || 0;
      const skipped = Number(data.skipped) || 0;
      const updated = Number(data.updated) || Number(data.saved) || 0;
      if (notFound) {
        await addApiStats({ apiNotFound: notFound });
        await upsertPlayerLog(enrichedRecord, "not-found", `Not Found · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, { playerKey, url: detail.playerUrl || job.url });
      } else if (failed || skipped) {
        await addApiStats({ apiFailed: failed, apiSkipped: skipped || (!failed ? 1 : 0) });
        await upsertPlayerLog(enrichedRecord, "failed", `Failed · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, { playerKey, response: data, url: detail.playerUrl || job.url });
      } else {
        await addApiStats({ apiUpdated: updated || 1 });
        await upsertPlayerLog(enrichedRecord, "updated", `Updated · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId} · PS ${formatPrice(detail.price_ps)} · PC ${detail.price_pc ? formatPrice(detail.price_pc) : "-"}`, { playerKey, response: data, url: detail.playerUrl || job.url });
        await appendLog(
          `${job.rating || "—"} · ${job.playerName || job.futbinPlayerId} · API'ye kaydedildi`,
          "player-api-saved",
          {
            page: (await getState()).currentPage,
            futbinPlayerId: job.futbinPlayerId,
            playerName: job.playerName || record.player_name || null,
            rating: job.rating || record.rating || null,
            ratio: ratioDecision.ratio,
            threshold: ratioDecision.threshold,
            updated: updated || 1,
            url: detail.playerUrl || job.url
          },
        );
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
      await addApiStats({ apiFailed: 1 });
      await appendError({ player: record, reason: error.message || String(error), stage: "api", at: Date.now() });
      await upsertPlayerLog(record, "failed", `Failed · ${job.rating || "—"} · ${job.playerName || job.futbinPlayerId}`, { playerKey, url: job.url, error: error.message || String(error) });
    } finally {
      await patchState({ detailRemaining: Math.max(0, detailQueue.length - index - 1) });
      if (detailTabId) await chrome.tabs.remove(detailTabId).catch(() => {});
      detailTabId = null;
      await patchState({ tabId: null, currentUrl: null });
    }
  }
  const state = await getState();
  console.group("[PriceRange] ALL DETAIL RESULTS");
  console.table(state.priceRangeDetailResults);
  console.log(state.priceRangeDetailResults);
  console.groupEnd();
  console.group("[PriceRange] API result");
  console.log("Received:", detailQueue.length);
  console.log("Matched:", state.apiMatched);
  console.log("Updated:", state.apiUpdated);
  console.log("Not Found:", state.apiNotFound);
  console.log("Failed:", state.apiFailed);
  console.groupEnd();
}

function buildDetailQueue(records) {
  const grouped = new Map();
  for (const record of records) {
    const id = Number(record.futbin_player_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const current = grouped.get(id) || {
      futbinPlayerId: id,
      playerName: record.player_name || null,
      rating: record.rating || null,
      position: record.position || null,
      version: record.version || null,
      updatedOn: record.updated_on || null,
      oldMinPrice: record.old_min_price ?? null,
      oldMaxPrice: record.old_max_price ?? null,
      newMinPrice: record.new_min_price ?? null,
      newMaxPrice: record.new_max_price ?? null,
      url: record.player_url,
      records: []
    };
    current.records.push(record);
    grouped.set(id, current);
  }
  return [...grouped.values()];
}

async function appendDetailResult(job, result) {
  const state = await getState();
  const entry = {
    futbin_player_id: job.futbinPlayerId,
    player_name: job.playerName,
    url: job.url,
    price_ps: result.price_ps ?? null,
    min_price_ps: result.min_price_ps ?? null,
    max_price_ps: result.max_price_ps ?? null,
    price_pc: result.price_pc ?? null,
    min_price_pc: result.min_price_pc ?? null,
    max_price_pc: result.max_price_pc ?? null,
    success: Boolean(result.success),
    reason: result.reason || null
  };
  await patchState({ priceRangeDetailResults: [...state.priceRangeDetailResults, entry] });
}

function consolePlayerDetail(index, total, job, detail) {
  console.group(`[PriceRange] PLAYER ${index + 1}/${total} - ${job.playerName || job.futbinPlayerId}`);
  console.log("URL:", job.url);
  console.log("Futbin Player ID:", job.futbinPlayerId);
  console.log("Price change rows:", job.records);
  console.log("Player detail result:", detail);
  console.groupEnd();
}

async function appendFinalPlayerRangeLogs(job, detail, ratioDecision) {
  const page = (await getState()).currentPage;
  for (const record of job.records) {
    const message = [
      `${record.rating || job.rating || "-"}`,
      `${record.player_name || job.playerName || job.futbinPlayerId}`,
      `Min: ${formatPrice(detail.min_price_ps)}`,
      `Max: ${formatPrice(detail.max_price_ps)}`,
      `PS Price: ${formatPrice(detail.price_ps)}`,
      `PC Price: ${detail.price_pc ? formatPrice(detail.price_pc) : "-"}`,
      `Ratio (Max / PS): ${ratioLogText(ratioDecision.ratio)}`
    ].join(" · ");
    await appendLog(message, "player-detail-final", {
      page,
      futbinPlayerId: job.futbinPlayerId,
      rating: record.rating || job.rating || null,
      playerName: record.player_name || job.playerName || null,
      newMinPrice: detail.min_price_ps ?? null,
      newMaxPrice: detail.max_price_ps ?? null,
      pricePs: detail.price_ps,
      pricePc: detail.price_pc ?? null,
      ratio: ratioDecision.ratio ?? null,
      ratioQualified: ratioDecision.qualifies,
      url: job.url
    });
  }
}

async function registerDetailRatio(record, detail, playerKey) {
  const minimumRatio = (await getState()).minimumRatio;
  const decision = priceRangeRatioDecision({
    max_price_ps: detail.max_price_ps,
    price_ps: detail.price_ps
  }, minimumRatio);
  if (decision.qualifies) {
    await addApiStats({ ratioQualified: 1 });
    return { ...decision, threshold: minimumRatio };
  }
  await addApiStats({ ratioSkipped: 1, apiSkipped: 1 });
  await upsertPlayerLog(record, "ratio-skipped", `Skipped · ${record.player_name || record.futbin_player_id} · ${ratioLogText(decision.ratio)} · ${minimumRatio}x eşiğini geçmedi`, {
    playerKey,
    ratio: decision.ratio,
    ratioQualified: false,
    threshold: minimumRatio,
    reason: decision.reason
  });
  return { ...decision, threshold: minimumRatio };
}

async function filterRecordsByRatio(records, token, playerKey = null) {
  const minimumRatio = (await getState()).minimumRatio;
  const qualified = [];
  for (const record of records) {
    assertActive(token);
    const decision = priceRangeRatioDecision(record, minimumRatio);
    if (decision.qualifies) {
      qualified.push({ ...record, range_ratio: decision.ratio });
      await addApiStats({ ratioQualified: 1 });
      continue;
    }
    const state = await getState();
    await patchState({
      ratioSkipped: state.ratioSkipped + 1,
      apiSkipped: state.apiSkipped + 1
    });
    await upsertPlayerLog(record, "ratio-skipped", `Skipped · ${recordLabel(record)} · ${ratioLogText(decision.ratio)} · ${minimumRatio}x eşiğini geçmedi`, {
      playerKey: playerKey || recordKey(record),
      ratio: decision.ratio,
      threshold: minimumRatio,
      reason: decision.reason
    });
  }
  return qualified;
}

async function filterSupportedPlatformRecords(records, token, playerKey = null) {
  const supported = [];
  for (const record of records) {
    assertActive(token);
    if (["cross", "pc"].includes(record.platform)) {
      supported.push(record);
      continue;
    }
    const state = await getState();
    await patchState({
      platformSkipped: state.platformSkipped + 1,
      apiSkipped: state.apiSkipped + 1
    });
    await upsertPlayerLog(record, "platform-skipped", `Skipped · ${recordLabel(record)} · platform ayrıştırılamadı`, {
      playerKey: playerKey || recordKey(record),
      reason: "platform-missing"
    });
  }
  return supported;
}

async function fetchCoinCards(token) {
  const response = await apiRequest("coincard", {}, token);
  return normalizeCoinCardList(response?.data);
}

function normalizeCoinCardList(data) {
  if (Array.isArray(data)) return data;
  return data?.items || data?.coinCards || data?.coin_cards || data?.records || [];
}

async function apiRequest(endpoint, options, token) {
  assertActive(token);
  await API_CONFIG.ready;
  await waitForExternalRequestSlot(token);
  const controller = new AbortController();
  activeController = controller;
  const url = new URL(endpoint, API_CONFIG.defaultBaseUrl()).href;
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body,
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok || data?.result === false) throw new Error(data?.message || `API HTTP ${response.status}`);
    return data;
  } finally {
    lastExternalRequestCompletedAt = Date.now();
    if (activeController === controller) activeController = null;
  }
}

async function finishCycle(token, { status, error = null } = {}) {
  if (!await isActive(token)) return;
  if (detailTabId) await chrome.tabs.remove(detailTabId).catch(() => {});
  detailTabId = null;
  const nextRunAt = Date.now() + LOOP_DELAY_MS;
  const current = await getState();
  const completed = await writeState({
    ...current,
    running: false,
    userStarted: true,
    waitingForNextRun: true,
    nextRunAt,
    completedAt: Date.now(),
    status: status || "Finished",
    error,
    stage: "complete",
    tabId: null,
    currentUrl: null,
    detailRemaining: 0,
    awaitingFutbinVerification: false,
    futbinChallengeTabId: null,
    futbinChallengeUrl: null,
    futbinChallengeDetectedAt: null
  });
  await chrome.alarms.clear(LOOP_ALARM);
  await chrome.alarms.create(LOOP_ALARM, { when: nextRunAt });
  await appendLog(`${completed.status} · sonraki tarama 1 saat sonra`, "cycle-finished", { nextRunAt });
}

async function handleCycleFailure(error, token) {
  if (error?.name === "AbortError" || !await isActive(token)) return;
  const message = error?.message || String(error);
  await appendError({ stage: "cycle", reason: message, at: Date.now() });
  await finishCycle(token, { status: `Price Range Sync hata verdi: ${message}`, error: message });
}

async function isActive(token) {
  return token === runToken && (await getState()).running;
}

function assertActive(token) {
  if (token !== runToken) throw new DOMException("Price Range Sync finished", "AbortError");
}

function pageUrl(page) {
  const url = new URL(SOURCE_URL);
  url.searchParams.set("page", String(page));
  return url.href;
}

function localDateString() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function resolveLookbackDays() {
  return Math.min(31, Math.max(1, Math.floor(API_CONFIG.number("PRICE_RANGE_LOOKBACK_DAYS", 1) || 1)));
}

function resolveMinimumRangeRatio() {
  return Math.min(1000, Math.max(0.01, Number(API_CONFIG.number("PRICE_RANGE_MIN_RATIO", 3)) || 3));
}

function requestDelayMs() {
  return Math.max(MIN_REQUEST_DELAY_MS, Number(API_CONFIG.number("WAIT_MS", MIN_REQUEST_DELAY_MS)) || MIN_REQUEST_DELAY_MS);
}

async function waitForExternalRequestSlot(token) {
  const remaining = requestDelayMs() - (Date.now() - lastExternalRequestCompletedAt);
  if (remaining > 0) await delay(remaining, token);
  assertActive(token);
}

function dedupeRecords(records) {
  const parser = globalThis.FutbinPriceRangeParser;
  const keyFor = parser?.recordKey || ((record) => [record.futbin_player_id, record.platform, record.updated_on, record.new_min_price, record.new_max_price].join("|"));
  return [...new Map(records.map((record) => [keyFor(record), record])).values()];
}

function recordKey(record) {
  return [record.futbin_player_id, record.platform || record.platform_label, record.updated_on, record.new_min_price, record.new_max_price].join("|");
}

function recordLabel(record) {
  const rating = record.rating ? `Rating ${record.rating}` : "Rating —";
  const range = `${formatPrice(record.new_min_price)} → ${formatPrice(record.new_max_price)}`;
  const ratio = record.range_ratio ?? priceRangeRatioDecision(record).ratio;
  const psPrice = Number(record.price_ps ?? record.priceCross);
  const pcPrice = Number(record.price_pc ?? record.pricePc);
  const detailPrices = psPrice > 0
    ? ` · PS ${formatPrice(psPrice)} · PC ${pcPrice > 0 ? formatPrice(pcPrice) : "-"}`
    : "";
  return `${rating} · ${record.player_name || `Player ${record.futbin_player_id}`} · ${range} · ${ratioLogText(ratio)}${detailPrices}`;
}

function detailLogLabel(record, playerUrl = record.player_url) {
  return `${recordLabel(record)} · ${playerUrl || "detay URL bulunamadı"}`;
}

function ratioLogText(ratio) {
  return Number.isFinite(Number(ratio)) ? `${Number(ratio).toFixed(2)}x` : "oran hesaplanamadı";
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  if (number >= 1_000_000) return `${compactNumber(number / 1_000_000)}M`;
  if (number >= 1_000) return `${compactNumber(number / 1_000)}K`;
  return String(Math.round(number));
}

function compactNumber(value) {
  return Number(value.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function logPageDiagnostics(page, url, rows, matchingRows, olderRows, futureOrInvalidRows = []) {
  console.group(`[PriceRange] PAGE ${page}`);
  console.log("URL:", url);
  console.log("Rows parsed:", rows.length);
  console.log("Range rows:", matchingRows.length);
  console.log("Older rows:", olderRows.length);
  console.log("Future/invalid rows:", futureOrInvalidRows.length);
  console.table(matchingRows);
  console.groupEnd();
}

function logAllRecords(records) {
  console.group("[PriceRange] ALL SELECTED PRICE RANGE RECORDS");
  console.log("Total:", records.length);
  console.table(records);
  console.log(records);
  console.groupEnd();
}

async function addApiStats(delta) {
  const state = await getState();
  const patch = Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, Number(state[key]) + (Number(value) || 0)]));
  await patchState(patch);
}

async function appendParseErrors(errors, page, url) {
  if (!errors?.length) return;
  for (const entry of errors) {
    await appendError({ stage: "parse", page, url, row: entry.row, reason: entry.message, at: Date.now() });
  }
}

async function appendError(error) {
  const stored = await chrome.storage.local.get(ERRORS_KEY);
  const errors = [...(stored[ERRORS_KEY] || []), error].slice(-MAX_ERRORS);
  await chrome.storage.local.set({ [ERRORS_KEY]: errors });
}

async function appendLog(message, eventType = "info", details = {}) {
  const entry = { id: crypto.randomUUID(), at: Date.now(), eventType, message, ...details };
  const stored = await chrome.storage.local.get(LOGS_KEY);
  const logs = [...(stored[LOGS_KEY] || []), entry].slice(-MAX_LOGS);
  await chrome.storage.local.set({ [LOGS_KEY]: logs });
  return entry;
}

async function upsertPlayerLog(record, eventType, message, details = {}) {
  const playerKey = details.playerKey || recordKey(record);
  const stored = await chrome.storage.local.get(LOGS_KEY);
  const logs = Array.isArray(stored[LOGS_KEY]) ? stored[LOGS_KEY] : [];
  const index = logs.findIndex((entry) => entry.playerKey === playerKey);
  const entry = { id: index >= 0 ? logs[index].id : crypto.randomUUID(), at: Date.now(), eventType, message, playerKey, record, ...details };
  const updated = index >= 0 ? logs.map((item, cursor) => cursor === index ? entry : item) : [...logs, entry];
  await chrome.storage.local.set({ [LOGS_KEY]: updated.slice(-MAX_LOGS) });
}

async function ensureLoopAlarm(state) {
  if (!state.userStarted || state.running || !state.nextRunAt) return;
  await chrome.alarms.clear(LOOP_ALARM);
  await chrome.alarms.create(LOOP_ALARM, { when: Math.max(Date.now(), Number(state.nextRunAt)) });
}

function delay(ms, token) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDelays.delete(timer);
      if (token !== runToken) reject(new DOMException("Price Range Sync finished", "AbortError"));
      else resolve();
    }, ms);
    pendingDelays.set(timer, () => {
      clearTimeout(timer);
      reject(new DOMException("Price Range Sync finished", "AbortError"));
    });
  });
}

function cancelPendingDelays() {
  for (const cancel of pendingDelays.values()) cancel();
  pendingDelays.clear();
}
