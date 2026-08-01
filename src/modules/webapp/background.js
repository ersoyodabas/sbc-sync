const STATE_KEY = "webAppSyncState";
const RECORDS_KEY = "webAppPlayerRecords";
const LOGS_KEY = "webAppSyncLogs";
const ERRORS_KEY = "webAppSyncErrors";
const WEB_APP_RARITY_PHASE_KEY = "webAppOnlyRaritySyncPhase";
const WEB_APP_FLOW_STATE_KEY = "webAppOnlySyncFlowState";
const PAGE_TIMEOUT_ALARM = "webapp-sync-page-timeout";
const SYNC_LOOP_ALARM = "webapp-sync-loop";
const WEB_APP_DAILY_ALARM = "webapp-sync-daily";
const WEB_APP_WATCHDOG_ALARM = "webapp-sync-watchdog";
const DAILY_RUN_LOGS_KEY = "webAppOnlyDailyRunLogs";
const API_CONFIG = globalThis.FutbinSyncApiConfig;
const DEFAULT_API_BASE_URL = API_CONFIG.defaultBaseUrl();
const LOG_WRITER_NATIVE_HOST = "com.sbcmonster.webappsync_logger";
const DAILY_JSON_LOG_FILE = "logs.json";
const DAILY_LOG_RETENTION_DAYS = 7;
const DAILY_LOG_DISPLAY_LIMIT = 3;
const WEB_APP_MESSAGE_RETRY_COUNT = 120;
const WEB_APP_MESSAGE_RETRY_DELAY_MS = 250;
const WEB_APP_LOGIN_REDIRECT_GRACE_MS = 150000;
const FUTBIN_CHALLENGE_MAX_WAIT_MS = 60000;
let ENV = null;
async function getEnv() {
  ENV = {};
  try {
    const response = await fetch(`${chrome.runtime.getURL(".env")}?t=${Date.now()}`, { cache: "no-store" });
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
const MAX_RECORDS = 500;
const MAX_LOGS = 1000;
const MAX_ERRORS = 300;
const FUTBIN_LATEST_URL = "https://www.futbin.com/latest";
const WEB_APP_URL = "https://www.ea.com/ea-sports-fc/ultimate-team/web-app/";
const WEB_APP_SYNC_ENDPOINT = "sync/web-app";
const NEW_SBC_TELEGRAM_ENDPOINT = "notify/notify-new-sbcs-arrived";
const LATEST_COIN_CARD_PAGES = 2;
const SPECIAL_QUALITY_IMAGE_URL = "https://cdn3.futbin.com/content/fifa26/img/cards/tiny/3_gold.png?fm=png&ixlib=java-2.1.0&verzion=1&w=128&s=d72e95665680dee8e3818602d714323a";
const EXTENSION_RUNNER_ID = "web-app-sync";
const EXTENSION_OPERATIONS = ["web-app-sync"];
const RUNNER_IDS = [EXTENSION_RUNNER_ID];
const RUNNER_OPERATIONS = { [EXTENSION_RUNNER_ID]: EXTENSION_OPERATIONS };
const FINISHED_STATUS = "Finished";
let stateWriteQueue = Promise.resolve();
let storageWriteQueue = Promise.resolve();
let webAppDailyCheckPromise = null;
let runToken = 0;
const activeRequestControllers = new Set();
const webAppNavigationVersions = new Map();
const webAppCollectionDispatches = new Map();

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
  newlyInsertedCoinCardIds: [],
  currentSkipped: 0,
  webAppLoginSubmittedAt: null,
  pagesAttempted: 0,
  pagesSucceeded: 0,
  failedPages: [],
  completedClubs: 0,
  operations: ["club-players"],
  savedPlayers: 0,
  skippedPlayers: 0,
  clubSaveResults: {},
  nextRunAt: null,
  runStartedAt: null,
  status: "Hazır",
  error: null,
  updatedAt: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY, DAILY_RUN_LOGS_KEY]);
  if (!saved[STATE_KEY]) await setState(emptyState);
  if (!saved[RECORDS_KEY]) await chrome.storage.local.set({ [RECORDS_KEY]: [] });
  if (!saved[LOGS_KEY]) await chrome.storage.local.set({ [LOGS_KEY]: [] });
  if (!saved[ERRORS_KEY]) await chrome.storage.local.set({ [ERRORS_KEY]: [] });
  if (!saved[DAILY_RUN_LOGS_KEY]) await chrome.storage.local.set({ [DAILY_RUN_LOGS_KEY]: [] });
});

chrome.runtime.onStartup.addListener(async () => {
  await resumeRunningSync();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.futbinSyncModule !== "webapp") return false;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(async (error) => {
      await failSync(error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_SYNC":
      return startParallelSync(message.apiBaseUrl, message.waitMs, message.operations, Boolean(message.forceNow));
    case "RESUME_SYNC":
      return resumePausedSync();
    case "STOP_SYNC":
      return pauseSync(message.operations);
    case "CLEAR_SYNC":
      await clearAllRunnerAlarms();
      {
        const current = await getState();
        for (const run of Object.values(current.runs || {})) {
          if (run?.tabId) {
            try { await chrome.tabs.remove(run.tabId); } catch { /* Sekme zaten kapanmış olabilir. */ }
          }
        }
        if (current.tabId) {
          try { await chrome.tabs.remove(current.tabId); } catch { /* Legacy sekme zaten kapanmış olabilir. */ }
        }
      }
      await setState({ ...emptyState, apiBaseUrl: message.apiBaseUrl || emptyState.apiBaseUrl });
      await chrome.storage.local.set({ [RECORDS_KEY]: [], [LOGS_KEY]: [], [ERRORS_KEY]: [] });
      return { ok: true };
    case "GET_SNAPSHOT":
      {
        const snapshot = await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY, DAILY_RUN_LOGS_KEY]);
        snapshot[DAILY_RUN_LOGS_KEY] = await getVerifiedDailyRunLogs();
        return { ok: true, ...snapshot };
      }
    case "GET_SNAPSHOT_PASSIVE":
      return { ok: true, ...(await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY, DAILY_RUN_LOGS_KEY])) };
    case "DELETE_DAILY_RUN_LOG":
      return deleteDailyRunLog(message.date);
    case "FOCUS_WEB_APP_TAB":
      if (!sender.tab?.id) return { ok: false, error: "Web App sekmesi bulunamadı." };
      await chrome.tabs.update(sender.tab.id, { active: true });
      await chrome.windows.update(sender.tab.windowId, { focused: true });
      return { ok: true };
    case "REAL_MOUSE_CLICK":
      return dispatchRealMouseClick(message, sender);
    case "WEB_APP_SYNC_LOG":
      return appendWebAppSyncLog(message, sender);
    case "WEB_APP_API_REQUEST":
      return handleWebAppApiRequest(message, sender);
    case "WEB_APP_LOGIN_SUBMITTED":
      return handleWebAppLoginSubmitted(message, sender);
    case "WEB_APP_SYNC_COMPLETE":
      return handleWebAppSyncComplete(message, sender);
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

async function dispatchRealMouseClick(message, sender) {
  if (!sender.tab?.id) return { ok: false, error: "Tıklanacak sekme bulunamadı." };
  const state = await getStateByTabId(sender.tab.id);
  if (!state.running || isFinishedState(state) || state.tabId !== sender.tab.id) {
    return { ok: false, error: "Aktif Web App Sync çalışması bulunamadı." };
  }

  const x = Number(message.x);
  const y = Number(message.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: "Geçersiz mouse koordinatı." };
  }

  const debuggee = { tabId: sender.tab.id };
  let attached = false;
  try {
    await chrome.tabs.update(sender.tab.id, { active: true });
    await chrome.windows.update(sender.tab.windowId, { focused: true });
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(debuggee); } catch { /* Zaten ayrılmış olabilir. */ }
    }
  }
}

async function startParallelSync(rawApiBaseUrl, rawWaitMs, rawOperations, forceNow = false) {
  const token = ++runToken;
  const operations = normalizeOperations(rawOperations);
  if (!operations.length) throw new Error("En az bir işlem seçilmelidir.");
  const runnerIds = [...new Set(operations.map(operationRunnerId).filter(Boolean))];
  const results = await Promise.all(runnerIds.map(async (runnerId) => {
    try {
      const run = await getState(runnerId);
      const nextRunCount = runnerId === "web-app-sync" ? (run.runCount || 0) : (run.runCount || 0) + 1;
      return await startFreshSync(rawApiBaseUrl, rawWaitMs, RUNNER_OPERATIONS[runnerId], nextRunCount, runnerId, forceNow, null, token, true);
    } catch (error) {
      const run = await getState(runnerId);
      await failSync(error.message || String(error), run);
      return { ok: false, runnerId, error: error.message || String(error) };
    }
  }));
  if (!results.some((result) => result?.ok)) throw new Error(results.map((result) => result?.error).filter(Boolean).join("; ") || "Sync başlatılamadı.");
  return { ok: true, state: await getState(), results };
}

