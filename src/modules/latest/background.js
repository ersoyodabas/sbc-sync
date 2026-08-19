import { FUTBIN_CHALLENGE_MAX_WAIT_MS, futbinChallengeTimeoutError, isFutbinChallengeHtml } from "../futbin/challenge.js";

const STATE_KEY = "latestSyncState";
const RECORDS_KEY = "latestPlayerRecords";
const LOGS_KEY = "latestSyncLogs";
const ERRORS_KEY = "latestSyncErrors";
const AUTO_RUN_KEY = "latestAutoRunEnabled";
const FC_SYNC_ENABLED_KEY = "fcSyncEnabled";
const PAGE_TIMEOUT_ALARM = "latest-futbin-sync-page-timeout";
const JOB_ADVANCE_ALARM = "latest-futbin-sync-job-advance";
const SYNC_LOOP_ALARM = "latest-futbin-sync-loop";
const SYNC_LOOP_DELAY_MS = 60 * 60 * 1000;
const FUTBIN_TARGET_DOM_MAX_WAIT_MS = 60000;
let ENV = null;
async function getEnv() {
  if (ENV) return ENV;
  ENV = {};
  try {
    const response = await fetch(chrome.runtime.getURL(".env"));
    const text = await response.text();
    text.split("\n").forEach((line) => {
      const [key, ...rest] = line.split("=");
      if (key && key.trim() && !key.trim().startsWith("#")) {
        ENV[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      }
    });
  } catch (e) {
    console.warn("[Env] .env dosyası okunamadı", e);
  }
  return ENV;
}
// Canlı dashboard yalnızca son çalışma olaylarını gösterir; gürültüyü sınırlı tutarız.
const MAX_LOGS = 100;
const MAX_ERRORS = 1;
const FUTBIN_LATEST_URL = "https://www.futbin.com/latest";
const API_CONFIG = globalThis.FutbinSyncApiConfig;
const DEFAULT_API_BASE_URL = API_CONFIG.defaultBaseUrl();
const DELETE_LOW_RATIO_COIN_CARDS_ENDPOINT = "CoinCard/deleteLowedRatioCards";
const COIN_CARD_LIST_ENDPOINT = "coincard";
const LATEST_COIN_CARD_PAGES = 2;
const SPECIAL_QUALITY_IMAGE_URL = "https://cdn3.futbin.com/content/fifa26/img/cards/tiny/3_gold.png?fm=png&ixlib=java-2.1.0&verzion=1&w=128&s=d72e95665680dee8e3818602d714323a";
const EXTENSION_RUNNER_ID = "coin-cards";
const EXTENSION_OPERATIONS = ["coin-cards"];
const RUNNER_IDS = [EXTENSION_RUNNER_ID];
const RUNNER_OPERATIONS = { [EXTENSION_RUNNER_ID]: EXTENSION_OPERATIONS };
const FINISHED_STATUS = "Finished";
let stateWriteQueue = Promise.resolve();
let storageWriteQueue = Promise.resolve();
let runToken = 0;
const controlledTabCloseIds = new Set();
const activeRequestControllers = new Set();
const pendingDelayResolvers = new Map();
const activePageDispatches = new Set();

function syncLog(step, details = {}) {
  if (details?.type === "GET_SNAPSHOT" || String(step || "").includes("GET_SNAPSHOT")) return;
  console.log(`[LatestPlayerSync] ${step}`, { at: new Date().toISOString(), ...details });
}

function syncError(step, error, details = {}) {
  if (details?.type === "GET_SNAPSHOT" || String(step || "").includes("GET_SNAPSHOT")) return;
  console.error(`[LatestPlayerSync] ${step}`, {
    at: new Date().toISOString(),
    error: error?.message || String(error),
    stack: error?.stack,
    ...details
  });
}

const emptyState = {
  running: false,
  queue: [],
  currentJobIndex: -1,
  currentPage: 0,
  totalPages: 0,
  currentUrl: null,
  tabId: null,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  waitMs: 5000,
  lookups: null,
  currentPlayers: {},
  currentLatest: null,
  latestCoinCardJobsSnapshot: [],
  latestCoinCardJobsSnapshotLoaded: false,
  newlyInsertedCoinCardIds: [],
  latestUpdatedCoinCardIds: [],
  currentSkipped: 0,
  pagesAttempted: 0,
  pagesSucceeded: 0,
  failedPages: [],
  completedClubs: 0,
  operations: ["club-players"],
  savedPlayers: 0,
  skippedPlayers: 0,
  clubSaveResults: {},
  logs: [],
  runOnce: false,
  centralManaged: false,
  centralRunId: null,
  nextRunAt: null,
  runStartedAt: null,
  status: "Hazır",
  error: null,
  awaitingFutbinVerification: false,
  futbinChallengeDetectedAt: null,
  futbinChallengeTabId: null,
  futbinChallengeUrl: null,
  updatedAt: null
};

chrome.runtime.onInstalled.addListener(async () => {
  await API_CONFIG.ready;
  const saved = await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY, AUTO_RUN_KEY]);
  if (!saved[STATE_KEY]) await setState(emptyState);
  if (!saved[RECORDS_KEY]) await chrome.storage.local.set({ [RECORDS_KEY]: [] });
  if (!saved[LOGS_KEY]) await chrome.storage.local.set({ [LOGS_KEY]: [] });
  if (!saved[ERRORS_KEY]) await chrome.storage.local.set({ [ERRORS_KEY]: [] });
  await chrome.storage.local.set({ [AUTO_RUN_KEY]: false });
  await pauseSync();
});

chrome.runtime.onStartup.addListener(async () => {
  if (!await isFcSyncEnabled()) {
    await pauseSync();
    return;
  }
  // Merkezi orchestrator aktif turu yeniden başlatır; modül kendi başına tur başlatmaz.
  syncLog("FC Sync etkin; Latest başlangıcı merkezi orchestrator'a bırakıldı");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.futbinSyncModule !== "latest") return false;
  if (message?.type !== "GET_SNAPSHOT") {
    syncLog("Mesaj alındı", { type: message?.type, senderTabId: sender.tab?.id ?? null });
  }
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(async (error) => {
      syncError("Mesaj işlenirken hata oluştu", error, { type: message?.type, senderTabId: sender.tab?.id ?? null });
      await failSync(error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

globalThis.FutbinSyncModuleControls = globalThis.FutbinSyncModuleControls || {};
globalThis.FutbinSyncModuleControls.latest = {
  getSnapshot: async () => ({ ok: true, ...(await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY])) }),
  start: async ({ apiBaseUrl, waitMs, operations, runOnce = false, centralManaged = false, centralRunId = null } = {}) => {
    await chrome.storage.local.set({ [AUTO_RUN_KEY]: !runOnce });
    return startParallelSync(apiBaseUrl, waitMs, operations || EXTENSION_OPERATIONS, { runOnce, centralManaged, centralRunId });
  },
  stop: async () => {
    await chrome.storage.local.set({ [AUTO_RUN_KEY]: false });
    return pauseSync();
  }
};

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_SYNC":
      if (await isFcSyncEnabled()) return { ok: false, error: "Merkezi sync çalışırken tekil Latest Player Sync başlatılamaz." };
      await chrome.storage.local.set({ [AUTO_RUN_KEY]: false });
      return startParallelSync(message.apiBaseUrl, message.waitMs, message.operations, { runOnce: true });
    case "RESUME_SYNC":
      return resumePausedSync();
    case "STOP_SYNC":
      await chrome.storage.local.set({ [AUTO_RUN_KEY]: false });
      return pauseSync(message.operations);
    case "CLEAR_SYNC":
      await clearAllRunnerAlarms();
      {
        const current = await getState();
        for (const run of Object.values(current.runs || {})) {
          if (run?.tabId) {
            await closeRunnerTab(run.tabId, run);
          }
        }
        if (current.tabId) {
            await closeRunnerTab(current.tabId, current);
        }
      }
      await setState({ ...emptyState, apiBaseUrl: message.apiBaseUrl || emptyState.apiBaseUrl });
      await chrome.storage.local.set({ [RECORDS_KEY]: [], [LOGS_KEY]: [], [ERRORS_KEY]: [] });
      await chrome.storage.local.set({ [AUTO_RUN_KEY]: false });
      return { ok: true, state: await getState() };
    case "GET_SNAPSHOT":
      // Önceki sürümlerden kalan büyük popup koleksiyonunu da temizle.
      {
        const snapshot = await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY]);
        const latestState = await getState(EXTENSION_RUNNER_ID);
        snapshot[RECORDS_KEY] = [];
        snapshot[LOGS_KEY] = finalizeExtraProcessingLogs(snapshot[LOGS_KEY] || [], latestState).slice(-MAX_LOGS);
        snapshot[ERRORS_KEY] = (snapshot[ERRORS_KEY] || []).slice(0, 1);
        await chrome.storage.local.set({
          [RECORDS_KEY]: snapshot[RECORDS_KEY],
          [LOGS_KEY]: snapshot[LOGS_KEY],
          [ERRORS_KEY]: snapshot[ERRORS_KEY]
        });
        return { ok: true, ...snapshot };
      }
    case "SYNC_PAGE_RESULT":
      return handlePageResult(message, sender);
    case "SYNC_PAGE_FAILED":
      return handleReportedPageFailure(message, sender);
    case "SYNC_PAGE_CRITICAL":
      return handleCriticalPageError(message, sender);
    case "ADVANCE_SYNC":
      return advanceFromContentTimer(message, sender);
    default:
      return { ok: false, error: "Bilinmeyen mesaj" };
  }
}

async function ensureLatestAutoRun(reason) {
  await API_CONFIG.ready;
  if (!await isFcSyncEnabled()) {
    syncLog("Latest otomatik başlangıç merkezi durdurma nedeniyle atlandı", { reason });
    return { ok: true, skipped: true, reason: "central-sync-stopped" };
  }
  const stored = await chrome.storage.local.get(AUTO_RUN_KEY);
  if (stored[AUTO_RUN_KEY] === false) {
    syncLog("Latest otomatik başlangıç kullanıcı Stop tercihi nedeniyle atlandı", { reason });
    return { ok: true, skipped: true, reason: "user-stopped" };
  }

  await chrome.storage.local.set({ [AUTO_RUN_KEY]: true });
  await resumeRunningSync();
  const state = await getState(EXTENSION_RUNNER_ID);
  if (state.running || (state.userStarted && state.nextRunAt)) {
    if (!state.running && state.userStarted && state.nextRunAt) {
      await startImportantAfterLatestCompletion();
    }
    return { ok: true, resumed: true, state };
  }

  syncLog("Latest otomatik çalışma başlatılıyor", { reason });
  return startParallelSync(
    API_CONFIG.defaultBaseUrl(),
    API_CONFIG.number("WAIT_MS", 5000),
    EXTENSION_OPERATIONS
  );
}

async function startParallelSync(rawApiBaseUrl, rawWaitMs, rawOperations, runOptions = {}) {
  if (!runOptions.centralManaged && await isFcSyncEnabled()) {
    return { ok: false, error: "Merkezi sync çalışırken tekil Latest Player Sync başlatılamaz." };
  }
  const token = ++runToken;
  const operations = normalizeOperations(rawOperations);
  if (!operations.length) throw new Error("En az bir işlem seçilmelidir.");
  const runnerIds = [...new Set(operations.map(operationRunnerId).filter(Boolean))];
  const results = await Promise.all(runnerIds.map(async (runnerId) => {
    try {
      const run = await getState(runnerId);
      const nextRunCount = (run.runCount || 0) + 1;
      return await startFreshSync(rawApiBaseUrl, rawWaitMs, RUNNER_OPERATIONS[runnerId], nextRunCount, runnerId, false, token, runOptions);
    } catch (error) {
      const run = await getState(runnerId);
      await failSync(error.message || String(error), run);
      return { ok: false, runnerId, error: error.message || String(error) };
    }
  }));
  if (!results.some((result) => result?.ok)) throw new Error(results.map((result) => result?.error).filter(Boolean).join("; ") || "Sync başlatılamadı.");
  return { ok: true, state: await getState(), results };
}

async function startFreshSync(rawApiBaseUrl, rawWaitMs, rawOperations, runCount = 0, rawRunnerId = null, isScheduledStart = false, token = runToken, runOptions = {}) {
  const operations = normalizeOperations(rawOperations);
  if (!operations.length) throw new Error("En az bir işlem seçilmelidir.");
  const runnerId = rawRunnerId || operationRunnerId(operations[0]);
  if (!runnerId) throw new Error("Desteklenmeyen sync işlemi.");
  const previous = await getState(runnerId);
  if (previous.running && !isLoopRestartDue(previous)) {
    return { ok: true, state: previous, alreadyRunning: true };
  }

  const env = await getEnv();
  if (token !== runToken) return { ok: false, stopped: true, state: await getState(runnerId) };

  const apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl || DEFAULT_API_BASE_URL);
  const waitMs = Math.min(30000, Math.max(5000, Number(rawWaitMs || env.WAIT_MS) || 5000));
  const runStartedAt = Date.now();

  const queue = [];
  let lookups = null;
  let latestCoinCardJobsSnapshot = [];
  let runLogs = [];
  if (operations.includes("coin-cards")) {
    const latestPreparation = await prepareLatestCoinCardRun({
      apiBaseUrl,
      waitMs,
      runCount,
      runStartedAt,
      runnerId
    });
    latestCoinCardJobsSnapshot = latestPreparation.jobs;
    runLogs = latestPreparation.logs;
  }
  if (operations.includes("coin-cards")) {
    queue.push({
      id: "latest",
      label: "Latest Coin Cards",
      url: FUTBIN_LATEST_URL,
      operation: "coin-card-latest"
    });
  }
  if (operations.includes("club-players")) {
    const response = await apiRequest(apiBaseUrl, "sync/futbin-player-jobs");
    const jobs = Array.isArray(response?.data?.jobs) ? response.data.jobs : [];
    lookups = response?.data?.lookups || null;
    validateLookups(lookups);
    queue.push(...jobs.map((job) => ({ ...job, operation: "club-players" })));
  }
  if (token !== runToken) return { ok: false, stopped: true, state: await getState(runnerId) };
  await chrome.alarms.clear(pageTimeoutAlarmName(runnerId));
  await chrome.alarms.clear(syncLoopAlarmName(runnerId));

  if (previous.tabId) {
    await closeRunnerTab(previous.tabId, previous);
  }
  if (queue.length === 0) {
    const state = {
      ...emptyState,
      runnerId,
      apiBaseUrl,
      waitMs,
      operations,
      runCount,
      runStartedAt,
      runOnce: Boolean(runOptions.runOnce),
      centralManaged: Boolean(runOptions.centralManaged),
      centralRunId: runOptions.centralRunId ?? null,
      status: "Seçilen işlemler için bekleyen iş yok",
      updatedAt: Date.now()
    };
    await setState(state);
    if (state.centralManaged) await notifyCentralRoundFinished(state, true);
    return { ok: true, state };
  }

  const firstJob = queue[0];
  const tab = await createRunnerTab(operations);
  if (token !== runToken) {
    await closeRunnerTab(tab.id);
    return { ok: false, stopped: true, state: await getState(runnerId) };
  }
  const firstStatus = "Futbin sekmesi açılıyor";
  const state = {
    ...emptyState,
    runnerId,
    running: true,
    userStarted: !runOptions.runOnce,
    runOnce: Boolean(runOptions.runOnce),
    centralManaged: Boolean(runOptions.centralManaged),
    centralRunId: runOptions.centralRunId ?? null,
    queue,
    operations,
    lookups,
    latestCoinCardJobsSnapshot,
    latestCoinCardJobsSnapshotLoaded: operations.includes("coin-cards"),
    runCount,
    runStartedAt,
    currentJobIndex: 0,
    currentPage: 1,
    totalPages: 1,
    currentUrl: buildJobUrl(firstJob, 1),
    tabId: tab.id || null,
    apiBaseUrl,
    waitMs,
    logs: runLogs,
    status: jobStatus(firstJob, 0, queue.length, firstStatus),
    updatedAt: Date.now()
  };
  await setState(state);
  await navigateToCurrentPage(state);
  return { ok: true, state };
}

