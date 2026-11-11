import { FUTBIN_CHALLENGE_MAX_WAIT_MS, futbinChallengeTimeoutError, isFutbinChallengeHtml } from "../futbin/challenge.js";
import { marketPayload, readMarket } from "./parser.js";

const MODULE = "market";
const STATE_KEY = "marketSyncState";
const SOURCE_URL = "https://www.futbin.com/market";
const API_PATH = "sync/futbin-market";
const LOAD_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 45_000;
const READ_STEP_MS = 1_000;
const API_TIMEOUT_MS = 30_000;
const API_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 5_000;
const API_CONFIG = globalThis.FutbinSyncApiConfig;
const FC_SYNC_ENABLED_KEY = "fcSyncEnabled";

let runToken = 0;
let activeTabId = null;
let activeController = null;
const pendingDelays = new Map();

const initialState = {
  running: false, runOnce: true, centralManaged: false, centralRunId: null, waitingForNextRun: false,
  status: "Hazır", apiBaseUrl: "", sourceUrl: SOURCE_URL,
  parsedPlayers: 0, savedPlayers: 0, skippedPlayers: 0, unmatchedPlayers: 0, replacedPlayers: 0,
  startedAt: null, completedAt: null, updatedAt: null, nextRunAt: null,
  awaitingFutbinVerification: false, futbinChallengeUrl: null, futbinChallengeTabId: null, futbinChallengeDetectedAt: null,
  logs: [], errors: []
};

chrome.runtime.onInstalled.addListener(() => resetIdle("Hazır - merkezi başlatma bekleniyor"));
chrome.runtime.onStartup.addListener(() => resetIdle("Hazır - merkezi başlatma bekleniyor"));
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.futbinSyncModule !== MODULE) return false;
  handleMessage(message).then(respond).catch((error) => respond({ ok: false, error: error.message || String(error) }));
  return true;
});

globalThis.FutbinSyncModuleControls = globalThis.FutbinSyncModuleControls || {};
globalThis.FutbinSyncModuleControls.market = {
  getSnapshot: async () => ({ ok: true, state: await getState() }),
  start: (options = {}) => startSync(options),
  stop: stopSync
};

async function handleMessage(message) {
  await API_CONFIG.ready;
  if (message.type === "GET_SNAPSHOT") return { ok: true, state: await getState() };
  if (message.type === "START_SYNC") return startSync({ apiBaseUrl: message.apiBaseUrl });
  if (message.type === "STOP_SYNC") return stopSync();
  if (message.type === "CLEAR_SYNC") {
    await stopSync();
    await setState({ ...initialState, apiBaseUrl: API_CONFIG.defaultBaseUrl() });
    return { ok: true };
  }
  return { ok: false, error: "Bilinmeyen mesaj" };
}

async function resetIdle(status) {
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  await setState({ ...initialState, ...(saved || {}), running: false, waitingForNextRun: false, nextRunAt: null, awaitingFutbinVerification: false, status });
}

// `scheduled`: started by the central sync's 10-minute timer, so it is allowed while the central sync runs but is not one of its rounds.
async function startSync({ apiBaseUrl, centralManaged = false, centralRunId = null, scheduled = false } = {}) {
  await API_CONFIG.ready;
  if (!centralManaged && !scheduled && await isFcSyncEnabled()) return { ok: false, error: "Merkezi sync çalışırken tekil Market başlatılamaz." };
  const existing = await getState();
  if (existing.running) return { ok: true, state: existing, alreadyRunning: true };
  const token = ++runToken;
  const base = API_CONFIG.allowedBaseUrl(apiBaseUrl || existing.apiBaseUrl || API_CONFIG.defaultBaseUrl());
  const startedAt = Date.now();
  await setState({ ...initialState, running: true, centralManaged, centralRunId, apiBaseUrl: base, startedAt, updatedAt: startedAt,
    status: "Futbin Market okunuyor", logs: [logEntry(`Futbin Market turu başladı · API: ${base}`)] });
  runSync(token).catch((error) => failRun(token, error));
  return { ok: true, state: await getState() };
}