async function startFreshSync(rawApiBaseUrl, rawWaitMs, rawOperations, runCount = 0, rawRunnerId = null, isScheduledStart = false, dailyLogDate = null, token = runToken, explicitStart = false) {
  const operations = normalizeOperations(rawOperations);
  if (!operations.length) throw new Error("En az bir işlem seçilmelidir.");
  const runnerId = rawRunnerId || operationRunnerId(operations[0]);
  if (!runnerId) throw new Error("Desteklenmeyen sync işlemi.");
  const previous = await getState(runnerId);
  if (isFinishedState(previous) && !explicitStart) return { ok: false, finished: true, state: previous };
  if (previous.running && !isLoopRestartDue(previous)) {
    return { ok: true, state: previous, alreadyRunning: true };
  }

  const env = await getEnv();
  if (token !== runToken) return { ok: false, stopped: true, state: await getState(runnerId) };

  if (runnerId === "web-app-sync" && !isScheduledStart) {
    const config = buildWebAppDailyScheduleConfig(env);
    if (!config) {
      throw new Error("WEB_APP_SYNC_TIME .env dosyasında tanımlı değil veya geçersiz.");
    }
    const nextRunAt = config.nextRunAt;
    await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
    const apiBaseUrl = normalizeApiBaseUrl(DEFAULT_API_BASE_URL);
    const waitMs = Math.min(30000, Math.max(5000, Number(rawWaitMs || env.WAIT_MS) || 5000));
    const scheduled = {
      ...previous,
      runnerId: "web-app-sync",
      running: false,
      userStarted: true,
      queue: [],
      currentJobIndex: -1,
      currentPage: 0,
      totalPages: 0,
      currentUrl: null,
      tabId: null,
      apiBaseUrl,
      waitMs,
      operations: ["web-app-sync"],
      nextRunAt,
      scheduleTime: config.timeText,
      status: `Günlük Web App Sync ${config.timeText} için bekliyor`,
      updatedAt: Date.now()
    };
    if (token !== runToken) return { ok: false, stopped: true, state: await getState(runnerId) };
    await setState(scheduled);
    if (token !== runToken) return { ok: false, stopped: true, state: await getState(runnerId) };
    await chrome.alarms.create(WEB_APP_DAILY_ALARM, { when: nextRunAt });
    await appendWebAppSchedulerLog("Countdown started", {
      nextRunAt,
      scheduleTime: config.timeText,
      source: "start-sync"
    });
    return { ok: true, state: scheduled };
  }
  const apiBaseUrl = runnerId === "web-app-sync"
    ? normalizeApiBaseUrl(DEFAULT_API_BASE_URL)
    : normalizeApiBaseUrl(rawApiBaseUrl || API_CONFIG.defaultBaseUrl());
  const waitMs = Math.min(30000, Math.max(5000, Number(rawWaitMs || env.WAIT_MS) || 5000));
  const runStartedAt = Date.now();

  const queue = [];
  let lookups = null;
  if (operations.includes("web-app-sync")) {
    queue.push({
      id: "web-app-sync",
      label: "EA Web App",
      url: WEB_APP_URL,
      endpoint: WEB_APP_SYNC_ENDPOINT,
      operation: "web-app-sync"
    });
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
    try { await chrome.tabs.remove(previous.tabId); } catch { /* Eski sekme zaten kapanmış olabilir. */ }
  }
  if (operations.includes("web-app-sync")) {
    await chrome.storage.local.remove([WEB_APP_RARITY_PHASE_KEY, WEB_APP_FLOW_STATE_KEY]);
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
      status: "Seçilen işlemler için bekleyen iş yok",
      updatedAt: Date.now()
    };
    await setState(state);
    return { ok: true, state };
  }

  const tab = await chrome.tabs.create({ url: "about:blank", active: operations.includes("web-app-sync") });
  if (token !== runToken) {
    await closeRunnerTab(tab.id);
    return { ok: false, stopped: true, state: await getState(runnerId) };
  }
  const firstJob = queue[0];
  const state = {
    ...emptyState,
    runnerId,
    running: true,
    userStarted: true,
    queue,
    operations,
    lookups,
    runCount,
    runStartedAt,
    dailyLogDate,
    currentJobIndex: 0,
    currentPage: 1,
    totalPages: 1,
    currentUrl: buildJobUrl(firstJob, 1),
    tabId: tab.id,
    apiBaseUrl,
    waitMs,
    status: jobStatus(firstJob, 0, queue.length, "Sayfa açılıyor"),
    updatedAt: Date.now()
  };
  await setState(state);
  await appendWebAppBackgroundLog(state, "TAB", "Yeni çalışma sekmesi açıldı", {
    tabId: tab.id,
    url: tab.url || "about:blank",
    active: operations.includes("web-app-sync")
  });
  await navigateToCurrentPage(state);
  return { ok: true, state };
}

async function resumePausedSync() {
  const state = await getState();
  if (state.running) return { ok: true, state };
  if (isFinishedState(state)) throw new Error("Yeniden başlatmak için Start Sync düğmesine basın.");
  if (!state.queue?.length || state.currentJobIndex < 0 || state.currentJobIndex >= state.queue.length) {
    throw new Error("Devam ettirilecek tarama bulunamadı.");
  }

  let tab;
  try { tab = state.tabId ? await chrome.tabs.get(state.tabId) : null; } catch { /* Yeni sekme oluştur. */ }
  if (!tab) tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const resumed = {
    ...state,
    running: true,
    tabId: tab.id,
    error: null,
    nextRunAt: null,
    status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, "Tarama sürdürülüyor"),
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
      if (run.running) await resumeRunningRunner(run);
    }
    return;
  }
  const state = root;
  await resumeRunningRunner(state);
}

async function resumeRunningRunner(state) {
  if (!state.running || isFinishedState(state)) return;
  if (state.nextRunAt) {
    if (state.nextRunAt <= Date.now()) {
      await startFreshSync(state.apiBaseUrl, state.waitMs, state.operations, (state.runCount || 0) + 1, state.runnerId, true);
    } else {
      await chrome.alarms.create(syncLoopAlarmName(state), { when: state.nextRunAt });
    }
    return;
  }
  let tab;
  try { tab = state.tabId ? await chrome.tabs.get(state.tabId) : null; } catch { /* Yeni sekme oluştur. */ }
  if (!tab) tab = await chrome.tabs.create({ url: "about:blank", active: state.runnerId === "web-app-sync" });
  const resumed = { ...state, tabId: tab.id, nextRunAt: null, updatedAt: Date.now() };
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
      chrome.alarms.clear(syncLoopAlarmName(runnerId))
    ]));
    if (requestedRunnerIds.includes("web-app-sync")) {
      await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
      await chrome.alarms.clear(WEB_APP_WATCHDOG_ALARM);
    }
  } else {
    await clearAllRunnerAlarms();
    await chrome.alarms.clear(WEB_APP_WATCHDOG_ALARM);
  }
  for (const controller of activeRequestControllers) controller.abort();
  activeRequestControllers.clear();
  for (const state of states) {
    const stopped = {
      ...state,
      running: false,
      userStarted: false,
      queue: [],
      currentJobIndex: -1,
      currentPage: 0,
      totalPages: 0,
      currentUrl: null,
      tabId: null,
      currentPlayers: {},
      currentLatest: null,
      newlyInsertedCoinCardIds: [],
      nextRunAt: null,
      status: FINISHED_STATUS,
      error: null,
      updatedAt: Date.now()
    };
    await setState(stopped);
    if (state.tabId) {
      try { await chrome.tabs.remove(state.tabId); } catch { /* Sekme zaten kapanmış olabilir. */ }
    }
  }
  return { ok: true, state: await getState() };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    if (isEaWebAppUrl(changeInfo.url || tab.url)) {
      webAppNavigationVersions.set(tabId, (webAppNavigationVersions.get(tabId) || 0) + 1);
      clearWebAppCollectionDispatches(tabId);
    }
    return;
  }
  if (changeInfo.status !== "complete") return;
  const state = await getStateByTabId(tabId);
  if (!state.running || tabId !== state.tabId || !matchesCurrentPage(tab.url, state)) return;
  if (state.runnerId === "web-app-sync") {
    await activateRunnerTab(tabId);
    await appendWebAppBackgroundLog(state, "TAB", "Web App sekmesi load tamamlandı; işlem hazırlığı yapılıyor", {
      tabId,
      loadedUrl: tab.url
    });
    if (shouldSuppressLoginRedirectCollection(state, tab.url)) {
      await appendWebAppSyncLog({
        step: "LOGIN",
        message: "Sign In sonrası ara signin yönlendirmesi algılandı; Web App Settings/Ayarlar bekleniyor.",
        details: {
          pageUrl: tab.url,
          loginSubmittedAt: state.webAppLoginSubmittedAt || null,
          elapsedMs: Date.now() - Number(state.webAppLoginSubmittedAt || Date.now())
        }
      }, {});
      return;
    }
    await chrome.alarms.clear(pageTimeoutAlarmName(state));
    try {
      await appendWebAppBackgroundLog(state, "TAB", "Web App content script işlemi başlatılıyor", {
        tabId,
        loadedUrl: tab.url
      });
      await dispatchWebAppCollection(state);
    } catch (error) {
      await failSync(`İçerik script'i çalışmadı: ${error.message || state.currentUrl}`, state);
    }
    return;
  }
  try {
    await appendWebAppBackgroundLog(state, "TAB", "Futbin sekmesi load tamamlandı; hedef DOM kontrol ediliyor", {
      tabId,
      loadedUrl: tab.url
    });
    await waitForFutbinTargetHtml(tabId, tab.url || state.currentUrl, state);
    await appendWebAppBackgroundLog(state, "TAB", "Futbin hedef DOM hazır; content script başlatılıyor", {
      tabId,
      loadedUrl: tab.url
    });
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
  } catch {
    await handlePageFailure(`İçerik script'i çalışmadı: ${state.currentUrl}`, state);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearWebAppCollectionDispatches(tabId);
  webAppNavigationVersions.delete(tabId);
  const state = await getStateByTabId(tabId);
  if (state.running && state.tabId === tabId) await failSync("Çalışma sekmesi kapatıldı", state);
});

function clearWebAppCollectionDispatches(tabId) {
  const marker = `:${tabId}:`;
  for (const key of webAppCollectionDispatches.keys()) {
    if (key.includes(marker)) webAppCollectionDispatches.delete(key);
  }
}

function isEaWebAppUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "signin.ea.com" ||
      (url.hostname === "www.ea.com" &&
        url.pathname.replace(/\/+$/, "") === "/ea-sports-fc/ultimate-team/web-app");
  } catch {
    return false;
  }
}

function isSignInUrl(value) {
  try {
    return new URL(value).hostname === "signin.ea.com";
  } catch {
    return false;
  }
}

function isWebAppHomeUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "www.ea.com" &&
      url.pathname.replace(/\/+$/, "") === "/ea-sports-fc/ultimate-team/web-app";
  } catch {
    return false;
  }
}

function shouldSuppressLoginRedirectCollection(state, url) {
  const submittedAt = Number(state?.webAppLoginSubmittedAt) || 0;
  return Boolean(
    submittedAt &&
    Date.now() - submittedAt < WEB_APP_LOGIN_REDIRECT_GRACE_MS &&
    isSignInUrl(url)
  );
}

function webAppCollectionMessage(state) {
  return {
    type: "COLLECT_SYNC_PAGE",
    job: currentJob(state),
    operation: "web-app-sync",
    page: state.currentPage,
    expectedUrl: state.currentUrl,
    waitMs: futbinRequestDelayMs(state),
    runStartedAt: state.runStartedAt || null
  };
}

async function dispatchWebAppCollection(state) {
  const navigationVersion = webAppNavigationVersions.get(state.tabId) || 0;
  const dispatchKey = `${state.runStartedAt || 0}:${state.tabId}:${navigationVersion}`;
  const existingDispatch = webAppCollectionDispatches.get(dispatchKey);
  if (existingDispatch) return existingDispatch;

  const dispatch = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= WEB_APP_MESSAGE_RETRY_COUNT; attempt++) {
      const liveState = await getState(state.runnerId);
      const currentNavigationVersion = webAppNavigationVersions.get(state.tabId) || 0;
      if (!liveState.running || !sameRun(state, liveState) ||
        liveState.tabId !== state.tabId || currentNavigationVersion !== navigationVersion) {
        return { ok: false, stale: true };
      }

      try {
        const tab = await chrome.tabs.get(state.tabId);
        if (!matchesCurrentPage(tab.url, liveState)) {
          return { ok: false, stale: true };
        }
        if (isWebAppHomeUrl(tab.url) && liveState.webAppLoginSubmittedAt) {
          await setState({ ...liveState, webAppLoginSubmittedAt: null, updatedAt: Date.now() });
          liveState.webAppLoginSubmittedAt = null;
        }
        return await chrome.tabs.sendMessage(state.tabId, webAppCollectionMessage(liveState));
      } catch (error) {
        lastError = error;
        if (attempt < WEB_APP_MESSAGE_RETRY_COUNT) {
          await new Promise((resolve) => setTimeout(resolve, WEB_APP_MESSAGE_RETRY_DELAY_MS));
        }
      }
    }
    throw lastError || new Error("Content script mesajı teslim edilemedi.");
  })();

  webAppCollectionDispatches.set(dispatchKey, dispatch);
  return dispatch;
}