async function prepareLatestCoinCardRun({ apiBaseUrl, waitMs, runCount, runStartedAt, runnerId }) {
  const logState = {
    runnerId,
    apiBaseUrl,
    waitMs,
    runCount,
    runStartedAt,
    queue: [{ id: "latest", label: "Latest Coin Cards", operation: "coin-card-latest" }],
    currentJobIndex: 0,
    currentPage: 0,
    currentUrl: null,
    status: "Latest Coin Cards hazırlanıyor"
  };

  await resetLatestSyncLogs();
  await appendLatestEventLog(logState, {
    eventType: "run-start",
    message: "Latest Coin Cards sync başladı",
    startedAt: runStartedAt
  });

  const cleanupStartedAt = Date.now();
  await appendLatestEventLog(logState, {
    eventType: "cleanup-start",
    message: "Düşük ratiolu kart temizliği başladı",
    startedAt: cleanupStartedAt
  });

  try {
    const deleteLowRatioResponse = await apiRequest(apiBaseUrl, DELETE_LOW_RATIO_COIN_CARDS_ENDPOINT, {
      method: "DELETE"
    });
    const deletedLowRatioCount = readDeletedCount(deleteLowRatioResponse);
    await appendLatestEventLog(logState, {
      eventType: "cleanup-end",
      message: "Düşük ratiolu kart temizliği tamamlandı",
      startedAt: cleanupStartedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - cleanupStartedAt,
      deleted: deletedLowRatioCount
    });
    syncLog("Düşük ratiolu Coin Card temizliği tamamlandı", {
      ...stateLogDetails(logState),
      response: deleteLowRatioResponse?.data || deleteLowRatioResponse || null
    });
  } catch (error) {
    await appendLatestEventLog(logState, {
      eventType: "cleanup-end",
      message: "Düşük ratiolu kart temizliği hata verdi",
      startedAt: cleanupStartedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - cleanupStartedAt,
      error: error?.message || String(error)
    });
    throw error;
  }

  const snapshotStartedAt = Date.now();
  const jobs = await fetchCoinCardUpdateJobs(apiBaseUrl);
  await appendLatestEventLog(logState, {
    eventType: "db-snapshot-loaded",
    message: "Mevcut coin card snapshot yüklendi",
    startedAt: snapshotStartedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - snapshotStartedAt,
    total: jobs.length
  });

  await appendLatestStepLog(logState, {
    eventType: "step1-start",
    message: "STEP 1/2\nDiscovering new Coin Card players"
  });
  const storedLogs = await chrome.storage.local.get(LOGS_KEY);
  return {
    jobs,
    logs: Array.isArray(storedLogs[LOGS_KEY]) ? storedLogs[LOGS_KEY] : []
  };
}

async function resumePausedSync() {
  if (!await isFcSyncEnabled()) return { ok: false, stopped: true, state: await getState() };
  const state = await getState();
  if (state.running) return { ok: true, state };
  if (isFinishedState(state)) throw new Error("Yeniden başlatmak için Start Sync düğmesine basın.");
  if (!state.queue?.length || state.currentJobIndex < 0 || state.currentJobIndex >= state.queue.length) {
    throw new Error("Devam ettirilecek tarama bulunamadı.");
  }

  let tab;
  try { tab = state.tabId ? await chrome.tabs.get(state.tabId) : null; } catch { /* Yeni sekme oluştur. */ }
  if (!tab) tab = await createRunnerTab(state.operations);
  const statusSuffix = "Tarama sürdürülüyor";
  const resumed = {
    ...state,
    running: true,
    tabId: tab.id || null,
    error: null,
    nextRunAt: null,
    status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, statusSuffix),
    updatedAt: Date.now()
  };
  await setState(resumed);
  await navigateToCurrentPage(resumed);
  return { ok: true, state: resumed };
}

async function resumeRunningSync() {
  const root = await getState();
  if (root.runs) {
    for (const runnerId of RUNNER_IDS) {
      const run = await getState(runnerId);
      if (run.running || (run.userStarted && run.nextRunAt)) await resumeRunningRunner(run);
    }
    return;
  }
  const state = root;
  await resumeRunningRunner(state);
}

async function resumeRunningRunner(state) {
  if (isFinishedState(state)) return;
  if (!state.running) {
    if (state.userStarted && state.nextRunAt && !state.currentUrl) {
      if (Number(state.nextRunAt) <= Date.now()) {
        await runScheduledLatestSync(state);
      } else {
        syncLog("Bekleyen otomatik çalışma yeniden planlanıyor", stateLogDetails(state));
        await scheduleLoopAlarm(state);
      }
    }
    return;
  }
  if (state.nextRunAt) {
    if (state.currentUrl) {
      syncLog("Bekleyen iş yeniden planlanıyor", stateLogDetails(state));
      await scheduleJobAdvance(state);
      return;
    }
    await chrome.alarms.clear(syncLoopAlarmName(state));
    await setState({
      ...state,
      running: false,
      userStarted: false,
      nextRunAt: null,
      status: "Hazır - başlatma bekleniyor",
      updatedAt: Date.now()
    });
    return;
  }
  let tab;
  try { tab = state.tabId ? await chrome.tabs.get(state.tabId) : null; } catch { /* Yeni sekme oluştur. */ }
  if (!tab) tab = await createRunnerTab(state.operations || RUNNER_OPERATIONS[state.runnerId]);
  const resumed = { ...state, tabId: tab.id || null, nextRunAt: null, updatedAt: Date.now() };
  await setState(resumed);
  await navigateToCurrentPage(resumed);
}

async function pauseSync(rawOperations = null) {
  runToken++;
  const root = await getState();
  const operations = rawOperations ? normalizeOperations(rawOperations) : [];
  const requestedRunnerIds = operations.length
    ? [...new Set(operations.map(operationRunnerId).filter(Boolean))]
    : [];
  const states = root.runs
    ? (requestedRunnerIds.length ? requestedRunnerIds.map((runnerId) => root.runs[runnerId]).filter(Boolean) : Object.values(root.runs))
    : [root];
  if (requestedRunnerIds.length) {
    await Promise.all(requestedRunnerIds.flatMap((runnerId) => [
      chrome.alarms.clear(pageTimeoutAlarmName(runnerId)),
      chrome.alarms.clear(jobAdvanceAlarmName(runnerId)),
      chrome.alarms.clear(syncLoopAlarmName(runnerId))
    ]));
  } else {
    await clearAllRunnerAlarms();
  }
  for (const controller of activeRequestControllers) controller.abort();
  activeRequestControllers.clear();
  cancelPendingDelays();
  for (const state of states) {
    const stopped = {
      ...state,
      running: false,
      userStarted: false,
      runOnce: false,
      centralManaged: false,
      centralRunId: null,
      queue: [],
      currentJobIndex: -1,
      currentPage: 0,
      totalPages: 0,
      currentUrl: null,
      tabId: null,
      currentPlayers: {},
      currentLatest: null,
      latestCoinCardJobsSnapshot: [],
      latestCoinCardJobsSnapshotLoaded: false,
      newlyInsertedCoinCardIds: [],
      latestUpdatedCoinCardIds: [],
      awaitingFutbinVerification: false,
      futbinChallengeDetectedAt: null,
      futbinChallengeTabId: null,
      futbinChallengeUrl: null,
      nextRunAt: null,
      status: "Hazır",
      error: null,
      updatedAt: Date.now()
    };
    await setState(stopped);
    if (state.tabId) {
      await closeRunnerTab(state.tabId, state);
    }
  }
  return { ok: true, state: await getState() };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete" && !changeInfo.url) return;
  const state = await getStateByTabId(tabId);
  const observedUrl = changeInfo.url || tab.url || "";
  if (!await isActiveRun(state) || tabId !== state.tabId || !matchesCurrentPage(observedUrl, state)) return;
  await dispatchLatestPageWhenReady(tabId, observedUrl, state, changeInfo.status || (changeInfo.url ? "url" : "update"));
});

async function dispatchLatestPageWhenReady(tabId, observedUrl, state, trigger) {
  const dispatchKey = latestPageDispatchKey(state, tabId);
  if (activePageDispatches.has(dispatchKey)) return;
  activePageDispatches.add(dispatchKey);
  syncLog("Futbin hedef DOM polling başlatıldı", { ...stateLogDetails(state), loadedUrl: observedUrl, trigger });
  await appendLatestTabLog(state, "Futbin hedef DOM polling başlatıldı", "tab-dom-polling", {
    tabId,
    loadedUrl: observedUrl,
    trigger
  });
  try {
    await waitForFutbinTargetHtml(tabId, observedUrl || state.currentUrl, state);
    const liveState = await getStateByTabId(tabId);
    if (!isCurrentDispatchState(liveState, state, tabId)) return;
    await chrome.alarms.clear(pageTimeoutAlarmName(liveState));
    await appendLatestTabLog(liveState, "Futbin hedef DOM hazır; content script başlatılıyor", "tab-dom-ready", {
      tabId,
      loadedUrl: observedUrl || liveState.currentUrl
    });
    await sendCollectSyncPageMessage(tabId, liveState);
  } catch (error) {
    activePageDispatches.delete(dispatchKey);
    if (!await isActiveRun(state)) return;
    syncError("Content script başlatılamadı", error, stateLogDetails(state));
    await handlePageFailure(`İçerik script'i çalışmadı: ${state.currentUrl}`, state);
  }
}

function latestPageDispatchKey(state, tabId) {
  return [
    state?.runnerId || "legacy",
    state?.runStartedAt || state?.runToken || state?.runCount || 0,
    tabId || "",
    state?.currentPage || 0,
    state?.currentUrl || ""
  ].join("|");
}

function isCurrentDispatchState(liveState, expectedState, tabId) {
  return Boolean(
    liveState?.running &&
    liveState.tabId === tabId &&
    liveState.currentPage === expectedState.currentPage &&
    liveState.currentUrl === expectedState.currentUrl &&
    (!expectedState.runStartedAt || liveState.runStartedAt === expectedState.runStartedAt)
  );
}

async function sendCollectSyncPageMessage(tabId, state) {
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, {
      type: "COLLECT_SYNC_PAGE",
      job: currentJob(state),
      operation: currentJob(state).operation,
      page: state.currentPage,
      latestTotalPages: currentJob(state).operation === "coin-card-latest" ? LATEST_COIN_CARD_PAGES : undefined,
      expectedUrl: state.currentUrl,
      waitMs: futbinRequestDelayMs(state),
      runStartedAt: state.runStartedAt || null
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }
  throw lastError || new Error("Content script mesajı gönderilemedi.");
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (controlledTabCloseIds.delete(tabId)) return;
  const state = await getStateByTabId(tabId);
  if (!await isActiveRun(state) || state.tabId !== tabId) return;
  await recoverRunnerTab(state);
});

async function ensureAutomaticSchedule() {
  const state = await getState(EXTENSION_RUNNER_ID);
  if (!await isFcSyncEnabled()) {
    await chrome.alarms.clear(syncLoopAlarmName(state));
    return state;
  }
  if (isFinishedState(state) || !state.userStarted || !state.nextRunAt || state.running) {
    await chrome.alarms.clear(syncLoopAlarmName(state));
    return state;
  }
  if (Number(state.nextRunAt) <= Date.now()) return runScheduledLatestSync(state);
  await scheduleLoopAlarm(state);
  return state;
}

async function handleSyncLoopAlarm(runnerId) {
  await chrome.alarms.clear(syncLoopAlarmName(runnerId));
  const state = await getState(runnerId);
  if (!await isFcSyncEnabled() || isFinishedState(state) || !state.userStarted || !state.nextRunAt) {
    syncLog("Otomatik çalışma iptal edilmiş; loop alarmı yok sayıldı", { runnerId });
    return;
  }
  if (state.running) {
    syncLog("Loop alarmı geldi ama çalışma zaten aktif", stateLogDetails(state));
    return;
  }
  if (Number(state.nextRunAt) > Date.now()) {
    syncLog("Loop alarmı erken geldi; yeniden planlanıyor", stateLogDetails(state));
    await scheduleLoopAlarm(state);
    return;
  }
  await runScheduledLatestSync(state);
}

async function runScheduledLatestSync(existingState = null) {
  const state = existingState || await getState(EXTENSION_RUNNER_ID);
  if (!await isFcSyncEnabled() || isFinishedState(state) || !state.userStarted) return { ok: false, stopped: true, state };
  syncLog("Otomatik Latest Player Sync başlatılıyor", stateLogDetails(state));
  return startFreshSync(
    state.apiBaseUrl || DEFAULT_API_BASE_URL,
    futbinRequestDelayMs(state),
    state.operations?.length ? state.operations : RUNNER_OPERATIONS[state.runnerId || EXTENSION_RUNNER_ID],
    (state.runCount || 0) + 1,
    state.runnerId || EXTENSION_RUNNER_ID,
    true
  );
}