async function runSync(token) {
  const market = await readMarketPage(token);
  assertActive(token);
  const capturedAt = new Date().toISOString();
  await patchState({ parsedPlayers: market.count, status: `${market.count} kart okundu · API'ye gönderiliyor` });
  await appendLog(`Futbin Market okundu · ${market.count} kart (${listSummary(market.players)})`);
  const result = await postMarket(token, marketPayload(market, { sourceUrl: SOURCE_URL, capturedAt }));
  assertActive(token);
  const data = result?.data || {};
  const unmatched = Array.isArray(data.unmatched_futbin_player_ids) ? data.unmatched_futbin_player_ids : [];
  const apiErrors = (Array.isArray(data.errors) ? data.errors : []).map((error) => (typeof error === "string" ? error : error?.message || JSON.stringify(error)));
  await patchState({
    running: false, waitingForNextRun: false, completedAt: Date.now(), nextRunAt: null,
    savedPlayers: Number(data.saved) || 0, skippedPlayers: Number(data.skipped) || 0, replacedPlayers: Number(data.deleted) || 0, unmatchedPlayers: unmatched.length,
    status: result?.message || "Tur tamamlandı", errors: apiErrors,
    logs: [...(await getState()).logs, logEntry(result?.message || "Tur tamamlandı"), ...(unmatched.length ? [logEntry(`player tablosunda olmayan Futbin ID: ${unmatched.join(", ")}`)] : [])].slice(-200)
  });
  const finished = await getState();
  if (finished.centralManaged) notifyCentralRoundFinished(finished, true);
}

// Opens the market page in a background tab, waits for the cards to be drawn, reads them and closes the tab.
async function readMarketPage(token) {
  const tab = await chrome.tabs.create({ url: SOURCE_URL, active: false });
  activeTabId = tab.id;
  await appendLog(`Futbin sekmesi açıldı · tab ${tab.id || "--"}`);
  try {
    await waitForTabLoad(tab.id, token);
    let deadline = Date.now() + READ_TIMEOUT_MS;
    let challengeSince = null;
    while (true) {
      assertActive(token);
      const result = await executeInTab(tab.id, readMarket);
      if (result?.ready) {
        if (challengeSince) await patchState({ awaitingFutbinVerification: false, futbinChallengeUrl: null, futbinChallengeTabId: null, futbinChallengeDetectedAt: null });
        return result;
      }
      if (!challengeSince && (result?.challenge || isFutbinChallengeHtml(await executeInTab(tab.id, () => document.documentElement.outerHTML)))) {
        challengeSince = Date.now();
        deadline = challengeSince + FUTBIN_CHALLENGE_MAX_WAIT_MS;
        await focusTab(tab.id);
        await patchState({ awaitingFutbinVerification: true, futbinChallengeUrl: SOURCE_URL, futbinChallengeTabId: tab.id, futbinChallengeDetectedAt: challengeSince,
          status: "Futbin doğrulaması bekleniyor — açık sekmede devam edin" });
        await appendLog("Futbin Cloudflare doğrulaması algılandı; açık sekmede doğrulama bekleniyor");
      }
      if (Date.now() >= deadline) {
        throw new Error(challengeSince ? futbinChallengeTimeoutError(SOURCE_URL) : "Futbin Market sayfasında oyuncu kartı bulunamadı.");
      }
      await delay(READ_STEP_MS);
    }
  } finally {
    activeTabId = null;
    await closeTab(tab.id);
  }
}

function waitForTabLoad(tabId, token) {
  return new Promise((resolve) => {
    const finish = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); pendingDelays.delete(timer); resolve(); };
    const listener = (id, change) => { if (id === tabId && change.status === "complete") finish(); };
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab?.status === "complete") finish(); }).catch(() => {});
    // A finish/stop while waiting must not hold the worker for the whole load timeout.
    pendingDelays.set(timer, finish);
  }).then(() => assertActive(token));
}

async function executeInTab(tabId, func) {
  try { return (await chrome.scripting.executeScript({ target: { tabId }, func }))?.[0]?.result ?? null; } catch { return null; }
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* The tab may already be closed. */ }
}