async function handleWebAppLoginSubmitted(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!state.running || state.runnerId !== "web-app-sync" || state.tabId !== sender.tab?.id) {
    return { ok: false, error: "Aktif Web App Sync çalışması bulunamadı." };
  }
  const submittedAt = Number(message.submittedAt) || Date.now();
  const updated = {
    ...state,
    webAppLoginSubmittedAt: submittedAt,
    status: "EA Web App: Sign In sonrası Settings/Ayarlar bekleniyor",
    updatedAt: Date.now()
  };
  await setState(updated);
  await appendWebAppSyncLog({
    step: "LOGIN",
    message: "Sign In tıklandı; ara yönlendirmelerde yeni login akışı başlatılmayacak.",
    details: {
      submittedAt,
      pageUrl: sender.tab?.url || message.pageUrl || null
    }
  }, sender);
  return { ok: true };
}

async function handleWebAppApiRequest(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!state.running || state.runnerId !== "web-app-sync" || state.tabId !== sender.tab?.id) {
    return { ok: false, status: 0, error: "Aktif Web App Sync çalışması bulunamadı." };
  }

  const method = String(message.method || "GET").toUpperCase();
  const endpoint = String(message.endpoint || "").trim().replace(/^\/+/, "");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
    !endpoint ||
    endpoint.includes("://") ||
    endpoint.includes("..")) {
    return { ok: false, status: 0, error: "Geçersiz Web App API isteği." };
  }

  try {
    const apiBaseUrl = await resolveApiBaseUrl(state.apiBaseUrl);
    const response = await apiRequest(apiBaseUrl, endpoint, {
      method,
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(message.body || {})
    });
    return { ok: true, status: 200, response };
  } catch (error) {
    return {
      ok: false,
      status: Number(error.status) || 0,
      error: error.message || String(error),
      response: { result: false, message: error.message || String(error), data: null }
    };
  }
}

async function ensureAutomaticSchedule() {
  if (EXTENSION_RUNNER_ID === "web-app-sync") return ensureWebAppWatchdog();

  const state = await getState(EXTENSION_RUNNER_ID);
  if (isFinishedState(state)) return state;
  if (state.running) return state;
  if (Number(state.nextRunAt) > Date.now()) {
    await chrome.alarms.create(syncLoopAlarmName(state), { when: state.nextRunAt });
    return state;
  }
  return startFreshSync(state.apiBaseUrl, state.waitMs, EXTENSION_OPERATIONS, (state.runCount || 0) + 1, EXTENSION_RUNNER_ID, true);
}

async function ensureWebAppWatchdog() {
  const state = await getState("web-app-sync");
  if (isFinishedState(state)) {
    await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
    await chrome.alarms.clear(WEB_APP_WATCHDOG_ALARM);
    return state;
  }
  const config = await getWatchdogConfig();
  await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
  await chrome.alarms.create(WEB_APP_DAILY_ALARM, {
    when: nextDailyRunAt(config.targetHour, config.targetMinute, Date.now())
  });
  await chrome.alarms.create(WEB_APP_WATCHDOG_ALARM, { periodInMinutes: config.checkIntervalMinutes });
  return checkWebAppDailyRun(Date.now(), config);
}

async function checkWebAppDailyRun(nowMs = Date.now(), config = null) {
  if (webAppDailyCheckPromise) return webAppDailyCheckPromise;
  webAppDailyCheckPromise = performWebAppDailyRunCheck(nowMs, config).finally(() => {
    webAppDailyCheckPromise = null;
  });
  return webAppDailyCheckPromise;
}

async function performWebAppDailyRunCheck(nowMs = Date.now(), rawConfig = null) {
  const config = rawConfig || await getWatchdogConfig();
  const adjusted = adjustedDateParts(nowMs);
  const state = await getState("web-app-sync");
  if (isFinishedState(state)) return { ok: true, skipped: true, finished: true, state };
  const logs = await getVerifiedDailyRunLogs();
  const currentMinutes = adjusted.hour * 60 + adjusted.minute;
  const targetMinutes = config.targetHour * 60 + config.targetMinute;
  const successfulDates = new Set(logs.filter((entry) => entry.status === "success").map((entry) => entry.date));
  const todayCompleted = successfulDates.has(adjusted.date);

  // Bugünün başarı kaydı kesin kilittir. Popup açılması, watchdog veya eski bir
  // alarm aynı gün içinde yeni bir çalışma başlatamaz.
  if (todayCompleted) {
    const nextRunAt = nextAdjustedStart(nowMs, config);
    const status = `${adjusted.date} başarıyla tamamlandı; sonraki ${config.targetTime} bekleniyor`;
    if (!state.running) {
      await setState({
        ...state,
        status,
        nextRunAt,
        scheduleTime: config.targetTime,
        clockAdjustmentHours: config.clockAdjustmentHours,
        detectedTimeZone: config.detectedTimeZone,
        checkIntervalMinutes: config.checkIntervalMinutes,
        updatedAt: nowMs
      });
    }
    return { ok: true, skipped: true, completedDueDate: true, dueDate: adjusted.date, state };
  }
  const dueDate = adjusted.date;
  const targetReached = currentMinutes >= targetMinutes;
  if (state.error && Number(state.nextRunAt) > nowMs) {
    await chrome.alarms.create(WEB_APP_DAILY_ALARM, { when: state.nextRunAt });
    return {
      ok: true,
      skipped: true,
      waitingAfterFailure: true,
      dueDate,
      nextRunAt: state.nextRunAt,
      state
    };
  }

  if (!targetReached || state.running) {
    const status = state.running
      ? state.status
      : `${dueDate} çalışma saati ${config.targetTime} için bekleniyor`;
    if (!state.running) {
      const nextRunAt = nextAdjustedStart(nowMs, config);
      const scheduleChanged = state.status !== status ||
        Number(state.checkIntervalMinutes) !== config.checkIntervalMinutes ||
        Number(state.clockAdjustmentHours) !== config.clockAdjustmentHours ||
        state.scheduleTime !== config.targetTime ||
        Math.abs(Number(state.nextRunAt) - nextRunAt) > 1000;
      if (scheduleChanged) {
        await setState({ ...state, status, nextRunAt, scheduleTime: config.targetTime, clockAdjustmentHours: config.clockAdjustmentHours, detectedTimeZone: config.detectedTimeZone, checkIntervalMinutes: config.checkIntervalMinutes, updatedAt: nowMs });
      }
    }
    return { ok: true, skipped: true, completedDueDate: false, dueDate, targetReached, state };
  }

  await appendWebAppSyncLog({
    step: "WATCHDOG",
    message: `${dueDate} tarihine ait tamamlanmış log bulunamadı. Sync hemen başlatılıyor.`,
    details: { dueDate, adjustedNow: `${adjusted.date} ${adjusted.time}`, targetTime: config.targetTime }
  }, {});
  return startFreshSync(DEFAULT_API_BASE_URL, 5000, ["web-app-sync"], (state.runCount || 0) + 1, "web-app-sync", true, dueDate);
}

async function getWatchdogConfig() {
  const env = await getEnv();
  const target = parseDailyTime(env.WEB_APP_SYNC_TIME) || { hour: 20, minute: 0, text: "20:00" };
  const interval = Number(env.WEB_APP_CHECK_INTERVAL_MINUTES);
  return {
    checkIntervalMinutes: Number.isFinite(interval) ? Math.min(1440, Math.max(1, interval)) : 5,
    targetHour: target.hour,
    targetMinute: target.minute,
    targetTime: target.text,
    clockAdjustmentHours: 0,
    detectedTimeZone: runtimeTimeZone()
  };
}

function runtimeTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
}