async function activateRunnerTab(tabId) {
  if (!tabId) return;
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

async function closeRunnerTab(tabId, stateHint = null) {
  if (!tabId) return;
  controlledTabCloseIds.add(tabId);
  const state = stateHint?.runnerId ? stateHint : await getStateByTabId(tabId);
  if (state?.runnerId) await appendLatestTabLog(state, "Futbin sekmesi kapatılıyor", "tab-closing", { tabId });
  const closed = await closeOwnedTab(tabId);
  if (state?.runnerId) await appendLatestTabLog(state, closed ? "Futbin sekmesi kapatıldı" : "Futbin sekmesi kapatılamadı", closed ? "tab-closed" : "tab-close-failed", { tabId });
  setTimeout(() => controlledTabCloseIds.delete(tabId), 30000);
  return closed;
}

async function closeOwnedTab(tabId) {
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
  return false;
}

async function createRunnerTab(operations = []) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  syncLog("Yeni Futbin çalışma sekmesi açıldı", {
    tabId: tab.id || null,
    operations
  });
  return tab;
}

async function recoverRunnerTab(state) {
  if (state.nextRunAt) {
    await chrome.alarms.clear(syncLoopAlarmName(state));
    await setState({
      ...state,
      running: false,
      userStarted: false,
      tabId: null,
      currentUrl: null,
      nextRunAt: null,
      status: "Durduruldu - başlatma bekleniyor",
      updatedAt: Date.now()
    });
    return;
  }
  const tab = await createRunnerTab(state.operations || RUNNER_OPERATIONS[state.runnerId]);
  const statusSuffix = "Çalışma sekmesi yenileniyor";
  const recovered = {
    ...state,
    tabId: tab.id || null,
    status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, statusSuffix),
    updatedAt: Date.now()
  };
  await setState(recovered);
  await navigateToCurrentPage(recovered);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  syncLog("Alarm tetiklendi", { alarm: alarm.name, scheduledTime: alarm.scheduledTime });
  const loopRunnerId = runnerIdFromAlarmName(alarm.name, SYNC_LOOP_ALARM);
  if (loopRunnerId) {
    await handleSyncLoopAlarm(loopRunnerId);
    return;
  }
  const advanceRunnerId = runnerIdFromAlarmName(alarm.name, JOB_ADVANCE_ALARM);
  if (advanceRunnerId) {
    const state = await getState(advanceRunnerId);
    if (!await isActiveRun(state) || !state.currentUrl || !state.nextRunAt) {
      syncLog("Geçersiz veya eski iş alarmı yok sayıldı", stateLogDetails(state));
      return;
    }
    syncLog("Sonraki iş alarm ile başlatılıyor", stateLogDetails(state));
    await performAdvance(state.currentUrl, advanceRunnerId);
    return;
  }
  const timeoutRunnerId = runnerIdFromAlarmName(alarm.name, PAGE_TIMEOUT_ALARM);
  if (!timeoutRunnerId) return;
  const state = await getState(timeoutRunnerId);
  if (!await isActiveRun(state)) return;
  await handlePageFailure(`Sayfa zaman aşımına uğradı: ${state.currentUrl}`, state);
});

async function handlePageResult(message, sender) {
  let state = message.backgroundFetch
    ? await getState(message.runnerId)
    : await getStateByTabId(sender.tab?.id);
  const isCurrent = message.backgroundFetch
    ? state.running && Number(message.page) === state.currentPage && matchesCurrentPage(message.pageUrl, state)
    : isCurrentPageSender(state, message, sender);
  if (!isCurrent || !await isActiveRun(state)) return { ok: false, error: "Eski veya durdurulmuş sayfa sonucu yok sayıldı." };

  const job = currentJob(state);
  syncLog("Sayfa sonucu alındı", { ...stateLogDetails(state), receivedUrl: message.pageUrl });
  if (!message.backgroundFetch && sender.tab?.id) {
    await appendLatestTabLog(state, "Futbin sayfası okundu; sekme kapatılıyor", "tab-read-complete", {
      tabId: sender.tab.id,
      url: message.pageUrl
    });
    await closeRunnerTab(sender.tab.id, state);
    state = { ...state, tabId: null, updatedAt: Date.now() };
    await setState(state);
  }
  const isLatestCoinCardJob = job.operation === "coin-card-latest";
  const isCoinCardJob = job.operation === "coin-cards";
  const totalPages = isLatestCoinCardJob ? LATEST_COIN_CARD_PAGES : isCoinCardJob ? 1 : state.currentPage === 1
    ? Math.max(1, Number(message.totalPages) || 1)
    : state.totalPages;
  const players = { ...(state.currentPlayers || {}) };
  let skipped = 0;
  const mappedPlayers = [];
  const pageErrors = normalizePageErrors(message.errors, job, state);
  let currentLatest = state.currentLatest;
  if (isLatestCoinCardJob) {
    const pageLatest = message.latestCoinCards || { sourceDate: null, cards: [] };
    const existingCards = Array.isArray(currentLatest?.cards) ? currentLatest.cards : [];
    const incomingCards = (Array.isArray(pageLatest.cards) ? pageLatest.cards : []).filter((card) => {
      try {
        assertValidLatestCoinCardPrices(card);
        return true;
      } catch (error) {
        pageErrors.push(buildErrorEntry({
          state,
          job,
          stage: "latest-price-validation",
          message: error.message || String(error),
          player: card
        }));
        return false;
      }
    });
    currentLatest = {
      sourceDate: currentLatest?.sourceDate || pageLatest.sourceDate || null,
      cards: dedupeLatestCoinCards([...existingCards, ...incomingCards])
    };
    skipped += pageErrors.length;
    const parsedCount = incomingCards.length + pageErrors.length;
    const pagesRead = state.pagesSucceeded + 1;
    await appendLatestStepLog(state, {
      eventType: "step1-page-parsed",
      message: `STEP 1/2\nParsing Latest Page ${state.currentPage}...`,
      page: state.currentPage,
      url: state.currentUrl,
      pagesRead,
      totalPages,
      parsed: parsedCount,
      valid: incomingCards.length,
      invalid: pageErrors.length,
      totalValid: currentLatest.cards.length,
      consolePlayers: incomingCards.map(toApiLatestCoinCard)
    });
  } else if (isCoinCardJob) {
    try {
      const card = normalizeCoinCardDetail(message.coinCard, job);
      players[String(job.id)] = card;
      mappedPlayers.push(toCoinCardDisplayPlayer(card, job));
    } catch (error) {
      skipped++;
      pageErrors.push(buildErrorEntry({ state, job, stage: "parse", message: error.message || String(error) }));
    }
  } else {
    for (const rawPlayer of message.players || []) {
      try {
        const player = mapPlayer(rawPlayer, state.lookups);
        if (!player) {
          skipped++;
          continue;
        }
        players[String(player.futbinPlayerId)] = player;
        mappedPlayers.push(player);
      } catch (error) {
        skipped++;
        pageErrors.push(buildErrorEntry({
          state,
          job,
          stage: "map",
          message: error.message || String(error),
          player: rawPlayer
        }));
      }
    }
  }
  if (pageErrors.length) await appendErrors(pageErrors);
  const initialSaveStatus = isCoinCardJob && (state.newlyInsertedCoinCardIds || [])
    .some((id) => Number(id) === Number(job.id))
    ? "inserted"
    : null;
  await appendRecords(mappedPlayers, state.currentUrl, job, initialSaveStatus, state);

  const updated = {
    ...state,
    totalPages,
    currentLatest,
    currentPlayers: players,
    currentSkipped: (state.currentSkipped || 0) + skipped,
    pagesAttempted: state.pagesAttempted + 1,
    pagesSucceeded: state.pagesSucceeded + 1,
    status: jobStatus(job, state.currentJobIndex, state.queue.length, `${state.currentPage}/${totalPages} sayfa okundu`),
    updatedAt: Date.now()
  };
  await setState(updated);
  return finishOrScheduleNextPage(updated);
}

async function handleCriticalPageError(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!isCurrentPageSender(state, message, sender) || !await isActiveRun(state)) return { ok: false };
  await failSync(message.error || "[CRITICAL] Futbin sayfası doğrulanamadı.", state);
  return { ok: false, critical: true };
}

async function handleReportedPageFailure(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!isCurrentPageSender(state, message, sender) || !await isActiveRun(state)) return { ok: false, error: "Eski veya durdurulmuş sayfa hatası yok sayıldı." };
  return recordPageFailure(state, message.error || `Sayfa yüklenemedi: ${message.pageUrl}`);
}

async function handlePageFailure(error, currentState = null) {
  const state = currentState || await getState();
  if (!await isActiveRun(state)) return;
  const action = await recordPageFailure(state, error);
  if (action?.nextUrl) await performAdvance(action.nextUrl, state.runnerId);
}

async function recordPageFailure(state, error) {
  if (!await isActiveRun(state)) return { ok: false, action: "STOPPED" };
  const failed = {
    ...state,
    pagesAttempted: state.pagesAttempted + 1,
    failedPages: [...(state.failedPages || []), { page: state.currentPage, url: state.currentUrl, error }],
    status: `${error}; sonraki adıma geçiliyor`,
    updatedAt: Date.now()
  };
  await setState(failed);
  return finishOrScheduleNextPage(failed);
}

async function finishOrScheduleNextPage(state) {
  if (!await isActiveRun(state)) return { ok: false, action: "STOPPED" };
  if (state.currentPage < state.totalPages) {
    const nextPage = state.currentPage + 1;
    const nextUrl = buildJobUrl(currentJob(state), nextPage);
    const waiting = {
      ...state,
      currentPage: nextPage,
      currentUrl: nextUrl,
      nextRunAt: Date.now() + futbinRequestDelayMs(state),
      status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, `${nextPage}. sayfa bekleniyor`),
      updatedAt: Date.now()
    };
    await setState(waiting);
    await scheduleJobAdvance(waiting);
    return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: futbinRequestDelayMs(state) };
  }

  return submitCurrentJobAndPrepareNext(state);
}

async function submitCurrentJobAndPrepareNext(state) {
  const job = currentJob(state);
  if (job.operation === "coin-card-latest") return submitLatestCoinCardsAndPrepareDetails(state);
  if (job.operation === "coin-cards") return submitCurrentCoinCardAndPrepareNext(state);
  const players = Object.values(state.currentPlayers || {});
  let saved = 0;
  let skipped = state.currentSkipped || 0;
  let inserted = 0;
  let updated = 0;
  const validationErrors = [];
  const validPlayers = [];

  for (const player of players) {
    const errors = validateMappedPlayer(player);
    if (errors.length) {
      skipped++;
      validationErrors.push(buildErrorEntry({
        state,
        job,
        stage: "before-post",
        message: `${player?.name || "Oyuncu"} post edilmedi: ${errors.join(", ")}`,
        player
      }));
      continue;
    }
    validPlayers.push(player);
  }

  if (validationErrors.length) await appendErrors(validationErrors);

  if (validPlayers.length > 0) {
    const saving = { ...state, nextRunAt: null, status: `${job.league_name} → ${job.club_name}: API'ye kaydediliyor`, updatedAt: Date.now() };
    await setState(saving);
    const response = await apiRequest(state.apiBaseUrl, `sync/futbin-player-clubs/${job.club_id}`, {
      method: "POST",
      body: JSON.stringify({
        league_id: job.league_id,
        pages_attempted: state.pagesAttempted,
        pages_succeeded: state.pagesSucceeded,
        players: validPlayers.map(toApiPlayer)
      })
    });
    saved = Number(response?.data?.saved) || 0;
    skipped += Number(response?.data?.skipped) || 0;
    inserted = Number(response?.data?.inserted) || 0;
    updated = Number(response?.data?.updated) || 0;
    const responseErrors = Array.isArray(response?.data?.errors) ? response.data.errors : [];
    if (responseErrors.length) {
      await appendErrors(responseErrors.map((message) => buildErrorEntry({
        state,
        job,
        stage: "after-post",
        message
      })));
    }
  }

  const clubSaveResults = {
    ...(state.clubSaveResults || {}),
    [String(job.club_id)]: {
      saved,
      skipped,
      inserted,
      updated,
      posted: validPlayers.length,
      savedAt: Date.now()
    }
  };

  const nextJobIndex = state.currentJobIndex + 1;
  if (nextJobIndex >= state.queue.length) {
    return scheduleNextLoop(state, saved, skipped, clubSaveResults, null);
  }

  const nextJob = state.queue[nextJobIndex];
  const nextUrl = buildJobUrl(nextJob, 1);
  const prepared = {
    ...state,
    currentJobIndex: nextJobIndex,
    currentPage: 1,
    totalPages: 1,
    currentUrl: nextUrl,
    currentPlayers: {},
    currentSkipped: 0,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    failedPages: [],
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + saved,
    skippedPlayers: state.skippedPlayers + skipped,
    clubSaveResults,
    nextRunAt: Date.now() + futbinRequestDelayMs(state),
    status: jobStatus(nextJob, nextJobIndex, state.queue.length, "Kulüp sırası bekleniyor"),
    updatedAt: Date.now()
  };
  await setState(prepared);
  await scheduleJobAdvance(prepared);
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: futbinRequestDelayMs(state) };
}