async function closeTab(tabId) {
  if (!Number.isInteger(Number(tabId))) return;
  try { await chrome.tabs.remove(tabId); } catch { /* Already closed. */ }
}

async function postMarket(token, payload) {
  await API_CONFIG.ready;
  const url = new URL(API_PATH, API_CONFIG.defaultBaseUrl()).href;
  let lastError;
  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    assertActive(token);
    await patchState({ status: `API'ye gönderiliyor · deneme ${attempt}/${API_ATTEMPTS}` });
    activeController = new AbortController();
    const timeout = setTimeout(() => activeController?.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: activeController.signal });
      const body = await response.text();
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body }; }
      if (!response.ok || data?.result === false) throw new Error(data?.message || `API HTTP ${response.status}`);
      return data;
    } catch (error) {
      assertActive(token);
      lastError = error.name === "AbortError" ? new Error(`API timeout (${API_TIMEOUT_MS / 1000} sn): ${url}`) : error;
      if (attempt < API_ATTEMPTS) await delay(API_RETRY_DELAY_MS);
    } finally {
      clearTimeout(timeout);
      activeController = null;
    }
  }
  throw lastError;
}

async function failRun(token, error) {
  if (token !== runToken) return;
  await closeTab(activeTabId);
  const state = await getState();
  const failed = await patchState({
    running: false, waitingForNextRun: false, nextRunAt: null, awaitingFutbinVerification: false, status: "Tur tamamlanamadı",
    errors: [...state.errors, error.message || String(error)], logs: [...state.logs, logEntry("Futbin Market turu tamamlanamadı")].slice(-200)
  });
  if (failed.centralManaged) notifyCentralRoundFinished(failed, false);
}

async function stopSync() {
  runToken++;
  activeController?.abort();
  for (const [timer, resolve] of pendingDelays) { clearTimeout(timer); resolve(); }
  pendingDelays.clear();
  await closeTab(activeTabId);
  activeTabId = null;
  const state = await getState();
  await patchState({ running: false, waitingForNextRun: false, nextRunAt: null, awaitingFutbinVerification: false, futbinChallengeUrl: null, futbinChallengeTabId: null,
    status: state.running ? "Sonlandırıldı" : state.status });
  return { ok: true, state: await getState() };
}

function notifyCentralRoundFinished(state, ok) {
  const message = { futbinSyncModule: "fc-sync", type: "MODULE_ROUND_FINISHED", module: MODULE, runId: state.centralRunId, ok, error: ok ? null : state.status };
  const direct = globalThis.FutbinSyncCentralOrchestrator;
  if (typeof direct?.moduleRoundFinished === "function") { void direct.moduleRoundFinished(message); return; }
  chrome.runtime.sendMessage(message).catch(() => { /* A stale event is ignored by the central run id. */ });
}

function listSummary(players) {
  const counts = new Map();
  for (const player of players) counts.set(`${player.period} ${player.direction === "gain" ? "↑" : "↓"} ${player.platform}`, (counts.get(`${player.period} ${player.direction === "gain" ? "↑" : "↓"} ${player.platform}`) || 0) + 1);
  return [...counts].map(([list, count]) => `${list}: ${count}`).join(" · ");
}

function assertActive(token) { if (token !== runToken) throw new DOMException("Sync finished", "AbortError"); }
async function isFcSyncEnabled() { return Boolean((await chrome.storage.local.get(FC_SYNC_ENABLED_KEY))[FC_SYNC_ENABLED_KEY]); }
async function getState() { return { ...initialState, ...((await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {}) }; }
async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", futbinSyncModule: MODULE, state }).catch(() => {});
  return state;
}
async function patchState(patch) { return setState({ ...(await getState()), ...patch, updatedAt: Date.now() }); }
async function appendLog(message) { const state = await getState(); await patchState({ logs: [...state.logs, logEntry(message)].slice(-200) }); }
function logEntry(message) { return { at: Date.now(), message }; }
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingDelays.delete(timer); resolve(); }, ms);
    pendingDelays.set(timer, resolve);
  });
}