function adjustedDateParts(nowMs = Date.now()) {
  const local = new Date(nowMs);
  const year = local.getFullYear();
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  const hour = local.getHours();
  const minute = local.getMinutes();
  const second = local.getSeconds();
  return {
    date: `${year}-${month}-${day}`,
    hour,
    minute,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`
  };
}

function nextAdjustedStart(nowMs, config) {
  return nextDailyRunAt(config.targetHour, config.targetMinute, nowMs);
}

async function getDailyRunLogs() {
  const stored = await chrome.storage.local.get(DAILY_RUN_LOGS_KEY);
  return Array.isArray(stored[DAILY_RUN_LOGS_KEY]) ? stored[DAILY_RUN_LOGS_KEY] : [];
}

function dailyLogCutoffDate(nowMs = Date.now()) {
  return adjustedDateParts(nowMs - DAILY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).date;
}

function pruneDailyLogEntries(logs, cutoffDate) {
  return (Array.isArray(logs) ? logs : [])
    .filter((entry) => !entry?.date || entry.date >= cutoffDate)
    .sort((left, right) => String(right?.date || "").localeCompare(String(left?.date || "")))
    .slice(0, DAILY_LOG_DISPLAY_LIMIT);
}

async function deleteDailyRunLog(rawDate) {
  const date = String(rawDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "Geçersiz günlük log tarihi." };
  }

  const config = await getWatchdogConfig();
  const today = adjustedDateParts(Date.now()).date;
  const state = await getState("web-app-sync");
  if (state.running) {
    return { ok: false, error: "Sync çalışırken günlük kayıt silinemez." };
  }

  const cutoffDate = dailyLogCutoffDate(Date.now());
  try {
    const response = await sendLogWriterMessage({
      type: "delete",
      date,
      cutoffDate,
      maxEntries: DAILY_LOG_DISPLAY_LIMIT
    });
    if (!response?.ok) throw new Error(response?.error || "Günlük log silinemedi.");
  } catch (error) {
    console.warn("[DailyLog] Native logs.json silinemedi; Chrome storage kaydı silinecek.", error);
  }

  const remainingLogs = pruneDailyLogEntries(
    (await getDailyRunLogs()).filter((entry) => entry?.date !== date),
    cutoffDate
  );
  await chrome.storage.local.set({ [DAILY_RUN_LOGS_KEY]: remainingLogs });

  if (date !== today || isFinishedState(state)) {
    return { ok: true, deletedDate: date, started: false, logs: remainingLogs };
  }

  await chrome.storage.local.remove([WEB_APP_RARITY_PHASE_KEY, WEB_APP_FLOW_STATE_KEY]);
  await appendWebAppSyncLog({
    step: "WATCHDOG",
    message: `${date} başarı kaydı kullanıcı tarafından silindi. Sync en baştan başlatılıyor.`,
    details: { date, source: "popup-delete" }
  }, {});
  const started = await startFreshSync(
    DEFAULT_API_BASE_URL,
    5000,
    ["web-app-sync"],
    (state.runCount || 0) + 1,
    "web-app-sync",
    true,
    date
  );
  return { ok: true, deletedDate: date, started: true, logs: remainingLogs, state: started.state };
}

async function dailyJsonLogHasDate(date, cutoffDate) {
  if (!date) return false;
  try {
    const response = await sendLogWriterMessage({ type: "hasDate", date, cutoffDate });
    return response?.ok === true && response.exists === true;
  } catch (error) {
    console.warn(`[DailyLog] ${date} logs.json kaydı kontrol edilemedi`, error);
    return false;
  }
}

async function readDailyJsonLogs(cutoffDate) {
  try {
    const response = await sendLogWriterMessage({ type: "read", cutoffDate });
    if (response?.ok && Array.isArray(response.logs)) return response.logs;
  } catch (error) {
    console.warn("[DailyLog] Native host yok; Chrome storage günlük kayıtları kullanılacak.", error);
  }
  return null;
}

async function getVerifiedDailyRunLogs() {
  const config = await getWatchdogConfig();
  const cutoffDate = dailyLogCutoffDate(Date.now());
  const storedLogs = pruneDailyLogEntries(await getDailyRunLogs(), cutoffDate);
  const rawJsonLogs = await readDailyJsonLogs(cutoffDate);

  // Native Messaging isteğe bağlıdır. Host kurulu değilse storage kaydı günlük
  // completed kilidinin tek kaynağıdır; kayıtları silip sync'i tekrar başlatma.
  if (!Array.isArray(rawJsonLogs)) return storedLogs;

  const jsonLogs = pruneDailyLogEntries(rawJsonLogs, cutoffDate);
  const mergedByDate = new Map();
  for (const entry of [...jsonLogs, ...storedLogs]) {
    if (entry?.date && entry?.status === "success") mergedByDate.set(entry.date, entry);
  }
  const verifiedLogs = pruneDailyLogEntries([...mergedByDate.values()], cutoffDate);

  if (JSON.stringify(storedLogs) !== JSON.stringify(verifiedLogs)) {
    await chrome.storage.local.set({ [DAILY_RUN_LOGS_KEY]: verifiedLogs });
  }

  return verifiedLogs;
}

async function appendDailySuccessLog(state, snapshot) {
  const config = await getWatchdogConfig();
  const adjusted = adjustedDateParts(Date.now());
  const rarity = snapshot.raritySync || {};
  const sbc = snapshot.sbcSync || {};
  const decision = snapshot.flowDecision || {};
  const logDate = state.dailyLogDate || adjusted.date;
  const entry = {
    date: logDate,
    status: "success",
    startedAt: state.runStartedAt || null,
    completedAt: Date.now(),
    completedAtLocal: `${adjusted.date} ${adjusted.time}`,
    targetTime: config.targetTime,
    environment: "production",
    languages: decision.turkishRequired ? ["en", "tr"] : ["en"],
    flow: {
      englishCompleted: true,
      turkishCompleted: Boolean(decision.turkishRequired),
      turkishSkipped: !decision.turkishRequired,
      turkishRaritySkipped: !decision.turkishRarityRequired
    },
    phases: {
      en: {
        rarityNew: Number(rarity.phases?.en?.savedCount) || 0,
        sbcNew: Number(sbc.phases?.en?.insertedCount) || 0
      },
      tr: {
        rarityNew: Number(rarity.phases?.tr?.savedCount) || 0,
        sbcNew: Number(sbc.phases?.tr?.insertedCount) || 0
      }
    },
    rarity: { scanned: Number(rarity.optionCount) || 0, saved: Number(rarity.savedCount) || 0, skipped: (Number(rarity.skippedExisting) || 0) + (Number(rarity.skippedPlaceholder) || 0) },
    sbc: { categories: Number(sbc.categoryCount) || 0, tiles: Number(sbc.tileCount) || 0, saved: Number(sbc.savedCount) || 0, inserted: Number(sbc.insertedCount) || 0, updated: Number(sbc.updatedCount) || 0, deleted: Number(sbc.deletedCount) || 0 }
  };
  const cutoffDate = dailyLogCutoffDate(Date.now());
  const logs = pruneDailyLogEntries((await getVerifiedDailyRunLogs()).filter((item) => item.date !== logDate), cutoffDate);
  // Önce completed kilidini storage'a yaz. Native host bulunmaması başarılı
  // senkronizasyonu başarısız hale getirmemeli.
  await chrome.storage.local.set({
    [DAILY_RUN_LOGS_KEY]: pruneDailyLogEntries([entry, ...logs], cutoffDate)
  });
  entry.jsonLog = await appendJsonLog(entry, config);
  return entry;
}

async function appendJsonLog(entry, config) {
  try {
    const response = await sendLogWriterMessage({
      type: "append",
      entry,
      cutoffDate: dailyLogCutoffDate(Date.now()),
      maxEntries: DAILY_LOG_DISPLAY_LIMIT
    });
    if (!response?.ok) throw new Error(response?.error || "Native log writer başarısız döndü");
    return { filename: DAILY_JSON_LOG_FILE, absolutePath: response.path || null, retainedCount: response.retainedCount || 0 };
  } catch (error) {
    console.warn("[DailyLog] logs.json güncellenemedi; başarı kaydı Chrome storage'da tutuluyor.", error);
    return { filename: DAILY_JSON_LOG_FILE, available: false, error: error.message || String(error) };
  }
}

async function sendLogWriterMessage(payload) {
  if (!chrome.runtime?.sendNativeMessage) {
    throw new Error("nativeMessaging izni veya API bulunamadı.");
  }
  const response = await chrome.runtime.sendNativeMessage(LOG_WRITER_NATIVE_HOST, payload);
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  return response;
}

async function appendWebAppSchedulerLog(message, details = null) {
  const payload = { step: "SCHEDULER", message: `[WEBAPP] ${message}`, details };
  console.info(payload.message, details || {});
  try {
    await appendWebAppSyncLog(payload, {});
  } catch (error) {
    console.warn("[WEBAPP] Scheduler log yazılamadı", error);
  }
}

async function notifyNewSbcsArrivedAfterWebAppSync(state) {
  const runStartedAt = Number(state?.runStartedAt) || 0;
  if (!runStartedAt) {
    const details = { reason: "runStartedAt not found" };
    await appendWebAppSchedulerLog("Telegram notification skipped", details);
    await appendTelegramNotifyLog("skipped", "Telegram notify request atlandı", details);
    return null;
  }

  const syncStartedAt = new Date(runStartedAt).toISOString();
  const apiBaseUrl = await resolveApiBaseUrl(state.apiBaseUrl);
  const request = {
    method: "POST",
    endpoint: NEW_SBC_TELEGRAM_ENDPOINT,
    url: new URL(NEW_SBC_TELEGRAM_ENDPOINT, apiBaseUrl).href,
    body: { sync_started_at: syncStartedAt }
  };
  await appendTelegramNotifyLog("request", "Telegram notify request gönderiliyor", request);

  try {
    const response = await apiRequest(apiBaseUrl, NEW_SBC_TELEGRAM_ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ sync_started_at: syncStartedAt })
    });
    const details = {
      syncStartedAt,
      sent: response?.sent === true,
      count: Number(response?.count) || 0,
      status: response?.status || null,
      items: Array.isArray(response?.items) ? response.items : [],
      turkishChannel: response?.turkishChannel || null,
      englishChannel: response?.englishChannel || null,
      response
    };
    await appendWebAppSchedulerLog("Telegram notification completed", details);
    await appendTelegramNotifyLog("response", "Telegram notify response alındı", details);
    return response;
  } catch (error) {
    const details = {
      syncStartedAt,
      request,
      message: error.message || String(error),
      stack: error.stack || null
    };
    await appendWebAppSchedulerLog("Telegram notification failed", details);
    await appendTelegramNotifyLog("error", "Telegram notify request başarısız", details);
    return null;
  }
}

async function appendTelegramNotifyLog(status, message, details) {
  await appendWebAppSyncLog({
    step: "TELEGRAM_NOTIFY",
    message,
    details: {
      status,
      ...details
    }
  }, {});
}

async function ensureWebAppDailySchedule() {
  if (EXTENSION_RUNNER_ID !== "web-app-sync") return null;
  const env = await getEnv();
  const config = buildWebAppDailyScheduleConfig(env);
  await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
  if (!config) return null;

  const state = await getState("web-app-sync");
  if (isFinishedState(state)) return state;
  if (state.running) return state;
  if (Number(state.nextRunAt) && state.nextRunAt <= Date.now()) {
    return runScheduledWebAppSync(state);
  }

  const nextRunAt = state.scheduleTime === config.timeText && Number(state.nextRunAt) > Date.now()
    ? state.nextRunAt
    : config.nextRunAt;
  const scheduled = {
    ...state,
    runnerId: "web-app-sync",
    running: false,
    userStarted: false,
    queue: [],
    currentJobIndex: -1,
    currentPage: 0,
    totalPages: 0,
    currentUrl: null,
    tabId: null,
    apiBaseUrl: config.apiBaseUrl,
    waitMs: config.waitMs,
    operations: ["web-app-sync"],
    nextRunAt,
    scheduleTime: config.timeText,
    clockAdjustmentHours: config.clockAdjustmentHours,
    detectedTimeZone: config.detectedTimeZone,
    status: `Günlük Web App Sync ${config.timeText} için bekliyor`,
    updatedAt: Date.now()
  };
  await setState(scheduled);
  await chrome.alarms.create(WEB_APP_DAILY_ALARM, { when: nextRunAt });
  await appendWebAppSchedulerLog("Countdown started", {
    nextRunAt,
    scheduleTime: config.timeText,
    source: "ensure-daily-schedule"
  });
  return scheduled;
}

async function scheduleNextWebAppDailyRun(baseState = null) {
  if (EXTENSION_RUNNER_ID !== "web-app-sync") return baseState;
  const env = await getEnv();
  const config = buildWebAppDailyScheduleConfig(env);
  await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
  if (!config) return baseState;

  const state = baseState || await getState("web-app-sync");
  if (isFinishedState(state)) return state;
  if (state.running) return state;
  const scheduled = {
    ...state,
    runnerId: "web-app-sync",
    running: false,
    userStarted: false,
    queue: [],
    currentJobIndex: -1,
    currentPage: 0,
    totalPages: 0,
    currentUrl: null,
    tabId: null,
    apiBaseUrl: config.apiBaseUrl,
    waitMs: config.waitMs,
    operations: ["web-app-sync"],
    nextRunAt: config.nextRunAt,
    scheduleTime: config.timeText,
    clockAdjustmentHours: config.clockAdjustmentHours,
    detectedTimeZone: config.detectedTimeZone,
    status: `Günlük Web App Sync ${config.timeText} için bekliyor`,
    updatedAt: Date.now()
  };
  await setState(scheduled);
  await chrome.alarms.create(WEB_APP_DAILY_ALARM, { when: config.nextRunAt });
  await appendWebAppSchedulerLog("Countdown started", {
    nextRunAt: config.nextRunAt,
    scheduleTime: config.timeText,
    source: "schedule-next-daily-run"
  });
  return scheduled;
}

async function runScheduledWebAppSync(existingState = null) {
  const state = existingState || await getState("web-app-sync");
  if (isFinishedState(state)) return { ok: false, state, finished: true };
  const watchdogConfig = await getWatchdogConfig();
  const today = adjustedDateParts(Date.now()).date;
  const logs = await getVerifiedDailyRunLogs();
  if (logs.some((entry) => entry?.date === today && entry?.status === "success")) {
    return checkWebAppDailyRun(Date.now(), watchdogConfig);
  }
  const env = await getEnv();
  if (state.running) return { ok: true, state, alreadyRunning: true };
  const apiBaseUrl = normalizeApiBaseUrl(DEFAULT_API_BASE_URL);
  const waitMs = Math.min(30000, Math.max(5000, Number(env.WAIT_MS || state.waitMs) || emptyState.waitMs));
  await appendWebAppSchedulerLog("Synchronization started", {
    source: "daily-alarm",
    date: today,
    runCount: (state.runCount || 0) + 1
  });
  return startFreshSync(apiBaseUrl, waitMs, ["web-app-sync"], (state.runCount || 0) + 1, "web-app-sync", true);
}

function buildWebAppDailyScheduleConfig(env = {}) {
  const parsed = parseDailyTime(env.WEB_APP_SYNC_TIME || env.WEB_APP_SYNC_AT || env.WEB_APP_SYNC_DAILY_TIME);
  if (!parsed) return null;
  return {
    timeText: parsed.text,
    nextRunAt: nextDailyRunAt(parsed.hour, parsed.minute, Date.now()),
    clockAdjustmentHours: 0,
    detectedTimeZone: runtimeTimeZone(),
    apiBaseUrl: normalizeApiBaseUrl(DEFAULT_API_BASE_URL),
    waitMs: Math.min(30000, Math.max(5000, Number(env.WAIT_MS) || emptyState.waitMs))
  };
}

function parseDailyTime(value) {
  const match = String(value || "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function nextDailyRunAt(hour, minute, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const next = new Date(now.getTime());
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return nowMs + (next.getTime() - now.getTime());
}

async function activateRunnerTab(tabId) {
  if (!tabId) return;
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
}

async function closeRunnerTab(tabId, stateHint = null) {
  if (!tabId) return;
  const state = stateHint?.runnerId ? stateHint : await getStateByTabId(tabId);
  if (state?.runnerId) await appendWebAppBackgroundLog(state, "TAB", "Sekme kapatılıyor", { tabId });
  try { await chrome.tabs.remove(tabId); } catch { /* Sekme zaten kapanmış olabilir. */ }
  if (state?.runnerId) await appendWebAppBackgroundLog(state, "TAB", "Sekme kapatıldı", { tabId });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WEB_APP_WATCHDOG_ALARM) {
    const state = await getState("web-app-sync");
    if (isFinishedState(state)) return;
    await ensureWebAppWatchdog();
    return;
  }
  if (alarm.name === WEB_APP_DAILY_ALARM) {
    const state = await getState("web-app-sync");
    if (isFinishedState(state)) return;
    await appendWebAppSchedulerLog("Countdown finished", {
      alarmName: alarm.name,
      nextRunAt: state.nextRunAt || null,
      running: Boolean(state.running)
    });
    if (state.running) {
      await appendWebAppSchedulerLog("Countdown finished while sync is already running; keeping current run active", {
        runStartedAt: state.runStartedAt || null,
        tabId: state.tabId || null
      });
      return;
    }
    await runScheduledWebAppSync(state);
    return;
  }
  const loopRunnerId = runnerIdFromAlarmName(alarm.name, SYNC_LOOP_ALARM);
  if (loopRunnerId) {
    const state = await getState(loopRunnerId);
    if (isFinishedState(state) || !isLoopRestartDue(state)) return;
    await startFreshSync(state.apiBaseUrl, state.waitMs, state.operations, (state.runCount || 0) + 1, loopRunnerId, true);
    return;
  }
  const timeoutRunnerId = runnerIdFromAlarmName(alarm.name, PAGE_TIMEOUT_ALARM);
  if (!timeoutRunnerId) return;
  const state = await getState(timeoutRunnerId);
  if (!state.running || isFinishedState(state)) return;
  await handlePageFailure(`Sayfa zaman aşımına uğradı: ${state.currentUrl}`, state);
});

async function handlePageResult(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!isCurrentPageSender(state, message, sender)) return { ok: false, error: "Eski sayfa sonucu yok sayıldı." };

  const job = currentJob(state);
  if (job.operation === "web-app-sync") return handleWebAppSyncResult(message, state, job);
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
        assertCompleteCoinCardPrices(card);
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

async function handleWebAppSyncResult(message, state, job) {
  const snapshot = normalizeWebAppSnapshot(message.webAppSync);
  const pagesAttempted = state.pagesAttempted + 1;
  const pagesSucceeded = state.pagesSucceeded + 1;
  await appendWebAppRecord(snapshot, state.currentUrl, job, "read", state);

  await setState({
    ...state,
    currentPlayers: { "web-app-sync": snapshot },
    pagesAttempted,
    pagesSucceeded,
    status: "EA Web App: API'ye kaydediliyor",
    updatedAt: Date.now()
  });

  const endpoint = job.endpoint || WEB_APP_SYNC_ENDPOINT;
  const response = await apiRequest(await resolveApiBaseUrl(state.apiBaseUrl), endpoint, {
    method: "POST",
    body: JSON.stringify(toApiWebAppSnapshot(snapshot))
  });
  if (!await isActiveRun(state)) return { ok: false, error: "Eski API yanıtı yok sayıldı." };
  const saved = Number(response?.data?.saved) || 1;
  const skipped = Number(response?.data?.skipped) || 0;
  const responseErrors = Array.isArray(response?.data?.errors) ? response.data.errors : [];
  if (responseErrors.length) {
    await appendErrors(responseErrors.map((message) => buildErrorEntry({
      state,
      job,
      stage: "web-app-after-post",
      message
    })));
  }

  await appendWebAppRecord(snapshot, state.currentUrl, job, "posted", state);
  const clubSaveResults = {
    ...(state.clubSaveResults || {}),
    "web-app-sync": {
      saved,
      skipped,
      inserted: Number(response?.data?.inserted) || 0,
      updated: Number(response?.data?.updated) || 0,
      deleted: Number(response?.data?.deleted) || 0,
      posted: snapshot.locales.length,
      savedAt: Date.now()
    }
  };
  const completed = {
    ...state,
    running: false,
    userStarted: false,
    currentPlayers: { "web-app-sync": snapshot },
    pagesAttempted,
    pagesSucceeded,
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + saved,
    skippedPlayers: state.skippedPlayers + skipped,
    clubSaveResults,
    nextRunAt: null,
    status: "Tamamlandı: EA Web App Sync",
    updatedAt: Date.now()
  };
  await setState(completed);
  return { ok: true, state: completed };
}

async function handleWebAppSyncComplete(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!isCurrentPageSender(state, message, sender)) {
    return { ok: false, error: "Eski Web App tamamlanma mesajı yok sayıldı." };
  }

  const job = currentJob(state);
  const snapshot = normalizeWebAppSnapshot(message.webAppSync);
  const decision = snapshot.flowDecision || {};
  const hasRequiredPhases = Boolean(
    snapshot.raritySync?.phases?.en && snapshot.sbcSync?.phases?.en &&
    (!decision.turkishRequired || snapshot.sbcSync?.phases?.tr) &&
    (!decision.turkishRarityRequired || snapshot.raritySync?.phases?.tr)
  );
  const aborted = snapshot.sbcSync?.aborted === true;
  if (!hasRequiredPhases || aborted) {
    const reason = !hasRequiredPhases
      ? "Algoritmanın zorunlu rarity/SBC fazlarının tamamı bitmedi."
      : (snapshot.sbcSync?.errorMessage || "SBC sync kritik hata ile durdu.");
    await failSync(`Günlük başarı kaydı oluşturulmadı: ${reason}`, state);
    return { ok: false, error: reason };
  }
  const failedCount = Number(snapshot.sbcSync?.failedCount) || 0;
  if (failedCount > 0) {
    await appendWebAppSyncLog({
      step: "SBC_WARN",
      message: "Bazı SBC tile requestleri hata verdi; sync kalan işlemlerle tamamlandı.",
      details: {
        failedCount,
        errorMessage: snapshot.sbcSync?.errorMessage || null
      }
    }, sender);
  }
  const saved = (Number(snapshot.raritySync?.savedCount) || 0) +
    (Number(snapshot.sbcSync?.savedCount) || 0);
  const skipped = (Number(snapshot.raritySync?.skippedExisting) || 0) +
    (Number(snapshot.raritySync?.skippedPlaceholder) || 0) +
    (Number(snapshot.sbcSync?.skippedCount) || 0);
  await chrome.alarms.clear(pageTimeoutAlarmName(state));
  await appendWebAppRecord(snapshot, state.currentUrl, job, "loaded", state);

  const completed = {
    ...state,
    running: false,
    queue: [],
    currentJobIndex: -1,
    currentPage: 0,
    totalPages: 0,
    currentUrl: null,
    tabId: null,
    currentPlayers: { "web-app-sync": snapshot },
    pagesAttempted: state.pagesAttempted + 1,
    pagesSucceeded: state.pagesSucceeded + 1,
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + saved,
    skippedPlayers: state.skippedPlayers + skipped,
    clubSaveResults: {
      ...(state.clubSaveResults || {}),
      "web-app-sync": {
        saved,
        skipped,
        inserted: saved,
        updated: 0,
        deleted: 0,
        posted: saved,
        loadedAt: Date.now()
      }
    },
    nextRunAt: null,
    status: `Tamamlandı: ${saved} Web App kaydı senkronize edildi`,
    updatedAt: Date.now()
  };
  if (!await isActiveRun(state)) return { ok: false, error: "Eski tamamlanma mesajı yok sayıldı." };
  await appendDailySuccessLog(completed, snapshot);
  if (!await isActiveRun(state)) return { ok: false, error: "Durdurulan çalışma tamamlanmadı." };
  await appendWebAppSyncLog({
    step: "PROGRESS",
    message: "Çalışma başarıyla tamamlandı",
    details: { progress: { stepId: 9, status: "completed", title: "Sekme kapatıldı ve final log yazıldı", detail: `${completed.dailyLogDate || adjustedDateParts().date} başarı kaydı` } }
  }, sender);
  await notifyNewSbcsArrivedAfterWebAppSync(completed);
  if (!await isActiveRun(state)) return { ok: false, error: "Durdurulan çalışma tamamlanmadı." };
  await setState(completed);
  await closeRunnerTab(state.tabId, state);
  const watchdogConfig = await getWatchdogConfig();
  const adjusted = adjustedDateParts(Date.now());
  const completedLogDate = completed.dailyLogDate || adjusted.date;
  const waiting = { ...completed, status: `${completedLogDate} başarıyla tamamlandı; sonraki ${watchdogConfig.targetTime} bekleniyor`, nextRunAt: nextAdjustedStart(Date.now(), watchdogConfig), scheduleTime: watchdogConfig.targetTime, clockAdjustmentHours: watchdogConfig.clockAdjustmentHours, detectedTimeZone: watchdogConfig.detectedTimeZone, checkIntervalMinutes: watchdogConfig.checkIntervalMinutes, updatedAt: Date.now() };
  await setState(waiting);
  await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
  await chrome.alarms.create(WEB_APP_DAILY_ALARM, { when: waiting.nextRunAt });
  await chrome.alarms.create(WEB_APP_WATCHDOG_ALARM, { periodInMinutes: watchdogConfig.checkIntervalMinutes });
  await appendWebAppSchedulerLog("Sync completed", {
    completedLogDate,
    nextRunAt: waiting.nextRunAt,
    scheduleTime: watchdogConfig.targetTime
  });
  await appendWebAppSchedulerLog("Countdown started", {
    nextRunAt: waiting.nextRunAt,
    scheduleTime: watchdogConfig.targetTime,
    source: "sync-complete"
  });
  const startSbcPlayersBatch = globalThis.FutbinSyncModuleControls?.sbcPlayers?.startWebAppBatch;
  const batchStartPromise = typeof startSbcPlayersBatch === "function"
    ? startSbcPlayersBatch()
    : Promise.reject(new Error("SBC Players kontrol modülü yüklenmedi."));
  batchStartPromise.then(async (response) => {
    await appendWebAppSchedulerLog(
      response?.ok ? "SBC Players batch started" : "SBC Players batch could not start",
      {
        maxRuns: 5,
        intervalMinutes: 10,
        error: response?.ok ? null : response?.error || "Bilinmeyen hata"
      }
    );
  }).catch(async (error) => {
    await appendWebAppSchedulerLog("SBC Players batch could not start", {
      maxRuns: 5,
      intervalMinutes: 10,
      error: error.message || String(error)
    });
  });
  return { ok: true, state: waiting };
}

async function handleCriticalPageError(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!isCurrentPageSender(state, message, sender)) return { ok: false };
  await failSync(message.error || "[CRITICAL] Futbin sayfası doğrulanamadı.", state);
  return { ok: false, critical: true };
}

async function handleReportedPageFailure(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!isCurrentPageSender(state, message, sender)) return { ok: false, error: "Eski sayfa hatası yok sayıldı." };
  return recordPageFailure(state, message.error || `Sayfa yüklenemedi: ${message.pageUrl}`);
}

async function handlePageFailure(error, currentState = null) {
  const state = currentState || await getState();
  if (!state.running) return;
  const action = await recordPageFailure(state, error);
  if (action?.nextUrl) await performAdvance(action.nextUrl, state.runnerId);
}

async function recordPageFailure(state, error) {
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
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: futbinRequestDelayMs(state) };
}

async function submitLatestCoinCardsAndPrepareDetails(state) {
  const job = currentJob(state);
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = state.currentSkipped || 0;
  let jobsBeforeInsert = [];

  if (state.currentLatest) {
    const jobsBeforeResponse = await apiRequest(state.apiBaseUrl, "futbin-sync/coin-card-jobs");
    jobsBeforeInsert = Array.isArray(jobsBeforeResponse?.data?.jobs) ? jobsBeforeResponse.data.jobs : [];
    await setState({
      ...state,
      nextRunAt: null,
      status: "Latest Coin Cards: API'ye kaydediliyor",
      updatedAt: Date.now()
    });
    const response = await apiRequest(state.apiBaseUrl, "futbin-sync/coin-card-latest", {
      method: "POST",
      body: JSON.stringify({
        source_date: state.currentLatest.sourceDate,
        cards: (state.currentLatest.cards || []).map(toApiLatestCoinCard)
      })
    });
    inserted = Number(response?.data?.inserted) || 0;
    updated = Number(response?.data?.updated) || 0;
    deleted = Number(response?.data?.deleted) || 0;
    skipped += Number(response?.data?.skipped) || 0;
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

  const jobsResponse = await apiRequest(state.apiBaseUrl, "futbin-sync/coin-card-jobs");
  const detailJobs = (Array.isArray(jobsResponse?.data?.jobs) ? jobsResponse.data.jobs : [])
    .map((detailJob) => ({ ...detailJob, operation: "coin-cards" }));
  const previousJobIds = new Set(jobsBeforeInsert.map((detailJob) => Number(detailJob.id)));
  const submittedLatestUrls = new Set((state.currentLatest?.cards || []).map((card) => coinCardUrlKey(card?.url)).filter(Boolean));
  const addedJobs = detailJobs
    .filter((detailJob) => Number.isInteger(Number(detailJob.id)) && !previousJobIds.has(Number(detailJob.id)));
  const matchingInsertedJobs = addedJobs
    .filter((detailJob) => submittedLatestUrls.has(coinCardUrlKey(detailJob.url)));
  const newlyInsertedJobs = inserted > 0
    ? (matchingInsertedJobs.length >= inserted ? matchingInsertedJobs : addedJobs).slice(-inserted)
    : [];
  const newlyInsertedCoinCardIds = newlyInsertedJobs.map((detailJob) => Number(detailJob.id));
  const latestCardsByUrl = new Map((state.currentLatest?.cards || [])
    .map((card) => [coinCardUrlKey(card?.url), card])
    .filter(([url]) => Boolean(url)));
  for (const detailJob of newlyInsertedJobs) {
    const latestCard = latestCardsByUrl.get(coinCardUrlKey(detailJob.url)) ||
      (state.currentLatest?.cards || []).find((card) => sameLookupText(card?.playerName, detailJob.label));
    if (!latestCard) continue;
    await appendRecords(
      [toCoinCardDisplayPlayer(latestCard, detailJob)],
      detailJob.url,
      detailJob,
      "inserted",
      state
    );
  }
  const updateJobs = detailJobs.filter((detailJob) => !newlyInsertedCoinCardIds.includes(Number(detailJob.id)));
  const queue = [
    ...state.queue.slice(0, state.currentJobIndex + 1),
    ...updateJobs,
    ...state.queue.slice(state.currentJobIndex + 1)
  ];
  const clubSaveResults = {
    ...(state.clubSaveResults || {}),
    "coin-card:latest": {
      saved: inserted,
      skipped,
      inserted,
      updated,
      deleted,
      posted: state.currentLatest?.cards?.length || 0,
      savedAt: Date.now()
    }
  };
  const nextJobIndex = state.currentJobIndex + 1;

  if (nextJobIndex >= queue.length) {
    return scheduleNextLoop(state, inserted + updated, skipped, clubSaveResults, queue);
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
    newlyInsertedCoinCardIds,
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
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: futbinRequestDelayMs(state) };
}

async function submitCurrentCoinCardAndPrepareNext(state) {
  const job = currentJob(state);
  const card = state.currentPlayers?.[String(job.id)];
  const isNewlyInserted = (state.newlyInsertedCoinCardIds || []).some((id) => Number(id) === Number(job.id));
  let saved = 0;
  let skipped = state.currentSkipped || 0;
  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  if (card) {
    await setState({
      ...state,
      nextRunAt: null,
      status: `${job.label || "Coin Cards"}: API'ye kaydediliyor`,
      updatedAt: Date.now()
    });
    const response = await apiRequest(state.apiBaseUrl, `futbin-sync/coin-card-jobs/${job.id}`, {
      method: "POST",
      body: JSON.stringify(toApiCoinCard(card))
    });
    saved = Number(response?.data?.saved) || 0;
    skipped += Number(response?.data?.skipped) || 0;
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
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: futbinRequestDelayMs(state) };
}