async function submitLatestCoinCardsAndPrepareDetails(state) {
  const job = currentJob(state);
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = state.currentSkipped || 0;
  let clubSaveResults = state.clubSaveResults || {};
  const jobsBeforeInsert = Array.isArray(state.latestCoinCardJobsSnapshot)
    ? state.latestCoinCardJobsSnapshot
    : [];
  let validPlayers = [];
  let existingLatestPlayers = [];

  if (state.currentLatest) {
    const postStartedAt = Date.now();
    const invalidLatestPlayers = state.currentSkipped || 0;
    const allLatestPlayers = (state.currentLatest.cards || []).map(toApiLatestCoinCard);
    const splitLatest = splitLatestPlayersByExistingCoinCards(allLatestPlayers, jobsBeforeInsert);
    validPlayers = splitLatest.missing;
    existingLatestPlayers = splitLatest.existing;
    printLatestPlayerArray("STEP 1 - ALL VALID PLAYERS", allLatestPlayers);
    await appendLatestStepLog(state, {
      eventType: "step1-valid-summary",
      message: `STEP 1/2\nValid Players: ${allLatestPlayers.length}`,
      pagesRead: LATEST_COIN_CARD_PAGES,
      playersParsed: allLatestPlayers.length + invalidLatestPlayers,
      validPlayers: allLatestPlayers.length,
      invalidPlayers: invalidLatestPlayers,
      existingPlayers: existingLatestPlayers.length,
      newPlayers: validPlayers.length
    });
    console.log("Valid Latest Players", allLatestPlayers);
    console.log("New Latest Players To Insert", validPlayers);
    console.log("Existing Latest Players Skipped For Insert", existingLatestPlayers);
    await setState({
      ...state,
      nextRunAt: null,
      status: "STEP 1/2 · Yeni oyuncular backend'e gönderiliyor",
      updatedAt: Date.now()
    });
    let response = { data: { inserted: 0, updated: 0, deleted: 0, skipped: 0, errors: [] } };
    if (validPlayers.length) {
      response = await apiRequest(state.apiBaseUrl, "futbin-sync/coin-card-latest", {
        method: "POST",
        body: JSON.stringify({
          source_date: state.currentLatest.sourceDate,
          cards: validPlayers
        })
      });
    }
    if (!await isActiveRun(state)) return { ok: false, action: "STOPPED" };
    inserted = Number(response?.data?.inserted) || 0;
    updated = Number(response?.data?.updated) || 0;
    deleted = Number(response?.data?.deleted) || 0;
    const postSkipped = Number(response?.data?.skipped) || 0;
    skipped += postSkipped;
    clubSaveResults = latestCoinCardClubSaveResults(state, {
      inserted,
      updated,
      deleted,
      skipped,
      posted: validPlayers.length
    });
    await setState({
      ...state,
      clubSaveResults,
      status: `STEP 1/2 · Kaydedildi · Yeni kayıt ${inserted} · Güncellenen ${updated}`,
      updatedAt: Date.now()
    });
    await appendLatestEventLog(state, {
      eventType: "latest-posted",
      message: "Latest coin card listesi API'ye gönderildi",
      startedAt: postStartedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - postStartedAt,
      posted: validPlayers.length,
      inserted,
      updated,
      deleted,
      skipped,
      existingSkipped: existingLatestPlayers.length
    });
    const responseErrors = Array.isArray(response?.data?.errors) ? response.data.errors : [];
    if (responseErrors.length) {
      await appendErrors(responseErrors.map((message) => buildErrorEntry({
        state,
        job,
        stage: "latest-after-post",
        message
      })));
    }
  }

  await appendLatestStepLog(state, {
    eventType: "step1-new-summary",
    message: `STEP 1/2\nNew Players Saved: ${inserted}`,
    pagesRead: LATEST_COIN_CARD_PAGES,
    validPlayers: state.currentLatest?.cards?.length || 0,
    invalidPlayers: state.currentSkipped || 0,
    newPlayers: inserted,
    existingPlayers: existingLatestPlayers.length,
    updatedPlayers: updated,
    deletedPlayers: deleted,
    skippedPlayers: skipped
  });
  if (inserted > 0 || updated > 0 || deleted > 0 || skipped > 0) {
    await appendLatestEventLog(state, {
      eventType: "latest-save-summary",
      message: "Latest oyuncular kaydedildi",
      inserted,
      updated,
      deleted,
      skipped,
      posted: validPlayers.length,
      existingSkipped: existingLatestPlayers.length
    });
  }

  const latestCardsByUrl = new Map((state.currentLatest?.cards || [])
    .map((card) => [coinCardUrlKey(card?.url), card])
    .filter(([url]) => Boolean(url)));
  const allCoinCardJobs = await fetchCoinCardUpdateJobs(state.apiBaseUrl);
  if (!await isActiveRun(state)) return { ok: false, action: "STOPPED" };
  const previousJobIds = new Set(jobsBeforeInsert.map((detailJob) => Number(detailJob.id)));
  const submittedLatestUrls = new Set(validPlayers.map((card) => coinCardUrlKey(card?.url)).filter(Boolean));
  const newlyInsertedJobs = allCoinCardJobs.filter((detailJob) =>
    Number.isInteger(Number(detailJob.id)) &&
    !previousJobIds.has(Number(detailJob.id)) &&
    submittedLatestUrls.has(coinCardUrlKey(detailJob.url)));
  const newlyInsertedCoinCardIds = newlyInsertedJobs.map((detailJob) => Number(detailJob.id));
  const enrichedUpdateJobs = allCoinCardJobs.map((detailJob) =>
    enrichCoinCardJobWithLatestCard(detailJob, latestCardsByUrl.get(coinCardUrlKey(detailJob.url))));
  await appendLatestStepLog(state, {
    eventType: "step2-queue-prepared",
    message: "STEP 2/2\nPreparing update queue...",
    queueSize: enrichedUpdateJobs.length,
    currentPlayer: "",
    updatedCount: 0,
    newAddedCount: inserted,
    failedCount: 0,
    remainingCount: enrichedUpdateJobs.length
  });

  const queue = [
    ...state.queue.slice(0, state.currentJobIndex + 1),
    ...enrichedUpdateJobs,
    ...state.queue.slice(state.currentJobIndex + 1)
  ];
  const nextJobIndex = state.currentJobIndex + 1;
  if (nextJobIndex >= queue.length) {
    return scheduleNextLoop({
      ...state,
      queue,
      currentLatest: null,
      latestCoinCardJobsSnapshot: allCoinCardJobs,
      latestCoinCardJobsSnapshotLoaded: true,
      newlyInsertedCoinCardIds,
      latestUpdatedCoinCardIds: [],
      clubSaveResults,
      updatedAt: Date.now()
    }, inserted + updated, skipped, clubSaveResults, queue);
  }

  const nextJob = queue[nextJobIndex];
  const nextUrl = buildJobUrl(nextJob, 1);
  const prepared = {
    ...state,
    queue,
    currentJobIndex: nextJobIndex,
    currentPage: 1,
    totalPages: 1,
    currentUrl: nextUrl,
    currentPlayers: {},
    currentLatest: null,
    latestCoinCardJobsSnapshot: allCoinCardJobs,
    latestCoinCardJobsSnapshotLoaded: true,
    newlyInsertedCoinCardIds,
    latestUpdatedCoinCardIds: [],
    currentSkipped: 0,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    failedPages: [],
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + inserted + updated,
    skippedPlayers: state.skippedPlayers + skipped,
    clubSaveResults,
    nextRunAt: Date.now() + futbinRequestDelayMs(state),
    status: jobStatus(nextJob, nextJobIndex, queue.length, "İş sırası bekleniyor"),
    updatedAt: Date.now()
  };
  await setState(prepared);
  await scheduleJobAdvance(prepared);
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: futbinRequestDelayMs(state) };
}

function latestCoinCardClubSaveResults(state, { inserted, updated, deleted, skipped, posted = null }) {
  return {
    ...(state.clubSaveResults || {}),
    "coin-card:latest": {
      saved: inserted,
      skipped,
      inserted,
      updated,
      deleted,
      posted: posted ?? state.currentLatest?.cards?.length ?? 0,
      savedAt: Date.now()
    }
  };
}

function readDeletedCount(response) {
  const data = response?.data;
  if (Number.isFinite(Number(data))) return Number(data);
  return Number(data?.deleted ?? data?.deletedCount ?? data?.count) || 0;
}

async function fetchCoinCardUpdateJobs(apiBaseUrl) {
  const response = await apiRequest(apiBaseUrl, COIN_CARD_LIST_ENDPOINT);
  const coinCards = normalizeCoinCardList(response?.data);
  return coinCards
    .map(coinCardDtoToUpdateJob)
    .filter((job) => Number.isInteger(Number(job.id)) && Number(job.id) > 0 && Boolean(coinCardUrlKey(job.url)));
}

function normalizeCoinCardList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.coinCards)) return data.coinCards;
  if (Array.isArray(data?.coin_cards)) return data.coin_cards;
  if (Array.isArray(data?.records)) return data.records;
  return [];
}

function coinCardDtoToUpdateJob(card = {}) {
  const playerName = card.player_name || card.playerName || card.label || card.name || "";
  return {
    id: card.id,
    label: playerName || `Coin Card ${card.id || ""}`.trim(),
    url: card.url || "",
    operation: "coin-cards",
    playerName,
    rating: card.rating ?? null,
    position: card.position || null,
    playerImgUrl: card.player_img_url || card.playerImgUrl || null,
    bgCardUrl: card.bg_card_url || card.bgCardUrl || null,
    nationImgUrl: card.nation_img_url || card.nationImgUrl || null,
    priceCross: card.price_cross ?? card.priceCross ?? card.price_console ?? card.priceConsole ?? null,
    transferRatioCross: card.transfer_ratio_cross ?? card.transferRatioCross ?? null,
    transferRatioPc: card.transfer_ratio_pc ?? card.transferRatioPc ?? null
  };
}

function splitLatestPlayersByExistingCoinCards(latestPlayers = [], existingJobs = []) {
  const existingKeys = new Set(existingJobs.map(coinCardIdentityKey).filter(Boolean));
  const missing = [];
  const existing = [];
  for (const player of latestPlayers || []) {
    const key = coinCardIdentityKey(player);
    if (key && existingKeys.has(key)) {
      existing.push(player);
    } else {
      missing.push(player);
    }
  }
  return { missing, existing };
}

function coinCardIdentityKey(card = {}) {
  const urlKey = coinCardUrlKey(card.url);
  if (urlKey) return `url:${urlKey}`;
  const name = normalizeText(card.player_name || card.playerName || card.label || card.name).toLowerCase();
  const rating = Number(card.rating) || "";
  const position = normalizeText(card.position).toLowerCase();
  return name ? `fallback:${name}|${rating}|${position}` : "";
}

async function submitCurrentCoinCardAndPrepareNext(state) {
  const job = currentJob(state);
  const card = state.currentPlayers?.[String(job.id)];
  const isNewlyInserted = (state.newlyInsertedCoinCardIds || []).some((id) => Number(id) === Number(job.id));
  const progress = coinCardDetailProgress(state, job);
  let saved = 0;
  let skipped = state.currentSkipped || 0;
  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  if (card) {
    await appendLatestStepLog(state, {
      eventType: "step2-player-updating",
      message: `STEP 2/2\nUpdating ${progress.current} / ${progress.total}\n${card.playerName || job.label || ""}`,
      current: progress.current,
      total: progress.total,
      queueSize: progress.total,
      currentPlayer: card.playerName || job.label || "",
      ...coinCardDetailStats(state, { current: progress.current, total: progress.total })
    });
    await setState({
      ...state,
      nextRunAt: null,
      status: `STEP 2/2 · Updating ${progress.current} / ${progress.total} · ${job.label || "Coin Cards"}`,
      updatedAt: Date.now()
    });
    const response = await apiRequest(state.apiBaseUrl, `futbin-sync/coin-card-jobs/${job.id}`, {
      method: "POST",
      body: JSON.stringify(toApiCoinCard(card))
    });
    if (!await isActiveRun(state)) return { ok: false, action: "STOPPED" };
    saved = Number(response?.data?.saved) || 0;
    const responseSkipped = Number(response?.data?.skipped) || 0;
    skipped += responseSkipped;
    inserted = Number(response?.data?.inserted) || 0;
    updated = Number(response?.data?.updated) || 0;
    deleted = Number(response?.data?.deleted) || 0;
    const responseErrors = Array.isArray(response?.data?.errors) ? response.data.errors : [];
    if (responseErrors.length) {
      await appendErrors(responseErrors.map((message) => buildErrorEntry({
        state,
        job,
        stage: "after-post",
        message
      })));
    }
    const saveStatus = isNewlyInserted || inserted > 0 ? "inserted" : updated > 0 ? "updated" : "unchanged";
    await updateRecordSaveStatus(job, saveStatus, state);
    const completionAction = isNewlyInserted || inserted > 0 ? "inserted" : "updated";
    await completeLatestPlayerLog(state, card, job, completionAction, { inserted, updated });
    await appendLatestStepLog(state, {
      eventType: "step2-api-response",
      message: `STEP 2/2\nAPI Response:\n${step2ResponseLabel(saveStatus)}`,
      responseStatus: step2ResponseLabel(saveStatus),
      current: progress.current,
      total: progress.total,
      queueSize: progress.total,
      currentPlayer: card.playerName || job.label || "",
      ...coinCardDetailStats(state, {
        current: progress.current,
        total: progress.total,
        insertedDelta: saveStatus === "inserted" ? 1 : 0,
        updatedDelta: saveStatus === "updated" || saveStatus === "unchanged" ? 1 : 0,
        failedDelta: responseSkipped || responseErrors.length
      })
    });
  } else {
    await appendLatestStepLog(state, {
      eventType: "step2-api-response",
      message: "STEP 2/2\nAPI Response:\nFailed",
      responseStatus: "Failed",
      current: progress.current,
      total: progress.total,
      queueSize: progress.total,
      currentPlayer: job.label || "",
      ...coinCardDetailStats(state, {
        current: progress.current,
        total: progress.total,
        failedDelta: 1
      })
    });
  }

  const resultKey = `coin-card:${job.id}`;
  const reportedUpdated = isNewlyInserted ? 0 : updated;
  const clubSaveResults = {
    ...(state.clubSaveResults || {}),
    [resultKey]: { saved, skipped, inserted, updated: reportedUpdated, deleted, posted: card ? 1 : 0, savedAt: Date.now() }
  };
  const nextJobIndex = state.currentJobIndex + 1;
  if (nextJobIndex >= state.queue.length) {
    return scheduleNextLoop(state, saved, skipped, clubSaveResults, null);
  }

  const nextJob = state.queue[nextJobIndex];
  const nextUrl = buildJobUrl(nextJob, 1);
  const prepared = {
    ...state,
    currentJobIndex: nextJobIndex,
    currentPage: 1,
    totalPages: 1,
    currentUrl: nextUrl,
    currentPlayers: {},
    currentSkipped: 0,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    failedPages: [],
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + saved,
    skippedPlayers: state.skippedPlayers + skipped,
    clubSaveResults,
    nextRunAt: Date.now() + futbinRequestDelayMs(state),
    status: jobStatus(nextJob, nextJobIndex, state.queue.length, "İş sırası bekleniyor"),
    updatedAt: Date.now()
  };
  await setState(prepared);
  await scheduleJobAdvance(prepared);
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: futbinRequestDelayMs(state) };
}

async function advanceFromContentTimer(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  syncLog("Content script geçiş isteği aldı", { ...stateLogDetails(state), requestedUrl: message.url });
  if (!await isActiveRun(state) || !state.nextRunAt || sender.tab?.id !== state.tabId || message.url !== state.currentUrl) return { ok: false };
  await performAdvance(message.url, state.runnerId);
  return { ok: true };
}

async function performAdvance(url, runnerId = null) {
  const state = await getState(runnerId);
  if (!await isActiveRun(state) || !state.nextRunAt || url !== state.currentUrl) {
    syncLog("Geçiş isteği eski olduğu için yok sayıldı", { ...stateLogDetails(state), requestedUrl: url });
    return;
  }
  await chrome.alarms.clear(jobAdvanceAlarmName(state));
  syncLog("Sonraki işe geçiliyor", stateLogDetails(state));
  if (state.tabId) await closeRunnerTab(state.tabId, state);
  const tab = await createRunnerTab(state.operations || RUNNER_OPERATIONS[state.runnerId]);
  if (!await isActiveRun(state)) {
    await closeRunnerTab(tab.id);
    return;
  }
  const statusSuffix = "Futbin sekmesi açılıyor";
  const opening = { ...state, tabId: tab.id || null, nextRunAt: null, status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, statusSuffix), updatedAt: Date.now() };
  await setState(opening);
  await navigateToCurrentPage(opening);
}

async function navigateToCurrentPage(state) {
  if (!await isActiveRun(state)) return;
  syncLog("Sayfa navigasyonu başlatıldı", stateLogDetails(state));
  await appendLatestTabLog(state, "Futbin sekme navigasyonu başlatıldı", "tab-navigation-start", {
    tabId: state.tabId || null,
    url: state.currentUrl
  });
  await appendPageLog(state);
  if (!await isActiveRun(state)) return;
  const env = await getEnv();
  const timeoutMs = Number(env.PAGE_TIMEOUT_MS) || 120000;
  await chrome.alarms.create(pageTimeoutAlarmName(state), { when: Date.now() + timeoutMs });
  if (!await isActiveRun(state)) {
    await chrome.alarms.clear(pageTimeoutAlarmName(state));
    return;
  }
  try {
    if (!state.tabId) {
      throw new Error("Futbin sekmesi bulunamadı; arka plan fetch kullanılmayacak.");
    }
    const tab = await chrome.tabs.get(state.tabId);
    if (matchesCurrentPage(tab.url, state)) {
      await appendLatestTabLog(state, "Futbin sekmesi hedef URL'de; reload gönderiliyor", "tab-reload", {
        tabId: state.tabId,
        url: tab.url
      });
      await chrome.tabs.reload(state.tabId);
    } else {
      await chrome.tabs.update(state.tabId, {
        url: state.currentUrl,
        active: false
      });
      await appendLatestTabLog(state, "Futbin sekmesine hedef URL gönderildi", "tab-url-sent", {
        tabId: state.tabId,
        url: state.currentUrl
      });
    }
  } catch (error) {
    syncError("Çalışma sekmesine erişilemedi", error, stateLogDetails(state));
    await chrome.alarms.clear(pageTimeoutAlarmName(state));
    await failSync("Çalışma sekmesine erişilemedi", state);
  }
}

async function appendPageLog(state) {
  if (!state.currentUrl) return;
  const job = currentJob(state);
  if (job.operation === "coin-cards") {
    return;
  }
  if (job.operation !== "coin-card-latest") return;
  await appendLatestStepLog(state, {
    eventType: "step1-page-loading",
    message: `STEP 1/2\nLoading Latest Page ${state.currentPage}...`,
    url: state.currentUrl,
    page: state.currentPage
  });
}

function coinCardLogCardFromJob(job = {}) {
  return {
    playerName: job.label || job.playerName || job.player_name || job.name || null,
    rating: positiveNumberOrNull(job.rating || job.playerRating || job.player_rating),
    position: job.position || job.positionName || job.position_name || null,
    priceCross: positiveNumberOrNull(job.priceCross || job.price_cross || job.consolePrice || job.console_price)
  };
}

function enrichCoinCardJobWithLatestCard(job, card) {
  if (!card) return job;
  return {
    ...job,
    label: job.label || card.playerName,
    playerName: card.playerName || job.playerName || job.player_name || job.label || null,
    rating: card.rating ?? job.rating ?? job.playerRating ?? job.player_rating ?? null,
    position: card.position ?? job.position ?? null,
    priceCross: card.priceCross ?? job.priceCross ?? job.price_cross ?? null
  };
}

async function appendLatestPlayerLog(state, card, job, action, extras = {}) {
  if (!await isActiveRun(state)) return;
  const eventTypes = latestPlayerEventTypes();
  await appendLatestEventLog(state, {
    eventType: eventTypes[action] || "card-processing",
    message: action === "inserted"
      ? "New Added"
      : action === "updated"
        ? "Updated"
        : action === "completed"
          ? "Coin card işlemi tamamlandı"
          : "Processing",
    playerName: card?.playerName || job?.label || null,
    coinCardId: job?.id ?? null,
    rating: card?.rating || null,
    position: card?.position || null,
    priceCross: card?.priceCross ?? null,
    url: card?.url || job?.url || null,
    ...extras
  });
}

async function completeLatestPlayerLog(state, card, job, action, extras = {}) {
  if (!await isActiveRun(state)) return;
  const eventTypes = latestPlayerEventTypes();
  const completedAt = Date.now();
  const completion = {
    eventType: eventTypes[action] || "card-completed",
    requestedAt: completedAt,
    completedAt,
    playerName: card?.playerName || job?.label || null,
    coinCardId: job?.id ?? null,
    rating: card?.rating || null,
    position: card?.position || null,
    priceCross: card?.priceCross ?? null,
    url: card?.url || job?.url || null,
    ...extras
  };
  let updatedLogs = [];

  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get(LOGS_KEY);
    const logs = Array.isArray(stored[LOGS_KEY]) ? [...stored[LOGS_KEY]] : [];
    let index = -1;
    for (let cursor = logs.length - 1; cursor >= 0; cursor--) {
      if (logs[cursor]?.eventType !== "card-processing") continue;
      if (sameLatestPlayerLog(logs[cursor], completion)) {
        index = cursor;
        break;
      }
    }

    const completedEntry = compactLatestLogEntry(index >= 0 ? { ...logs[index], ...completion } : completion);
    completedEntry.message = latestLogMessage(completedEntry);
    if (index >= 0) {
      logs[index] = completedEntry;
    } else {
      logs.push(completedEntry);
    }
    updatedLogs = logs.slice(-MAX_LOGS);
    await chrome.storage.local.set({ [LOGS_KEY]: updatedLogs });
  });

  if (state?.runnerId) {
    const current = await getState(state.runnerId);
    if (current?.runnerId === state.runnerId && current?.runStartedAt === state.runStartedAt) {
      await setState({ ...current, logs: updatedLogs, updatedAt: Date.now() });
    }
  }
}

function latestPlayerEventTypes() {
  return {
    processing: "card-processing",
    inserted: "new-card-detected",
    updated: "card-updated",
    completed: "card-completed"
  };
}

function sameLatestPlayerLog(left = {}, right = {}) {
  const leftUrl = coinCardUrlKey(left.url);
  const rightUrl = coinCardUrlKey(right.url);
  if (leftUrl && rightUrl) return leftUrl === rightUrl;
  return sameLookupText(left.playerName, right.playerName) && Number(left.rating || 0) === Number(right.rating || 0);
}

async function resetLatestSyncLogs() {
  await enqueueStorageWrite(async () => {
    await chrome.storage.local.set({ [LOGS_KEY]: [] });
  });
}

async function appendLatestStepLog(state, details = {}) {
  const entryDetails = { logType: "latest-step", ...details };
  const { consolePlayers, ...storedDetails } = entryDetails;
  logLatestStepToConsole(entryDetails);
  await appendLatestEventLog(state, storedDetails);
}

function logLatestStepToConsole(entry = {}) {
  const message = latestLogMessage(entry);
  const stats = latestStepConsoleStats(entry);
  console.group(message);
  if (Object.keys(stats).length) {
    console.log(stats);
  } else {
    console.log(message);
  }
  if (Array.isArray(entry.consolePlayers)) {
    console.table(entry.consolePlayers);
    console.log(entry.consolePlayers);
  }
  console.groupEnd();
}

function latestStepConsoleStats(entry = {}) {
  return Object.fromEntries(Object.entries({
    pagesRead: entry.pagesRead,
    playersParsed: entry.playersParsed ?? entry.parsed,
    validPlayers: entry.validPlayers ?? entry.valid ?? entry.totalValid,
    invalidPlayers: entry.invalidPlayers ?? entry.invalid,
    newPlayersFound: entry.newPlayers,
    queueSize: entry.queueSize,
    currentPlayer: entry.currentPlayer,
    updatedCount: entry.updatedCount,
    newAddedCount: entry.newAddedCount,
    failedCount: entry.failedCount,
    remainingCount: entry.remainingCount,
    responseStatus: entry.responseStatus
  }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function printLatestPlayerArray(title, players) {
  console.group(title);
  console.table(players);
  console.log(players);
  console.groupEnd();
}

function printLatestFinishedSummary({ newAdded, updated, failed }) {
  console.group("LATEST PLAYER SYNC FINISHED");
  console.log(`New Added : ${Number(newAdded) || 0}`);
  console.log(`Updated  : ${Number(updated) || 0}`);
  console.log(`Failed   : ${Number(failed) || 0}`);
  console.groupEnd();
}

function coinCardDetailProgress(state, job) {
  const detailJobs = (state.queue || []).filter((entry) => entry?.operation === "coin-cards");
  const currentIndex = detailJobs.findIndex((entry) => Number(entry.id) === Number(job?.id));
  return {
    current: currentIndex >= 0 ? currentIndex + 1 : 0,
    total: detailJobs.length
  };
}

function coinCardDetailStats(state, extras = {}) {
  const previous = Object.entries(state.clubSaveResults || {})
    .filter(([key]) => /^coin-card:\d+$/.test(String(key)))
    .reduce((totals, [, result]) => ({
      updatedCount: totals.updatedCount + (Number(result?.updated) || 0),
      newAddedCount: totals.newAddedCount + (Number(result?.inserted) || 0),
      failedCount: totals.failedCount + (Number(result?.skipped) || 0)
    }), { updatedCount: 0, newAddedCount: 0, failedCount: 0 });
  const total = Number(extras.total) || 0;
  const current = Number(extras.current) || 0;
  return {
    updatedCount: previous.updatedCount + (Number(extras.updatedDelta) || 0),
    newAddedCount: previous.newAddedCount + (Number(extras.insertedDelta) || 0),
    failedCount: previous.failedCount + (Number(extras.failedDelta) || 0),
    remainingCount: Math.max(0, total - current)
  };
}

function step2ResponseLabel(saveStatus) {
  if (saveStatus === "inserted") return "New Added";
  if (saveStatus === "updated" || saveStatus === "unchanged") return "Updated";
  return "Failed";
}

async function appendLatestEventLog(state, details = {}) {
  const entry = compactLatestLogEntry({
    id: crypto.randomUUID(),
    requestedAt: Date.now(),
    runnerId: state?.runnerId || null,
    runCount: state?.runCount || 0,
    runStartedAt: state?.runStartedAt || null,
    page: details.page ?? state?.currentPage ?? null,
    url: details.url ?? state?.currentUrl ?? null,
    ...latestJobLogDetails(state),
    ...details
  });
  entry.message = latestLogMessage(entry);
  let updatedLogs = [];
  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get(LOGS_KEY);
    const logs = Array.isArray(stored[LOGS_KEY]) ? [...stored[LOGS_KEY]] : [];
    if (entry.eventType === "card-processing") {
      let existingIndex = -1;
      for (let cursor = logs.length - 1; cursor >= 0; cursor--) {
        if (logs[cursor]?.eventType === "card-processing" && sameLatestPlayerLog(logs[cursor], entry)) {
          existingIndex = cursor;
          break;
        }
      }
      if (existingIndex >= 0) entry.id = logs[existingIndex].id;

      const nextLogs = [];
      logs.forEach((existing, index) => {
        if (existing?.eventType !== "card-processing") {
          nextLogs.push(existing);
        } else if (index === existingIndex) {
          nextLogs.push(entry);
        } else if (!sameLatestPlayerLog(existing, entry)) {
          nextLogs.push(finalizeProcessingLog(existing, state));
        }
      });
      if (existingIndex < 0) nextLogs.push(entry);
      updatedLogs = nextLogs.slice(-MAX_LOGS);
    } else {
      updatedLogs = [...logs, entry].slice(-MAX_LOGS);
    }
    await chrome.storage.local.set({ [LOGS_KEY]: updatedLogs });
  });
  if (state?.runnerId) {
    const current = await getState(state.runnerId);
    if (current?.runnerId === state.runnerId && current?.runStartedAt === state.runStartedAt) {
      await setState({
        ...current,
        logs: updatedLogs,
        updatedAt: Date.now()
      });
    }
  }
}

async function appendLatestTabLog(state, message, eventType = "tab-event", details = {}) {
  if (!state?.runnerId) return;
  await appendLatestEventLog(state, {
    eventType,
    message,
    page: state.currentPage || null,
    url: details.url || state.currentUrl || null,
    ...details
  });
}

function finalizeExtraProcessingLogs(logs, state) {
  const entries = Array.isArray(logs) ? [...logs] : [];
  let latestProcessingIndex = -1;
  for (let cursor = entries.length - 1; cursor >= 0; cursor--) {
    if (entries[cursor]?.eventType === "card-processing") {
      latestProcessingIndex = cursor;
      break;
    }
  }
  const latestProcessing = entries[latestProcessingIndex];
  return entries.flatMap((entry, index) => {
    if (entry?.eventType !== "card-processing" || index === latestProcessingIndex) return [entry];
    if (latestProcessing && sameLatestPlayerLog(entry, latestProcessing)) return [];
    return [finalizeProcessingLog(entry, state)];
  });
}

function finalizeProcessingLog(entry, state) {
  const coinCardId = Number(entry?.coinCardId);
  const inserted = Number(entry?.inserted) > 0 || (Number.isFinite(coinCardId) &&
    (state?.newlyInsertedCoinCardIds || []).some((id) => Number(id) === coinCardId));
  const completed = compactLatestLogEntry({
    ...entry,
    eventType: inserted ? "new-card-detected" : "card-updated",
    completedAt: Date.now()
  });
  completed.message = latestLogMessage(completed);
  return completed;
}

function latestLogMessage(entry) {
  const type = String(entry?.eventType || "");
  if (type === "step1-start") {
    return "STEP 1/2 · Discover new Coin Card players";
  }
  if (type === "step1-page-loading") {
    return `STEP 1/2 · Loading Latest Page ${entry.page || "-"}...`;
  }
  if (type === "step1-page-parsed") {
    return `STEP 1/2 · Parsing Latest Page ${entry.page || "-"}... · parsed ${Number(entry.parsed) || 0} · valid ${Number(entry.valid) || 0} · invalid ${Number(entry.invalid) || 0}`;
  }
  if (type === "step1-valid-summary") {
    return `STEP 1/2 · Valid Players: ${Number(entry.validPlayers) || 0} · Invalid Players: ${Number(entry.invalidPlayers) || 0}`;
  }
  if (type === "step1-new-summary") {
    return `STEP 1/2 · New Players Found: ${Number(entry.newPlayers) || 0}`;
  }
  if (type === "step2-queue-prepared") {
    return `STEP 2/2 · Preparing update queue... · Queue Size ${Number(entry.queueSize) || 0}`;
  }
  if (type === "step2-player-updating") {
    return `STEP 2/2 · Updating ${Number(entry.current) || 0} / ${Number(entry.total) || 0} · ${normalizeText(entry.currentPlayer)}`;
  }
  if (type === "step2-api-response") {
    return `STEP 2/2 · API Response: ${normalizeText(entry.responseStatus) || "Unknown"} · Updated ${Number(entry.updatedCount) || 0} · New Added ${Number(entry.newAddedCount) || 0} · Failed ${Number(entry.failedCount) || 0} · Remaining ${Number(entry.remainingCount) || 0}`;
  }
  if (type === "step2-finished") {
    return `STEP 2/2 · Finished · New Added ${Number(entry.newAddedCount) || 0} · Updated ${Number(entry.updatedCount) || 0} · Failed ${Number(entry.failedCount) || 0}`;
  }
  if (type === "new-card-detected") {
    return `New Added · ${coinCardLogLabel(entry)}`;
  }
  if (type === "card-updated") {
    return `Updated · ${coinCardLogLabel(entry)}`;
  }
  if (type === "card-processing") {
    return `Processing · ${coinCardLogLabel(entry)}`;
  }
  if (type === "card-completed") {
    return `İşlem tamamlandı · ${coinCardLogLabel(entry)}`;
  }
  if (type === "futbin-page-read") {
    return `Futbin latest sayfa ${entry.page || "-"} okundu · ${Number(entry.parsed) || 0} kart · toplam ${Number(entry.total) || 0}`;
  }
  if (type === "page-requested") {
    return `Futbin latest sayfa ${entry.page || "-"} isteniyor`;
  }
  if (type === "latest-posted") {
    return `Latest liste API'ye gönderildi · Yeni kayıt ${Number(entry.inserted) || 0} · Güncellenen ${Number(entry.updated) || 0}`;
  }
  if (type === "db-snapshot-loaded") {
    return `Mevcut coin card snapshot yüklendi · ${Number(entry.total) || 0} kayıt`;
  }
  if (type === "cleanup-start") {
    return "Düşük ratiolu kart temizliği başladı";
  }
  if (type === "cleanup-end") {
    return entry.error
      ? `Düşük ratiolu kart temizliği hata verdi · ${entry.error}`
      : `Düşük ratiolu kart temizliği tamamlandı · deleted ${Number(entry.deleted) || 0}`;
  }
  if (type === "run-start") {
    return "Latest Coin Cards sync başladı";
  }
  if (type === "latest-save-summary") {
    return `Latest oyuncular kaydedildi · Yeni kayıt ${Number(entry.inserted) || 0} · Güncellenen ${Number(entry.updated) || 0}`;
  }
  if (type === "run-end") {
    return `Latest Coin Cards sync tamamlandı · Yeni kayıt ${Number(entry.inserted) || 0} · Güncellenen ${Number(entry.updated) || 0}`;
  }
  return normalizeText(entry?.message) || "Latest Sync log";
}

function coinCardLogLabel(entry) {
  const parts = [
    entry.rating ? `Rating ${entry.rating}` : null,
    normalizeText(entry.playerName),
    entry.priceCross !== undefined && entry.priceCross !== null && entry.priceCross !== "" ? `Price Cross ${formatNumberForLog(entry.priceCross)}` : null
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatNumberForLog(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("tr-TR") : String(value || "");
}

function latestJobLogDetails(state) {
  const job = currentJob(state || {});
  return {
    clubId: job?.club_id ?? null,
    clubName: logClubName(job),
    leagueName: logLeagueName(job)
  };
}

function compactLatestLogEntry(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) =>
    value !== null &&
    value !== undefined &&
    value !== ""
  ));
}