async function advanceFromContentTimer(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  if (!state.running || sender.tab?.id !== state.tabId || message.url !== state.currentUrl) return { ok: false };
  await performAdvance(message.url, state.runnerId);
  return { ok: true };
}

async function performAdvance(url, runnerId = null) {
  const state = await getState(runnerId);
  if (!state.running || isFinishedState(state) || url !== state.currentUrl) return;
  const opening = { ...state, nextRunAt: null, status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, "Sayfa açılıyor"), updatedAt: Date.now() };
  await setState(opening);
  await navigateToCurrentPage(opening);
}

async function navigateToCurrentPage(state) {
  if (!await isActiveRun(state)) return;
  await appendWebAppBackgroundLog(state, "TAB", "Sekme navigasyonu başlatıldı", {
    tabId: state.tabId || null,
    url: state.currentUrl
  });
  await appendPageLog(state);
  if (!await isActiveRun(state)) return;
  const env = await getEnv();
  const timeoutMs = currentJob(state).operation === "web-app-sync" ? 10 * 60 * 1000 : (Number(env.PAGE_TIMEOUT_MS) || 120000);
  await chrome.alarms.create(pageTimeoutAlarmName(state), { when: Date.now() + timeoutMs });
  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (matchesCurrentPage(tab.url, state)) {
      await appendWebAppBackgroundLog(state, "TAB", "Sekme hedef URL'de; işlem başlatılıyor", {
        tabId: state.tabId,
        url: tab.url
      });
      if (currentJob(state).operation === "web-app-sync") {
        await activateRunnerTab(state.tabId);
        try {
          await dispatchWebAppCollection(state);
        } catch (error) {
          await chrome.alarms.clear(pageTimeoutAlarmName(state));
          await failSync(`İçerik script'i çalışmadı: ${error.message || state.currentUrl}`, state);
        }
        return;
      }
      await chrome.tabs.reload(state.tabId);
    } else {
      await chrome.tabs.update(state.tabId, {
        url: state.currentUrl,
        active: currentJob(state).operation === "web-app-sync"
      });
      await appendWebAppBackgroundLog(state, "TAB", "Sekmeye hedef URL gönderildi", {
        tabId: state.tabId,
        url: state.currentUrl
      });
      if (currentJob(state).operation === "web-app-sync") await activateRunnerTab(state.tabId);
    }
  } catch {
    await chrome.alarms.clear(pageTimeoutAlarmName(state));
    await failSync("Çalışma sekmesine erişilemedi", state);
  }
}