function normalizePageErrors(errors, job, state) {
  if (!Array.isArray(errors)) return [];
  return errors.map((entry) => buildErrorEntry({
    state,
    job,
    stage: entry?.stage || "parse",
    message: entry?.message || String(entry || "Oyuncu verisi okunamadı."),
    player: entry?.player || null
  }));
}

function buildErrorEntry({ state, job, stage, message, player }) {
  const playerLabel = player?.name || player?.futbinPlayerId || player?.futbin_player_id;
  return {
    id: crypto.randomUUID(),
    occurredAt: Date.now(),
    stage,
    message: playerLabel ? `${message} [player=${playerLabel}]` : message,
    url: state?.currentUrl || null,
    page: state?.currentPage || null,
    runnerId: state?.runnerId || null,
    runCount: state?.runCount || 0,
    runStartedAt: state?.runStartedAt || null,
    clubId: job?.club_id,
    clubName: logClubName(job),
    leagueName: logLeagueName(job)
  };
}

async function appendErrors(entries) {
  const normalized = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!normalized.length) return;
  await enqueueStorageWrite(async () => {
    await chrome.storage.local.set({ [ERRORS_KEY]: normalized.slice(0, MAX_ERRORS) });
  });
}

async function failSync(error, currentState = null) {
  const state = currentState || await getState();
  const liveState = await getState(state.runnerId);
  if (isFinishedState(liveState) || !sameRun(state, liveState)) return;
  syncError("Senkronizasyon hataya geçti", error, stateLogDetails(state));
  await chrome.alarms.clear(pageTimeoutAlarmName(state));
  await chrome.alarms.clear(jobAdvanceAlarmName(state));
  await chrome.alarms.clear(syncLoopAlarmName(state));
  const stored = await chrome.storage.local.get(AUTO_RUN_KEY);
  const oneShot = Boolean(state.runOnce || state.centralManaged);
  const autoRunEnabled = !oneShot && await isFcSyncEnabled() && stored[AUTO_RUN_KEY] !== false;
  const nextRunAt = autoRunEnabled ? Date.now() + SYNC_LOOP_DELAY_MS : null;
  const failed = {
    ...state,
    running: false,
    userStarted: autoRunEnabled,
    queue: [],
    currentJobIndex: -1,
    currentUrl: null,
    tabId: null,
    nextRunAt,
    status: autoRunEnabled ? `${error}; otomatik tekrar bekleniyor` : error,
    error,
    updatedAt: Date.now()
  };
  await setState(failed);
  await closeRunnerTab(state.tabId, state);
  if (autoRunEnabled) await scheduleLoopAlarm(failed);
  if (failed.centralManaged) await notifyCentralRoundFinished(failed, false);
}

async function apiRequest(apiBaseUrl, endpoint, options = {}) {
  await API_CONFIG.ready;
  void apiBaseUrl;
  const url = new URL(endpoint, API_CONFIG.defaultBaseUrl()).href;
  const method = options.method || "GET";
  const body = options.body;
  let response;
  let payload = {};
  let rawText = "";
  const controller = new AbortController();
  activeRequestControllers.add(controller);

  console.groupCollapsed(`[FutbinSync API] ${method} ${url}`);
  console.log("request", {
    method,
    url,
    headers: { "Content-Type": "application/json" },
    body: parseJsonForLog(body)
  });

  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal
    });
    rawText = await response.text();
    payload = parseJsonForLog(rawText) || {};
    console.log("response", {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: payload,
      rawText
    });
  } catch (error) {
    console.error("request failed", error);
    throw error;
  } finally {
    activeRequestControllers.delete(controller);
    console.groupEnd();
  }

  if (!response.ok || payload?.result === false) {
    const error = new Error(payload?.message || `API isteği başarısız (${response.status})`);
    error.critical = payload?.error_code === "CRITICAL";
    throw error;
  }
  return payload;
}

function parseJsonForLog(value) {
  if (!value || typeof value !== "string") return value || null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeApiBaseUrl(value) {
  return API_CONFIG.allowedBaseUrl(value || API_CONFIG.defaultBaseUrl());
}

function buildJobUrl(job, page) {
  if (job?.operation === "coin-card-latest") {
    const url = new URL(job.url || FUTBIN_LATEST_URL);
    url.searchParams.set("page", String(page));
    return url.href;
  }
  if (job?.operation === "coin-cards") return job.url;
  const url = new URL(job.url || "https://www.futbin.com/players");
  url.searchParams.set("page", String(page));
  url.searchParams.set("club", String(job.futbin_club_id));
  url.searchParams.set("league", String(job.futbin_league_id));
  url.searchParams.set("sort", "Player_Rating");
  url.searchParams.set("eUnt", "1");
  url.searchParams.set("order", "asc");
  return url.href;
}

function currentJob(state) {
  return state.queue?.[state.currentJobIndex] || {};
}

function isCoinCardOperation(job) {
  return job?.operation === "coin-cards" || job?.operation === "coin-card-latest";
}

function logClubName(job) {
  if (isCoinCardOperation(job)) return job?.label || "Coin Cards";
  return job?.club_name || "Kulüp";
}

function logLeagueName(job) {
  if (isCoinCardOperation(job)) return "Coin Cards";
  return job?.league_name || "Lig";
}

function isCurrentPageSender(state, message, sender) {
  return Boolean(
    state.running &&
    sender.tab?.id === state.tabId &&
    Number(message.page) === state.currentPage &&
    matchesCurrentPage(message.pageUrl, state)
  );
}

async function waitForFutbinTargetHtml(tabId, url, state) {
  if (!isFutbinUrl(url)) return;
  const startedAt = Date.now();
  let deadline = startedAt + FUTBIN_TARGET_DOM_MAX_WAIT_MS;
  let challengeLogged = false;
  let challengeDetectedAt = null;
  let lastHtml = "";
  let lastError = null;
  while (Date.now() < deadline) {
    const latestState = await getStateByTabId(tabId);
    if (!latestState.running || latestState.tabId !== tabId) throw new Error("Futbin sekme beklemesi durduruldu.");
    try {
      lastHtml = await readTabOuterHtml(tabId);
      lastError = null;
    } catch (error) {
      lastError = error;
      await delay(250);
      continue;
    }
    const status = futbinHtmlReadiness(lastHtml, currentJob(state));
    if (status.ready) {
      if (challengeLogged) await setLatestFutbinVerificationState(state, { resolved: true });
      await appendLatestTabLog(state, "Futbin hedef DOM bulundu; sayfa okunacak", "tab-target-dom-found", {
        tabId,
        url,
        contentLength: String(lastHtml || "").length,
        elapsedMs: Date.now() - startedAt
      });
      return;
    }
    if (status.cloudflare && !challengeLogged) {
      challengeLogged = true;
      challengeDetectedAt = Date.now();
      deadline = challengeDetectedAt + FUTBIN_CHALLENGE_MAX_WAIT_MS;
      await focusLatestFutbinChallengeTab(tabId);
      await setLatestFutbinVerificationState(state, { waiting: true, tabId, url, detectedAt: challengeDetectedAt });
      syncLog("Futbin Cloudflare doğrulaması algılandı; hedef HTML bekleniyor", {
        ...stateLogDetails(state),
        url,
        tabId,
        maxWaitMs: FUTBIN_CHALLENGE_MAX_WAIT_MS
      });
      await appendLatestTabLog(state, `Futbin Cloudflare doğrulaması algılandı; açık sekmede doğrulama bekleniyor · ${url}`, "tab-cloudflare-wait", {
        tabId,
        url,
        maxWaitMs: FUTBIN_CHALLENGE_MAX_WAIT_MS
      });
    }
    await delay(250);
  }
  const status = futbinHtmlReadiness(lastHtml, currentJob(state));
  if (challengeLogged) await setLatestFutbinVerificationState(state, { waiting: false });
  if (lastError && !lastHtml) throw lastError;
  throw new Error(status.cloudflare
    ? futbinChallengeTimeoutError(url)
    : `Futbin hedef HTML 60 saniye içinde okunamadı: ${url}`);
}

async function focusLatestFutbinChallengeTab(tabId) {
  try {
    await activateRunnerTab(tabId);
  } catch (error) {
    syncLog("Futbin doğrulama sekmesi öne getirilemedi", { tabId, error: error.message || String(error) });
  }
}

async function setLatestFutbinVerificationState(state, { waiting = false, tabId = null, url = null, detectedAt = null, resolved = false } = {}) {
  const liveState = await getState(state?.runnerId);
  if (!liveState.running || liveState.tabId !== state?.tabId || !sameRun(state, liveState)) return;
  const updated = {
    ...liveState,
    awaitingFutbinVerification: waiting,
    futbinChallengeDetectedAt: waiting ? detectedAt : null,
    futbinChallengeTabId: waiting ? tabId : null,
    futbinChallengeUrl: waiting ? url : null,
    updatedAt: Date.now()
  };
  if (waiting) updated.status = jobStatus(currentJob(liveState), liveState.currentJobIndex, liveState.queue.length, "Futbin doğrulaması bekleniyor — açık sekmede devam edin");
  if (resolved) updated.status = jobStatus(currentJob(liveState), liveState.currentJobIndex, liveState.queue.length, "Futbin doğrulaması tamamlandı; işleme devam ediliyor");
  await setState(updated);
}

async function readTabOuterHtml(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML
  });
  return results?.[0]?.result || "";
}

function futbinHtmlReadiness(html, job = {}) {
  const text = String(html || "");
  const cloudflare = isFutbinChallengeHtml(text);
  const targetDomReady = latestTargetDomReady(text, job);
  return {
    cloudflare,
    targetDomReady,
    ready: targetDomReady
  };
}