async function appendPageLog(state) {
  if (!state.currentUrl) return;
  await enqueueStorageWrite(async () => {
    const job = currentJob(state);
    const stored = await chrome.storage.local.get(LOGS_KEY);
    const logs = stored[LOGS_KEY] || [];
    const entry = {
      id: crypto.randomUUID(),
      requestedAt: Date.now(),
      url: state.currentUrl,
      page: state.currentPage,
      runnerId: state.runnerId || null,
      runCount: state.runCount || 0,
      runStartedAt: state.runStartedAt || null,
      clubId: job.club_id,
      clubName: logClubName(job),
      leagueName: logLeagueName(job)
    };
    await chrome.storage.local.set({ [LOGS_KEY]: [entry, ...logs].slice(0, MAX_LOGS) });
  });
}

async function appendWebAppSyncLog(message, sender) {
  const state = await getStateByTabId(sender.tab?.id);
  const runnerState = state?.runnerId === "web-app-sync" ? state : await getState("web-app-sync");
  if (isFinishedState(runnerState) && !runnerState?.error) return { ok: false, error: "Finish sonrası log yok sayıldı." };
  if (sender.tab?.id && (!runnerState.running || runnerState.tabId !== sender.tab.id) && !runnerState?.error) {
    return { ok: false, error: "Eski Web App logu yok sayıldı." };
  }
  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get(LOGS_KEY);
    const logs = stored[LOGS_KEY] || [];
    const entry = {
      id: crypto.randomUUID(),
      requestedAt: Number(message.requestedAt) || Date.now(),
      url: message.pageUrl || sender.tab?.url || runnerState?.currentUrl || WEB_APP_URL,
      page: runnerState?.currentPage || 1,
      runnerId: "web-app-sync",
      runCount: runnerState?.runCount || 0,
      runStartedAt: runnerState?.runStartedAt || null,
      leagueName: "Web App Sync",
      clubName: message.step || "FLOW",
      logType: "web-app-detail",
      sequence: Number(message.sequence) || 0,
      step: normalizeText(message.step) || "FLOW",
      message: normalizeText(message.message) || "Web App Sync log",
      details: message.details ?? null
    };
    await chrome.storage.local.set({ [LOGS_KEY]: [entry, ...logs].slice(0, MAX_LOGS) });
  });
  return { ok: true };
}

async function appendWebAppBackgroundLog(state, step, message, details = null) {
  if (!state?.runnerId) return;
  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get(LOGS_KEY);
    const logs = stored[LOGS_KEY] || [];
    const entry = {
      id: crypto.randomUUID(),
      requestedAt: Date.now(),
      url: details?.url || state.currentUrl || WEB_APP_URL,
      page: state.currentPage || 1,
      runnerId: state.runnerId,
      runCount: state.runCount || 0,
      runStartedAt: state.runStartedAt || null,
      leagueName: state.runnerId === "web-app-sync" ? "Web App Sync" : "Futbin",
      clubName: step,
      logType: "background-tab",
      sequence: 0,
      step,
      message,
      details
    };
    await chrome.storage.local.set({ [LOGS_KEY]: [entry, ...logs].slice(0, MAX_LOGS) });
  });
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
    const stored = await chrome.storage.local.get(ERRORS_KEY);
    const errors = stored[ERRORS_KEY] || [];
    await chrome.storage.local.set({ [ERRORS_KEY]: [...normalized, ...errors].slice(0, MAX_ERRORS) });
  });
}

async function failSync(error, currentState = null) {
  const token = runToken;
  const state = currentState || await getState();
  const liveState = await getState(state.runnerId);
  if (isFinishedState(liveState) || !sameRun(state, liveState)) return;
  await chrome.alarms.clear(pageTimeoutAlarmName(state));
  const isWebAppRun = state.runnerId === "web-app-sync";
  const failed = {
    ...state,
    running: false,
    tabId: state.tabId,
    nextRunAt: null,
    status: error,
    error,
    updatedAt: Date.now()
  };
  await setState(failed);
  if (isWebAppRun) {
    await appendErrors(buildErrorEntry({
      state,
      job: currentJob(state),
      stage: "web-app-sync",
      message: error,
      player: null
    }));
    await appendWebAppSyncLog({
      step: "PROGRESS",
      message: "Sync hata ile durdu",
      details: { progress: { stepId: 9, status: "failed", title: "Çalışma hata ile durdu; Web App sekmesi açık bırakıldı", detail: error } }
    }, {});
    const watchdogConfig = await getWatchdogConfig();
    if (token !== runToken || isFinishedState(await getState("web-app-sync"))) return;
    const waitingFailed = {
      ...failed,
      nextRunAt: nextAdjustedStart(Date.now(), watchdogConfig),
      scheduleTime: watchdogConfig.targetTime,
      clockAdjustmentHours: watchdogConfig.clockAdjustmentHours,
      detectedTimeZone: watchdogConfig.detectedTimeZone,
      checkIntervalMinutes: watchdogConfig.checkIntervalMinutes,
      status: `${error}; sonraki ${watchdogConfig.targetTime} bekleniyor`,
      updatedAt: Date.now()
    };
    await setState(waitingFailed);
    await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
    await chrome.alarms.create(WEB_APP_DAILY_ALARM, { when: waitingFailed.nextRunAt });
    await chrome.alarms.create(WEB_APP_WATCHDOG_ALARM, { periodInMinutes: watchdogConfig.checkIntervalMinutes });
    await appendWebAppSchedulerLog("Countdown started", {
      nextRunAt: waitingFailed.nextRunAt,
      scheduleTime: watchdogConfig.targetTime,
      source: "sync-failed",
      error
    });
    if (token !== runToken || isFinishedState(await getState("web-app-sync"))) {
      await chrome.alarms.clear(WEB_APP_WATCHDOG_ALARM);
    }
  }
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

async function resolveApiBaseUrl(preferred = "") {
  const env = await getEnv();
  const normalized = normalizeApiBaseUrl(preferred || API_CONFIG.defaultBaseUrl() || DEFAULT_API_BASE_URL);
  if (!normalized) throw new Error("API base URL src/config/api.js içinde tanımlı değil veya geçersiz.");
  return normalized;
}

function buildJobUrl(job, page) {
  if (job?.operation === "web-app-sync") return job.url || WEB_APP_URL;
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

function isWebAppOperation(job) {
  return job?.operation === "web-app-sync";
}

function logClubName(job) {
  if (isWebAppOperation(job)) return job?.label || "EA Web App";
  if (isCoinCardOperation(job)) return job?.label || "Coin Cards";
  return job?.club_name || "Kulüp";
}

function logLeagueName(job) {
  if (isWebAppOperation(job)) return "Web App Sync";
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
  let challengeLogged = false;
  let lastHtml = "";
  let lastError = null;
  while (Date.now() - startedAt < FUTBIN_CHALLENGE_MAX_WAIT_MS) {
    const latestState = await getStateByTabId(tabId);
    if (!latestState.running || latestState.tabId !== tabId) throw new Error("Futbin sekme beklemesi durduruldu.");
    try {
      lastHtml = await readTabOuterHtml(tabId);
      lastError = null;
    } catch (error) {
      lastError = error;
      await delay(1000);
      continue;
    }
    const status = futbinHtmlReadiness(lastHtml);
    if (status.ready) return;
    if (status.cloudflare && !challengeLogged) {
      challengeLogged = true;
      console.info("[WebAppSync] Futbin Cloudflare doğrulaması algılandı; hedef HTML bekleniyor", {
        runnerId: state?.runnerId || null,
        currentJobIndex: state?.currentJobIndex ?? null,
        currentPage: state?.currentPage ?? null,
        currentUrl: state?.currentUrl || null,
        url,
        tabId,
        maxWaitMs: FUTBIN_CHALLENGE_MAX_WAIT_MS
      });
      await appendWebAppBackgroundLog(state, "TAB", "Futbin Cloudflare doğrulaması algılandı; hedef HTML bekleniyor", {
        tabId,
        url,
        maxWaitMs: FUTBIN_CHALLENGE_MAX_WAIT_MS
      });
    }
    await delay(1000);
  }
  const status = futbinHtmlReadiness(lastHtml);
  if (lastError && !lastHtml) throw lastError;
  throw new Error(status.cloudflare
    ? `Futbin Cloudflare doğrulaması 60 saniye içinde tamamlanmadı: ${url}`
    : `Futbin hedef HTML 60 saniye içinde okunamadı: ${url}`);
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
  const normalized = text.toLowerCase();
  const cloudflare = /cloudflare|ray id|güvenlik doğrulaması|guvenlik dogrulamasi|checking your browser|verifying you are human|kötü niyetli bot|kotu niyetli bot|malicious bots|security service/.test(normalized);
  const targetDomReady = /class=["'][^"']*(players-table|challenges-wrapper|squad-builder|sbc|player)[^"']*["']|href=["'][^"']*(\/player\/|squad-building-challenge|squad-building-challenges|\/squad\/)[^"']*["']|playerName|resourceId|lineup|starters|formation|completed challenges/i.test(text);
  return {
    cloudflare,
    targetDomReady,
    ready: targetDomReady || (text.length >= 1000 && !cloudflare)
  };
}

function isFutbinUrl(value) {
  try {
    const url = new URL(value || "");
    return url.hostname === "futbin.com" || url.hostname.endsWith(".futbin.com");
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobStatus(job, index, total, suffix) {
  if (isWebAppOperation(job))
    return `${job.label || "EA Web App"} (${index + 1}/${total}) · ${suffix}`;
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
    if (job?.operation === "web-app-sync") {
      return (url.hostname === "www.ea.com" &&
        url.pathname.replace(/\/+$/, "") === "/ea-sports-fc/ultimate-team/web-app") ||
        url.hostname === "signin.ea.com";
    }
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
    const key = normalizeText(card?.url).toLowerCase();
    if (!key) continue;
    merged.set(key, card);
  }
  return [...merged.values()];
}

function coinCardUrlKey(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    return url.href.toLowerCase();
  } catch {
    return normalizeText(value).toLowerCase();
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

function normalizeWebAppSnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  const locales = Array.isArray(snapshot.locales) ? snapshot.locales : [];
  const raritySync = snapshot.raritySync && typeof snapshot.raritySync === "object"
    ? snapshot.raritySync
    : {};
  const sbcSync = snapshot.sbcSync && typeof snapshot.sbcSync === "object"
    ? snapshot.sbcSync
    : {};
  const rarities = Array.isArray(raritySync.rarities) ? raritySync.rarities : [];
  return {
    capturedAt: Number(snapshot.capturedAt) || Date.now(),
    sourceUrl: normalizeText(snapshot.sourceUrl) || WEB_APP_URL,
    session: {
      signedIn: Boolean(snapshot.session?.signedIn),
      documentLanguage: normalizeText(snapshot.session?.documentLanguage),
      title: normalizeText(snapshot.session?.title),
      url: normalizeText(snapshot.session?.url)
    },
    loadedElement: {
      selector: normalizeText(snapshot.loadedElement?.selector),
      text: normalizeText(snapshot.loadedElement?.text)
    },
    raritySync: {
      lang: normalizeText(raritySync.lang) || "en",
      dbCount: Number(raritySync.dbCount) || 0,
      dbLocalizedCount: Number(raritySync.dbLocalizedCount) || 0,
      optionCount: Number(raritySync.optionCount) || 0,
      skippedExisting: Number(raritySync.skippedExisting) || 0,
      skippedPlaceholder: Number(raritySync.skippedPlaceholder) || 0,
      savedCount: Number(raritySync.savedCount) || rarities.length,
      rarities,
      apiMessage: normalizeText(raritySync.apiMessage) || null,
      completedAt: Number(raritySync.completedAt) || null,
      phases: {
        en: raritySync.phases?.en || null,
        tr: raritySync.phases?.tr || null
      }
    },
    sbcSync: {
      lang: normalizeText(sbcSync.lang) || "en",
      dbCount: Number(sbcSync.dbCount) || 0,
      categoryCount: Number(sbcSync.categoryCount) || 0,
      processedCategoryCount: Number(sbcSync.processedCategoryCount) || 0,
      tileCount: Number(sbcSync.tileCount) || 0,
      savedCount: Number(sbcSync.savedCount) || 0,
      insertedCount: Number(sbcSync.insertedCount) || 0,
      updatedCount: Number(sbcSync.updatedCount) || 0,
      skippedCount: Number(sbcSync.skippedCount) || 0,
      postedCount: Number(sbcSync.postedCount) || 0,
      failedCount: Number(sbcSync.failedCount) || 0,
      deletedCount: Number(sbcSync.deletedCount) || 0,
      tileDeletedCount: Number(sbcSync.tileDeletedCount) || 0,
      updatedSortCount: Number(sbcSync.updatedSortCount) || 0,
      completedAt: Number(sbcSync.completedAt) || null,
      phases: {
        en: sbcSync.phases?.en || null,
        tr: sbcSync.phases?.tr || null
      }
    },
    flowDecision: {
      englishRarityNewCount: Number(snapshot.flowDecision?.englishRarityNewCount) || 0,
      englishSbcNewCount: Number(snapshot.flowDecision?.englishSbcNewCount) || 0,
      turkishRequired: Boolean(snapshot.flowDecision?.turkishRequired),
      turkishRarityRequired: Boolean(snapshot.flowDecision?.turkishRarityRequired)
    },
    locales: locales.map((locale) => ({
      language: normalizeText(locale?.language),
      url: normalizeText(locale?.url),
      capturedAt: Number(locale?.capturedAt) || Date.now(),
      navigation: Array.isArray(locale?.navigation) ? locale.navigation : [],
      data: locale?.data && typeof locale.data === "object" ? locale.data : {}
    })).filter((locale) => locale.language)
  };
}

function toApiWebAppSnapshot(snapshot) {
  return {
    captured_at: new Date(snapshot.capturedAt).toISOString(),
    source_url: snapshot.sourceUrl,
    session: snapshot.session,
    locales: snapshot.locales
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
  if (!players.length) return;
  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get(RECORDS_KEY);
    const current = stored[RECORDS_KEY] || [];
    const runKey = state?.runStartedAt || Date.now();
    const incoming = players.map((player) => ({
      id: `${state?.runnerId || job.operation || "club-players"}:${runKey}:${job.operation || "job"}:${job.id || job.club_id}:${player.futbinPlayerId}`,
      capturedAt: Date.now(),
      pageUrl,
      job,
      runnerId: state?.runnerId || null,
      runCount: state?.runCount || 0,
      runStartedAt: state?.runStartedAt || null,
      leagueName: player.leagueName || job.league_name,
      clubName: player.clubName || job.club_name,
      saveStatus,
      processedAt: saveStatus ? Date.now() : null,
      player
    }));
    const merged = new Map(current.map((record) => [record.id, record]));
    for (const record of incoming) merged.set(record.id, record);
    await chrome.storage.local.set({ [RECORDS_KEY]: sortDisplayRecords([...merged.values()]).slice(0, MAX_RECORDS) });
  });
}

async function appendWebAppRecord(snapshot, pageUrl, job, saveStatus = null, state = null) {
  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get(RECORDS_KEY);
    const current = stored[RECORDS_KEY] || [];
    const runKey = state?.runStartedAt || Date.now();
    const record = {
      id: `web-app-sync:${runKey}`,
      capturedAt: snapshot.capturedAt || Date.now(),
      pageUrl,
      job,
      runnerId: "web-app-sync",
      runCount: state?.runCount || 0,
      runStartedAt: state?.runStartedAt || null,
      leagueName: "Web App Sync",
      clubName: "EA Web App",
      saveStatus,
      processedAt: saveStatus ? Date.now() : null,
      player: snapshot
    };
    const merged = new Map(current.map((entry) => [entry.id, entry]));
    merged.set(record.id, record);
    await chrome.storage.local.set({ [RECORDS_KEY]: sortDisplayRecords([...merged.values()]).slice(0, MAX_RECORDS) });
  });
}

function sortDisplayRecords(records = []) {
  return records.sort((left, right) => recordDisplayTime(right) - recordDisplayTime(left));
}

function recordDisplayTime(record = {}) {
  return Number(record.runStartedAt || record.capturedAt || record.processedAt || 0);
}

async function updateRecordSaveStatus(job, saveStatus, state = null) {
  await enqueueStorageWrite(async () => {
    const stored = await chrome.storage.local.get(RECORDS_KEY);
    const records = stored[RECORDS_KEY] || [];
    const processedAt = Date.now();
    const updated = records.map((record) => {
      const sameOperation = record?.job?.operation === job.operation;
      const sameId = String(record?.job?.id ?? record?.job?.club_id ?? "") === String(job.id ?? job.club_id ?? "");
      const sameRun = !state?.runStartedAt || Number(record?.runStartedAt) === Number(state.runStartedAt);
      return sameOperation && sameId && sameRun ? { ...record, saveStatus, processedAt } : record;
    });
    await chrome.storage.local.set({ [RECORDS_KEY]: updated });
  });
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
    runs["web-app-sync"];
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

function runnerIdFromAlarmName(name, prefix) {
  const marker = `${prefix}:`;
  return String(name || "").startsWith(marker) ? String(name).slice(marker.length) : null;
}

async function clearAllRunnerAlarms() {
  await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
  await chrome.alarms.clear(SYNC_LOOP_ALARM);
  await chrome.alarms.clear(WEB_APP_DAILY_ALARM);
  await chrome.alarms.clear(WEB_APP_WATCHDOG_ALARM);
  await Promise.all(RUNNER_IDS.flatMap((runnerId) => [
    chrome.alarms.clear(pageTimeoutAlarmName(runnerId)),
    chrome.alarms.clear(syncLoopAlarmName(runnerId))
  ]));
}

function isFinishedState(state) {
  return state?.status === FINISHED_STATUS;
}

function sameRun(expected, current) {
  return !expected?.runStartedAt || expected.runStartedAt === current?.runStartedAt;
}

async function isActiveRun(expected) {
  const current = await getState(expected?.runnerId);
  return Boolean(current.running && !isFinishedState(current) && sameRun(expected, current));
}

function futbinRequestDelayMs(value) {
  const raw = value && typeof value === "object" ? value.waitMs : value;
  const number = Number(raw);
  return Math.min(30000, Math.max(5000, Number.isFinite(number) && number > 0 ? number : emptyState.waitMs));
}

function isLoopRestartDue(state) {
  return Boolean(state?.running && state?.nextRunAt && state.nextRunAt <= Date.now());
}

async function setState(state) {
  return enqueueStateWrite(async () => {
    const stored = await chrome.storage.local.get(STATE_KEY);
    let root = normalizeRootState(stored[STATE_KEY]);
    if (state?.runnerId) {
      root = {
        ...root,
        apiBaseUrl: state.apiBaseUrl || root.apiBaseUrl || emptyState.apiBaseUrl,
        waitMs: futbinRequestDelayMs(state.waitMs || root.waitMs || emptyState.waitMs),
        runs: {
          ...(root.runs || {}),
          [state.runnerId]: { ...emptyRunnerState(state.runnerId, root), ...state }
        },
        updatedAt: Date.now()
      };
    } else {
      root = normalizeRootState(state);
    }
    const aggregate = aggregateRootState(root);
    await chrome.storage.local.set({ [STATE_KEY]: aggregate });
    chrome.runtime.sendMessage({ type: "STATE_CHANGED", futbinSyncModule: "webapp", state: aggregate }).catch(() => {});
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
  if (!await isActiveRun(state)) return { ok: false, action: "STOPPED" };
  const env = await getEnv();
  const loopMinutes = Number(env.SYNC_LOOP_MINUTES || env.COIN_CARDS_SYNC_LOOP_MINUTES || env.CLUB_PLAYERS_SYNC_LOOP_MINUTES) || 60;
  const waitMs = loopMinutes * 60 * 1000;
  const loopNumber = (state.runCount || 0) + 1;
  const targetTime = Date.now() + waitMs;

  const waiting = {
    ...state,
    queue: queue || state.queue,
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + (totalSaved || 0),
    skippedPlayers: state.skippedPlayers + (totalSkipped || 0),
    clubSaveResults,
    currentLatest: null,
    nextRunAt: targetTime,
    status: `Döngü bitti. ${loopNumber}. döngü bekleniyor...`,
    updatedAt: Date.now()
  };
  if (!await isActiveRun(state)) return { ok: false, action: "STOPPED" };
  await setState(waiting);
  if (!await isActiveRun(waiting)) return { ok: false, action: "STOPPED" };
  await chrome.alarms.create(syncLoopAlarmName(state), { when: targetTime });

  return { ok: true, action: "WAIT_AND_ADVANCE", waitMs };
}

ensureAutomaticSchedule().catch((error) => {
  console.warn("[WEBAPP] Otomatik scheduler başlatılamadı", error);
});