function latestTargetDomReady(html, job = {}) {
  const operation = job?.operation || "";
  if (operation === "coin-card-latest") {
    return /table[^>]+class=["'][^"']*players-table|tr[^>]+class=["'][^"']*player-row|class=["'][^"']*table-player-name|class=["'][^"']*table-added-on/i.test(html);
  }
  if (operation === "coin-cards") {
    return /class=["'][^"']*playercard-26-name|class=["'][^"']*playercard-26-position|class=["'][^"']*lowest-price-1|property=["']og:image["']|img[^>]+src=["'][^"']*\/players\//i.test(html);
  }
  return /table[^>]+class=["'][^"']*players-table|tr[^>]+class=["'][^"']*player-row|class=["'][^"']*selected-filters-wrapper|class=["'][^"']*table-player-name/i.test(html);
}

function isFutbinUrl(value) {
  try {
    const url = new URL(value || "");
    return url.hostname === "futbin.com" || url.hostname.endsWith(".futbin.com");
  } catch {
    return false;
  }
}

function jobStatus(job, index, total, suffix) {
  if (isCoinCardOperation(job))
    return `${job.label || "Coin Cards"} (${index + 1}/${total}) · ${suffix}`;
  return `${job?.league_name || "Lig"} → ${job?.club_name || "Kulüp"} (${index + 1}/${total}) · ${suffix}`;
}

function sameUrl(left, right) {
  try {
    const a = new URL(left); const b = new URL(right);
    a.hash = ""; b.hash = "";
    return a.href === b.href;
  } catch { return left === right; }
}

function matchesCurrentPage(value, state) {
  try {
    const url = new URL(value);
    const job = currentJob(state);
    if (job?.operation === "coin-card-latest") {
      const page = url.searchParams.get("page") || "1";
      return /(^|\.)futbin\.com$/i.test(url.hostname) &&
        url.pathname.replace(/\/+$/, "") === "/latest" &&
        page === String(state.currentPage);
    }
    if (job?.operation === "coin-cards") return sameUrl(url.href, state.currentUrl);
    return /(^|\.)futbin\.com$/i.test(url.hostname) &&
      url.searchParams.get("page") === String(state.currentPage) &&
      url.searchParams.get("club") === String(job.futbin_club_id) &&
      url.searchParams.get("league") === String(job.futbin_league_id);
  } catch { return sameUrl(value, state.currentUrl); }
}

function normalizeCoinCardDetail(value, job) {
  if (!value || typeof value !== "object") throw new Error("Coin Card detay verisi okunamadı.");
  const card = {
    playerName: normalizeText(value.playerName) || job.label || `Coin Card #${job.id}`,
    rating: positiveNumberOrNull(value.rating),
    position: normalizeText(value.position),
    playerImgUrl: normalizeText(value.playerImgUrl) || null,
    bgCardUrl: normalizeText(value.bgCardUrl) || null,
    nationImgUrl: normalizeText(value.nationImgUrl) || null,
    minPriceCross: positiveNumberOrNull(value.minPriceCross),
    priceCross: positiveNumberOrNull(value.priceCross),
    maxPriceCross: positiveNumberOrNull(value.maxPriceCross),
    minPricePc: positiveNumberOrNull(value.minPricePc),
    pricePc: positiveNumberOrNull(value.pricePc),
    maxPricePc: positiveNumberOrNull(value.maxPricePc)
  };
  assertCompleteCoinCardPrices(card);
  return card;
}

function assertCompleteCoinCardPrices(card) {
  const requiredPrices = [
    ["Cross Price", card?.priceCross],
    ["Cross Range Min", card?.minPriceCross],
    ["Cross Range Max", card?.maxPriceCross],
    ["PC Price", card?.pricePc],
    ["PC Range Min", card?.minPricePc],
    ["PC Range Max", card?.maxPricePc]
  ];
  const missing = requiredPrices
    .filter(([, value]) => !Number.isFinite(Number(value)) || Number(value) <= 0)
    .map(([label]) => label);
  if (missing.length) throw new Error(`Eksik fiyat bilgisi nedeniyle atlandı: ${missing.join(", ")}`);
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

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toCoinCardDisplayPlayer(card, job) {
  return {
    futbinPlayerId: Number(job.id),
    futbinPlayerLink: job.url,
    name: card.playerName,
    positionName: card.position,
    rating: card.rating,
    qualityCode: "coin",
    rarityName: "Coin Card",
    priceConsole: card.priceCross || null,
    minPriceConsole: card.minPriceCross || null,
    maxPriceConsole: card.maxPriceCross || null,
    pricePc: card.pricePc || null,
    minPricePc: card.minPricePc || null,
    maxPricePc: card.maxPricePc || null,
    urlImgCard: card.bgCardUrl,
    urlImgPlayer: card.playerImgUrl,
    urlImgNation: card.nationImgUrl,
    leagueName: "Coin Cards",
    clubName: card.playerName,
    active: true
  };
}

function toApiLatestCoinCard(card) {
  return {
    player_name: card.playerName,
    rating: card.rating,
    position: card.position,
    url: card.url,
    player_img_url: card.playerImgUrl,
    bg_card_url: card.bgCardUrl,
    nation_img_url: card.nationImgUrl,
    min_price_cross: card.minPriceCross,
    price_cross: card.priceCross,
    max_price_cross: card.maxPriceCross,
    min_price_pc: card.minPricePc,
    price_pc: card.pricePc,
    max_price_pc: card.maxPricePc
  };
}

function dedupeLatestCoinCards(cards) {
  const merged = new Map();
  for (const card of cards || []) {
    const key = coinCardUrlKey(card?.url);
    if (!key) continue;
    merged.set(key, card);
  }
  return [...merged.values()];
}

function coinCardUrlKey(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href.toLowerCase();
  } catch {
    return normalizeText(value).replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

function toApiCoinCard(card) {
  return {
    player_name: card.playerName,
    rating: card.rating,
    position: card.position,
    player_img_url: card.playerImgUrl,
    bg_card_url: card.bgCardUrl,
    nation_img_url: card.nationImgUrl,
    min_price_cross: card.minPriceCross,
    price_cross: card.priceCross,
    max_price_cross: card.maxPriceCross,
    min_price_pc: card.minPricePc,
    price_pc: card.pricePc,
    max_price_pc: card.maxPricePc
  };
}

function toApiPlayer(player) {
  return {
    name: player.name,
    full_name: player.fullName,
    quality_id: player.qualityId,
    rarity_id: player.rarityId,
    rating: player.rating,
    fixed_name: player.fixedName,
    futbin_player_id: player.futbinPlayerId,
    futbin_player_link: player.futbinPlayerLink,
    futbin_squat_link: player.futbinSquatLink,
    position_id: player.positionId,
    url: player.url,
    url_img_player: player.urlImgPlayer,
    price_console: player.priceConsole,
    price_pc: player.pricePc,
    url_img_card: player.urlImgCard,
    url_img_nation: player.urlImgNation,
    url_img_league: player.urlImgLeague,
    url_img_club: player.urlImgClub,
    nation_id: player.nationId,
    alternative_positions: player.alternativePositions,
    active: player.active
  };
}

function validateMappedPlayer(player) {
  const errors = [];
  if (!player) return ["player boş"];
  if (!player.name) errors.push("player.name okunamadı");
  if (!Number.isInteger(Number(player.futbinPlayerId)) || Number(player.futbinPlayerId) <= 0) errors.push("player.futbin_player_id okunamadı");
  if (!Number.isInteger(Number(player.qualityId)) || Number(player.qualityId) <= 0) errors.push("player.quality_id okunamadı");
  if (!Number.isInteger(Number(player.rarityId)) || Number(player.rarityId) <= 0) errors.push("player.rarity_id okunamadı");
  if (!Number.isInteger(Number(player.rating)) || Number(player.rating) <= 0) errors.push("player.rating okunamadı");
  if (!Number.isInteger(Number(player.positionId)) || Number(player.positionId) <= 0) errors.push("player.position_id okunamadı");
  if (!Number.isInteger(Number(player.nationId)) || Number(player.nationId) <= 0) errors.push("player.nation_id okunamadı");
  if (!Number.isFinite(Number(player.priceConsole)) || Number(player.priceConsole) < 0) errors.push("player.price_console okunamadı");
  if (!Number.isFinite(Number(player.pricePc)) || Number(player.pricePc) < 0) errors.push("player.price_pc okunamadı");
  if (!player.urlImgCard) errors.push("player.url_img_card okunamadı");
  if (!player.urlImgNation) errors.push("player.url_img_nation okunamadı");
  if (!player.urlImgLeague) errors.push("player.url_img_league okunamadı");
  if (!player.urlImgClub) errors.push("player.url_img_club okunamadı");
  return errors;
}

function validateLookups(lookups) {
  if (!lookups || !Array.isArray(lookups.nations) || !Array.isArray(lookups.qualities) ||
      !Array.isArray(lookups.rarities) || !Array.isArray(lookups.positions)) {
    throw new Error("API oyuncu lookup verilerini döndürmedi.");
  }
}

function mapPlayer(row, lookups) {
  validateLookups(lookups);
  const name = normalizeText(row?.name);
  const nationName = normalizeText(row?.nationName);
  const positionName = normalizeText(row?.positionName);
  if (!name || !nationName || !positionName) {
    throw new Error(`[CRITICAL] Oyuncu map alanları eksik. Futbin ID: ${row?.futbinPlayerId || "—"}`);
  }
  if (nationName.localeCompare("New Caledonia", undefined, { sensitivity: "accent" }) === 0) return null;

  let nation = lookups.nations.find((item) =>
    sameLookupText(item.futbin_name, nationName) || lookupNameEquals(item.name, nationName));
  nation ||= lookups.nations.find((item) => lookupNameContains(item.name, nationName));
  if (!nation) throw new Error(`[CRITICAL] Ulus veritabanında bulunamadı! Oyuncu: ${name}, Ulus: ${nationName}`);

  const position = lookups.positions.find((item) => lookupNameEquals(item.name, positionName));
  if (!position) throw new Error(`[CRITICAL] Pozisyon veritabanında bulunamadı! Oyuncu: ${name}, Pozisyon: ${positionName}`);

  const cardImageUrl = normalizeText(row?.cardImageUrl);
  const fileName = cardImageUrl.split("/").pop()?.split("?")[0] || "";
  const parts = fileName.replace(/\.png$/i, "").split("_");
  const rarityFutbinId = Number(parts[0]);
  if (!cardImageUrl || parts.length < 2 || !Number.isInteger(rarityFutbinId)) {
    throw new Error(`[CRITICAL] Kart görsel adı parse edilemedi! Oyuncu: ${name}, Dosya: ${fileName}`);
  }

  const rarity = lookups.rarities.find((item) =>
    item.futbin_id !== null && item.futbin_id !== undefined && Number(item.futbin_id) === rarityFutbinId);
  if (!rarity) throw new Error(`Rarity bulunamadı! Oyuncu: ${name}, Futbin Rarity ID: ${rarityFutbinId}`);
  const cardQualityCode = normalizeText(parts[1]).toLowerCase();
  const baseRarity = rarityFutbinId === 0 || rarityFutbinId === 1;
  const qualityCode = baseRarity && ["bronze", "silver", "gold"].includes(cardQualityCode)
    ? cardQualityCode
    : "special";
  const quality = lookups.qualities.find((item) => sameLookupText(item.code, qualityCode));
  if (!quality) throw new Error(`Quality bulunamadı! Oyuncu: ${name}, Quality Code: ${qualityCode}`);

  const mapped = {
    name,
    fullName: name,
    qualityId: Number(quality.id),
    qualityCode,
    qualityIconUrl: quality.icon_url || null,
    qualityImageUrl: baseRarity ? cardImageUrl : SPECIAL_QUALITY_IMAGE_URL,
    rarityId: Number(rarity.id),
    rarityFutbinId,
    rarityCardName: rarityFutbinId === 0
      ? "Common"
      : rarityFutbinId === 1
        ? "Rare"
        : formatCardName(parts.slice(1).join("_")),
    rarityCode: rarityFutbinId === 0 ? "common" : rarityFutbinId === 1 ? "rare" : rarity.code || null,
    rarityName: rarityFutbinId === 0
      ? "Common"
      : rarityFutbinId === 1
        ? "Rare"
        : rarity.name?.tr || rarity.name?.en || rarity.code || String(rarityFutbinId),
    rating: Number(row.rating),
    fixedName: null,
    futbinPlayerId: Number(row.futbinPlayerId),
    futbinPlayerLink: row.futbinPlayerLink,
    futbinSquatLink: null,
    positionId: Number(position.id),
    positionName,
    url: null,
    urlImgPlayer: row.playerImageUrl || null,
    priceConsole: Number(row.priceConsole) || 0,
    pricePc: Number(row.pricePc) || 0,
    urlImgCard: cardImageUrl,
    urlImgNation: row.nationImageUrl || null,
    urlImgLeague: row.leagueImageUrl || null,
    urlImgClub: row.clubImageUrl || null,
    nationId: Number(nation.id),
    nationName,
    alternativePositions: row.alternativePositions || null,
    active: true
  };

  const validationErrors = validateMappedPlayer(mapped);
  if (validationErrors.length) throw new Error(validationErrors.join(", "));

  return mapped;
}

function lookupNameEquals(names, value) {
  return sameLookupText(names?.en, value) || sameLookupText(names?.tr, value);
}

function formatCardName(value) {
  return normalizeText(value)
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function lookupNameContains(names, value) {
  const valueNormalized = stripPunctuation(value);
  const valueTokens = valueNormalized.split(" ").filter(Boolean);
  return [names?.en, names?.tr].some((candidate) => {
    if (!candidate) return false;
    const dbNormalized = stripPunctuation(candidate);
    const dbTokens = dbNormalized.split(" ").filter(Boolean);
    return (dbTokens.length > 0 && dbTokens.every((token) => valueTokens.includes(token))) ||
      (String(candidate).includes(".") && valueNormalized.includes(dbNormalized));
  });
}

function sameLookupText(left, right) {
  if (!left || !right) return false;
  return normalizeText(left).localeCompare(normalizeText(right), undefined, { sensitivity: "accent" }) === 0;
}

function stripPunctuation(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

async function appendRecords(players, pageUrl, job, saveStatus = null, state = null) {
  // Oyuncular state içinde işlenmeye ve API'ye gönderilmeye devam eder; popup için kopyalanmaz.
  if (players.length) syncLog("Oyuncular arka planda işlendi", { count: players.length, pageUrl, jobId: job?.id || job?.club_id, saveStatus, runnerId: state?.runnerId || null });
}

function sortDisplayRecords(records = []) {
  return records.sort((left, right) => recordDisplayTime(right) - recordDisplayTime(left));
}

function recordDisplayTime(record = {}) {
  return Number(record.processedAt || record.capturedAt || record.runStartedAt || 0);
}

async function updateRecordSaveStatus(job, saveStatus, state = null) {
  syncLog("Arka plan kayıt durumu güncellendi", { jobId: job?.id || job?.club_id, saveStatus, runnerId: state?.runnerId || null });
}

async function clearCoinCardDisplayData() {
  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get([RECORDS_KEY, ERRORS_KEY]);
    const records = (stored[RECORDS_KEY] || []).filter((record) =>
      !String(record?.job?.operation || "").startsWith("coin-card"));
    const errors = (stored[ERRORS_KEY] || []).filter((entry) =>
      !String(entry?.job?.operation || "").startsWith("coin-card") &&
      !String(entry?.url || "").includes("coin-card"));
    await chrome.storage.local.set({ [RECORDS_KEY]: records, [ERRORS_KEY]: errors });
  });
}

async function getState(runnerId = null) {
  const stored = await chrome.storage.local.get(STATE_KEY);
  const root = normalizeRootState(stored[STATE_KEY]);
  if (runnerId) return root.runs?.[runnerId] || emptyRunnerState(runnerId, root);
  return aggregateRootState(root);
}

function normalizeOperations(rawOperations) {
  return [...new Set(Array.isArray(rawOperations) ? rawOperations : EXTENSION_OPERATIONS)]
    .filter((operation) => EXTENSION_OPERATIONS.includes(operation));
}

function operationRunnerId(operation) {
  return RUNNER_IDS.find((runnerId) => RUNNER_OPERATIONS[runnerId].includes(operation)) || null;
}

function emptyRunnerState(runnerId, root = {}) {
  const operations = RUNNER_OPERATIONS[runnerId] || [];
  return {
    ...emptyState,
    runnerId,
    apiBaseUrl: root.apiBaseUrl || emptyState.apiBaseUrl,
    waitMs: root.waitMs || emptyState.waitMs,
    operations,
    status: "Hazır"
  };
}

function normalizeRootState(value = {}) {
  const root = { ...emptyState, ...(value || {}) };
  const legacyRun = value?.runnerId || (Array.isArray(value?.operations) && value.operations.length === 1
    ? operationRunnerId(value.operations[0])
    : null);
  const runs = {};
  for (const runnerId of RUNNER_IDS) {
    runs[runnerId] = {
      ...emptyRunnerState(runnerId, root),
      ...(value?.runs?.[runnerId] || {})
    };
  }
  if (legacyRun && !value?.runs?.[legacyRun]) {
    runs[legacyRun] = { ...emptyRunnerState(legacyRun, root), ...value, runnerId: legacyRun };
  }
  return { ...root, runs };
}

function aggregateRootState(root) {
  const runs = RUNNER_IDS.reduce((all, runnerId) => ({
    ...all,
    [runnerId]: { ...emptyRunnerState(runnerId, root), ...(root.runs?.[runnerId] || {}) }
  }), {});
  const activeRun = RUNNER_IDS.map((runnerId) => runs[runnerId]).find((run) => run.running && !run.nextRunAt) ||
    RUNNER_IDS.map((runnerId) => runs[runnerId]).find((run) => run.running) ||
    RUNNER_IDS.map((runnerId) => runs[runnerId]).find((run) => run.updatedAt) ||
    runs[EXTENSION_RUNNER_ID];
  const queue = RUNNER_IDS.flatMap((runnerId) => runs[runnerId].queue || []);
  const operations = RUNNER_IDS.flatMap((runnerId) => runs[runnerId].operations || []);
  const clubSaveResults = RUNNER_IDS.reduce((results, runnerId) => ({
    ...results,
    ...(runs[runnerId].clubSaveResults || {})
  }), {});
  return {
    ...emptyState,
    ...activeRun,
    runs,
    running: RUNNER_IDS.some((runnerId) => runs[runnerId].running),
    queue,
    operations: [...new Set(operations)],
    clubSaveResults,
    savedPlayers: RUNNER_IDS.reduce((total, runnerId) => total + (Number(runs[runnerId].savedPlayers) || 0), 0),
    skippedPlayers: RUNNER_IDS.reduce((total, runnerId) => total + (Number(runs[runnerId].skippedPlayers) || 0), 0),
    apiBaseUrl: root.apiBaseUrl || activeRun?.apiBaseUrl || emptyState.apiBaseUrl,
    waitMs: root.waitMs || activeRun?.waitMs || emptyState.waitMs,
    updatedAt: Date.now()
  };
}

async function getStateByTabId(tabId) {
  const root = await getState();
  return Object.values(root.runs || {}).find((run) => run?.tabId === tabId) || emptyState;
}

function alarmRunnerId(stateOrRunnerId) {
  return typeof stateOrRunnerId === "string" ? stateOrRunnerId : stateOrRunnerId?.runnerId || "legacy";
}

function pageTimeoutAlarmName(stateOrRunnerId) {
  return `${PAGE_TIMEOUT_ALARM}:${alarmRunnerId(stateOrRunnerId)}`;
}

function syncLoopAlarmName(stateOrRunnerId) {
  return `${SYNC_LOOP_ALARM}:${alarmRunnerId(stateOrRunnerId)}`;
}

function jobAdvanceAlarmName(stateOrRunnerId) {
  return `${JOB_ADVANCE_ALARM}:${alarmRunnerId(stateOrRunnerId)}`;
}

function runnerIdFromAlarmName(name, prefix) {
  const marker = `${prefix}:`;
  return String(name || "").startsWith(marker) ? String(name).slice(marker.length) : null;
}

async function clearAllRunnerAlarms() {
  await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
  await chrome.alarms.clear(JOB_ADVANCE_ALARM);
  await chrome.alarms.clear(SYNC_LOOP_ALARM);
  await Promise.all(RUNNER_IDS.flatMap((runnerId) => [
    chrome.alarms.clear(pageTimeoutAlarmName(runnerId)),
    chrome.alarms.clear(jobAdvanceAlarmName(runnerId)),
    chrome.alarms.clear(syncLoopAlarmName(runnerId))
  ]));
}

function isLoopRestartDue(state) {
  return Boolean(state?.running && state?.nextRunAt && state.nextRunAt <= Date.now());
}

async function setState(state) {
  return enqueueStateWrite(async () => {
    const stored = await chrome.storage.local.get(STATE_KEY);
    let root = normalizeRootState(stored[STATE_KEY]);
    if (state?.runnerId) {
      const existingRun = root.runs?.[state.runnerId];
      const incomingRun = { ...emptyRunnerState(state.runnerId, root), ...state };
      if (
        existingRun?.runStartedAt &&
        incomingRun?.runStartedAt === existingRun.runStartedAt &&
        (existingRun.logs || []).length > (incomingRun.logs || []).length
      ) {
        incomingRun.logs = existingRun.logs;
      }
      root = {
        ...root,
        apiBaseUrl: state.apiBaseUrl || root.apiBaseUrl || emptyState.apiBaseUrl,
        waitMs: futbinRequestDelayMs(state.waitMs || root.waitMs || emptyState.waitMs),
        runs: {
          ...(root.runs || {}),
          [state.runnerId]: incomingRun
        },
        updatedAt: Date.now()
      };
    } else {
      root = normalizeRootState(state);
    }
    const aggregate = aggregateRootState(root);
    await chrome.storage.local.set({ [STATE_KEY]: aggregate });
    chrome.runtime.sendMessage({ type: "STATE_CHANGED", futbinSyncModule: "latest", state: aggregate }).catch(() => {});
  });
}

function enqueueStateWrite(task) {
  const next = stateWriteQueue.then(task, task);
  stateWriteQueue = next.catch(() => {});
  return next;
}

function enqueueStorageWrite(task) {
  const next = storageWriteQueue.then(task, task);
  storageWriteQueue = next.catch(() => {});
  return next;
}

async function scheduleNextLoop(state, totalSaved, totalSkipped, clubSaveResults, queue) {
  await chrome.alarms.clear(jobAdvanceAlarmName(state));
  await chrome.alarms.clear(syncLoopAlarmName(state));
  const liveState = await getState(state.runnerId);
  if (!await isActiveRun(state) || !liveState.running) {
    return { ok: true, action: "STOPPED" };
  }
  const latestResult = clubSaveResults?.["coin-card:latest"] || {};
  await appendLatestStepLog(state, {
    eventType: "step2-finished",
    message: "STEP 2/2\nFinished",
    page: "",
    url: "",
    queueSize: (queue || state.queue || []).filter((job) => job?.operation === "coin-cards").length,
    currentPlayer: "",
    newAddedCount: Number(latestResult.inserted) || 0,
    updatedCount: Number(latestResult.updated) || 0,
    failedCount: Number(totalSkipped) || 0,
    remainingCount: 0
  });
  printLatestFinishedSummary({
    newAdded: Number(latestResult.inserted) || 0,
    updated: Number(latestResult.updated) || 0,
    failed: Number(totalSkipped) || 0
  });
  await appendLatestEventLog(state, {
    eventType: "run-end",
    message: "Latest Coin Cards sync tamamlandı",
    page: "",
    url: "",
    startedAt: state.runStartedAt || null,
    finishedAt: Date.now(),
    durationMs: state.runStartedAt ? Date.now() - state.runStartedAt : null,
    inserted: Number(latestResult.inserted) || 0,
    updated: Number(latestResult.updated) || 0,
    deleted: Number(latestResult.deleted) || 0,
    saved: Number(totalSaved) || 0,
    skipped: Number(totalSkipped) || 0
  });

  const oneShot = Boolean(state.runOnce || state.centralManaged);
  const nextRunAt = oneShot ? null : Date.now() + SYNC_LOOP_DELAY_MS;
  const waiting = {
    ...state,
    running: false,
    userStarted: !oneShot,
    queue: [],
    currentJobIndex: -1,
    currentPage: 0,
    totalPages: 0,
    tabId: null,
    currentUrl: null,
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + (totalSaved || 0),
    skippedPlayers: state.skippedPlayers + (totalSkipped || 0),
    clubSaveResults,
    currentLatest: null,
    latestCoinCardJobsSnapshot: [],
    latestCoinCardJobsSnapshotLoaded: false,
    currentSkipped: 0,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    failedPages: [],
    nextRunAt,
    status: oneShot ? FINISHED_STATUS : "Waiting for next synchronization...",
    updatedAt: Date.now()
  };
  await setState(waiting);
  await closeRunnerTab(state.tabId, state);
  if (!oneShot) {
    await scheduleLoopAlarm(waiting);
    startImportantAfterLatestCompletion().catch((error) => {
      syncError("Latest sonrası Important Players başlatılamadı", error);
    });
  }
  if (waiting.centralManaged) await notifyCentralRoundFinished(waiting, true);
  return { ok: true, action: "COMPLETED", state: waiting };
}

async function startImportantAfterLatestCompletion() {
  const startImportant = globalThis.FutbinSyncModuleControls?.important?.startAfterLatest;
  if (typeof startImportant !== "function") {
    throw new Error("Important Players kontrol modülü yüklenmedi.");
  }
  try {
    const response = await startImportant();
    syncLog("Latest sonrası Important Players kontrolü tamamlandı", {
      started: response?.ok === true && response?.skipped !== true,
      skipped: response?.skipped === true,
      reason: response?.reason || null
    });
    return response;
  } catch (error) {
    syncError("Latest sonrası Important Players başlatılamadı", error);
    throw error;
  }
}

async function scheduleJobAdvance(state) {
  if (!await isActiveRun(state)) return;
  const when = Math.max(Date.now(), Number(state.nextRunAt) || Date.now());
  await closeRunnerTab(state.tabId, state);
  if (!await isActiveRun(state)) return;
  if (state.tabId) await setState({ ...state, tabId: null, updatedAt: Date.now() });
  await chrome.alarms.create(jobAdvanceAlarmName(state), { when });
  if (!await isActiveRun(state)) {
    await chrome.alarms.clear(jobAdvanceAlarmName(state));
    return;
  }
  syncLog("Sonraki iş alarmı kuruldu", { ...stateLogDetails(state), alarmAt: new Date(when).toISOString() });
}

async function scheduleLoopAlarm(state) {
  if (!await isFcSyncEnabled()) {
    await chrome.alarms.clear(syncLoopAlarmName(state));
    return;
  }
  const when = Math.max(Date.now(), Number(state.nextRunAt) || Date.now() + SYNC_LOOP_DELAY_MS);
  await chrome.alarms.clear(syncLoopAlarmName(state));
  await chrome.alarms.create(syncLoopAlarmName(state), { when });
  syncLog("Sonraki otomatik sync alarmı kuruldu", { ...stateLogDetails(state), alarmAt: new Date(when).toISOString() });
}

function isFinishedState(state) {
  return state?.status === FINISHED_STATUS;
}

async function isFcSyncEnabled() {
  return Boolean((await chrome.storage.local.get(FC_SYNC_ENABLED_KEY))[FC_SYNC_ENABLED_KEY]);
}

function sameRun(expected, current) {
  return !expected?.runStartedAt || expected.runStartedAt === current?.runStartedAt;
}

async function isActiveRun(expected) {
  const current = await getState(expected?.runnerId);
  return Boolean(current.running && !isFinishedState(current) && sameRun(expected, current));
}

function notifyCentralRoundFinished(state, ok) {
  const message = {
    futbinSyncModule: "fc-sync",
    type: "MODULE_ROUND_FINISHED",
    module: "latest",
    runId: state.centralRunId,
    ok,
    error: ok ? null : state.error || state.status
  };
  const directOrchestrator = globalThis.FutbinSyncCentralOrchestrator;
  if (typeof directOrchestrator?.moduleRoundFinished === "function") {
    void directOrchestrator.moduleRoundFinished(message);
    return;
  }
  chrome.runtime.sendMessage(message).catch(() => {
    // Merkezi background yeniden başlatılmış olabilir; stale olay merkezi runId ile yok sayılır.
  });
}

function futbinRequestDelayMs(value) {
  const raw = value && typeof value === "object" ? value.waitMs : value;
  const number = Number(raw);
  return Math.min(30000, Math.max(5000, Number.isFinite(number) && number > 0 ? number : emptyState.waitMs));
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

function stateLogDetails(state) {
  const job = currentJob(state);
  return {
    runnerId: state?.runnerId || "legacy",
    tabId: state?.tabId ?? null,
    jobIndex: state?.currentJobIndex,
    queueLength: state?.queue?.length || 0,
    jobId: job?.id ?? null,
    jobLabel: job?.label || job?.club_name || null,
    page: state?.currentPage,
    currentUrl: state?.currentUrl,
    nextRunAt: state?.nextRunAt || null,
    status: state?.status
  };
}
