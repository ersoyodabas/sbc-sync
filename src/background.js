import "./config/api.js";
import "./modules/important/background.js";
import "./modules/latest/background.js";
import "./modules/pricerange/background.js";
import "./modules/market/background.js";

const FC_SYNC_ENABLED_KEY = "fcSyncEnabled";
const ORCHESTRATOR_KEY = "fcSyncOrchestratorState";
const MODULE_ORDER = ["latest", "pricerange", "important"];
// Market is not part of the round-robin: while the central sync runs it is forced every MARKET_INTERVAL_MINUTES, whatever
// module is busy (a round of the others can take hours), so its price risers/fallers stay fresh.
const MARKET_MODULE = "market";
const MARKET_ALARM = "fc-sync-market-interval";
const MARKET_INTERVAL_MINUTES = 10;
const READY_STATUS = "Hazır";
let transitionQueue = Promise.resolve();

const idleOrchestratorState = {
  enabled: false,
  activeModule: null,
  // The per-run cycle order — normally MODULE_ORDER itself, but narrowed to
  // whichever modules the dashboard's per-panel switches left enabled at
  // START_SYNC time (see dashboard.js's startEnabledModules). Round-robin
  // advancement in handleModuleRoundFinished walks THIS array, not the
  // global MODULE_ORDER, so a disabled module is skipped for the whole run.
  moduleOrder: MODULE_ORDER,
  // Whether this run also forces Market every MARKET_INTERVAL_MINUTES (the dashboard's Market switch).
  marketScheduled: false,
  round: 0,
  runId: 0,
  status: READY_STATUS,
  updatedAt: null
};

// Modüller bu dosyayla aynı extension service-worker bağlamında çalışır. Bu doğrudan
// köprü, background'ın kendi kendine runtime mesajı göndermesine bağlı kalmadan tur
// tamamlanınca sıradaki modülün kesin olarak başlamasını sağlar.
globalThis.FutbinSyncCentralOrchestrator = {
  moduleRoundFinished(message) {
    return enqueueTransition(() => handleModuleRoundFinished(message));
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  await setFcSyncEnabled(false);
  await chrome.storage.local.set({ [ORCHESTRATOR_KEY]: idleOrchestratorState });
  await stopMarketSchedule();
  await stopAllSyncs();
});

chrome.runtime.onStartup.addListener(() => {
  void enqueueTransition(async () => {
    const orchestrator = await getOrchestratorState();
    if (!orchestrator.enabled) {
      await setFcSyncEnabled(false);
      await stopMarketSchedule();
      await stopAllSyncs();
      return;
    }
    await stopAllSyncs();
    await setFcSyncEnabled(true);
    // Market-only run: no round-robin module to resume, only the Market schedule.
    const marketOnly = orchestrator.marketScheduled && Array.isArray(orchestrator.moduleOrder) && !orchestrator.moduleOrder.length;
    if (!marketOnly) {
      const moduleOrder = normalizeModuleOrder(orchestrator.moduleOrder);
      await startModule(orchestrator.activeModule || moduleOrder[0], {
        ...orchestrator,
        moduleOrder,
        status: "Tarayıcı başlangıcından sonra devam ediyor"
      });
    }
    if (orchestrator.marketScheduled) await startMarketSchedule();
  });
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.futbinSyncModule !== "fc-sync") return false;
  if (message.type === "STATE_CHANGED") return false;
  enqueueTransition(() => handleCentralSyncMessage(message))
    .then(respond)
    .catch((error) => respond({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleCentralSyncMessage(message) {
  await globalThis.FutbinSyncApiConfig.ready;
  if (message.type === "GET_SNAPSHOT") return centralSnapshot();

  if (message.type === "SET_ENVIRONMENT") {
    const snapshot = await centralSnapshot();
    const states = [snapshot.latest.latestSyncState, snapshot.pricerange.priceRangeSyncState, snapshot.important.state, snapshot.market.state];
    const isActive = (state) => state && (state.running || state.waitingForNextRun || state.nextRunAt || Object.values(state.runs || {}).some(isActive));
    if (snapshot.enabled || states.some(isActive)) {
      return { ok: false, error: "Ortamı değiştirmeden önce çalışan işlemleri sonlandırın." };
    }
    await globalThis.FutbinSyncApiConfig.setEnvironment(message.environment);
    return centralSnapshot();
  }

  if (message.type === "START_SYNC") {
    // The dashboard's per-panel switches (see dashboard.js's
    // startEnabledModules) narrow which modules this run's round-robin
    // actually cycles through. No enabledModules at all (an older
    // dashboard build, or a raw API call) keeps the full MODULE_ORDER —
    // only an explicit, non-empty list narrows it.
    const narrowed = Array.isArray(message.enabledModules) && message.enabledModules.length;
    const moduleOrder = narrowed ? MODULE_ORDER.filter((id) => message.enabledModules.includes(id)) : MODULE_ORDER;
    const marketScheduled = !narrowed || message.enabledModules.includes(MARKET_MODULE);
    if (!moduleOrder.length && !marketScheduled) {
      return { ok: false, error: "Başlatmak için en az bir modül etkin olmalı." };
    }
    await stopAllSyncs();
    await stopMarketSchedule();
    const previous = await getOrchestratorState();
    const next = {
      ...idleOrchestratorState,
      enabled: true,
      activeModule: moduleOrder[0] || null,
      moduleOrder,
      marketScheduled,
      round: 1,
      runId: Number(previous.runId || 0) + 1,
      status: moduleOrder.length
        ? `1. tur · ${moduleLabel(moduleOrder[0])} başlıyor`
        : `${moduleLabel(MARKET_MODULE)} her ${MARKET_INTERVAL_MINUTES} dakikada çalışıyor`,
      updatedAt: Date.now()
    };
    await setFcSyncEnabled(true);
    await writeOrchestratorState(next);
    if (moduleOrder.length) await startModule(moduleOrder[0], next, message);
    if (marketScheduled) await startMarketSchedule({ runNow: true });
    return centralSnapshot();
  }

  if (message.type === "STOP_SYNC") {
    const current = await getOrchestratorState();
    await setFcSyncEnabled(false);
    await writeOrchestratorState({
      ...idleOrchestratorState,
      runId: Number(current.runId || 0) + 1,
      status: READY_STATUS,
      updatedAt: Date.now()
    });
    await stopMarketSchedule();
    await stopAllSyncs();
    return centralSnapshot();
  }

  if (message.type === "MODULE_ROUND_FINISHED") return handleModuleRoundFinished(message);
  return { ok: false, error: "Bilinmeyen merkezi senkronizasyon mesajı." };
}

// A stored moduleOrder can be stale/empty (state written before this
// feature existed, or corrupted) — always fall back to the full
// MODULE_ORDER rather than cycling an empty/unknown array.
function normalizeModuleOrder(moduleOrder) {
  return Array.isArray(moduleOrder) && moduleOrder.length
    ? moduleOrder.filter((id) => MODULE_ORDER.includes(id))
    : MODULE_ORDER;
}

async function handleModuleRoundFinished(message) {
  const current = await getOrchestratorState();
  const moduleName = String(message.module || "");
  if (!current.enabled || current.activeModule !== moduleName || Number(message.runId) !== Number(current.runId)) {
    return { ok: true, ignored: true };
  }
  // Cycles through THIS run's moduleOrder (narrowed at START_SYNC to the
  // panels left enabled), not the global MODULE_ORDER — a disabled module
  // is skipped for every round of the run, not just the first.
  const moduleOrder = normalizeModuleOrder(current.moduleOrder);
  const currentIndex = moduleOrder.indexOf(moduleName);
  if (currentIndex < 0) return { ok: true, ignored: true };
  const nextIndex = (currentIndex + 1) % moduleOrder.length;
  const nextModule = moduleOrder[nextIndex];
  const next = {
    ...current,
    activeModule: nextModule,
    moduleOrder,
    round: nextIndex === 0 ? Number(current.round || 0) + 1 : current.round,
    status: message.ok === false
      ? `${moduleLabel(moduleName)} hata verdi; ${moduleLabel(nextModule)} başlıyor`
      : `${moduleLabel(moduleName)} tamamlandı; ${moduleLabel(nextModule)} başlıyor`,
    updatedAt: Date.now()
  };
  await writeOrchestratorState(next);
  await startModule(nextModule, next);
  return { ok: true, advancedTo: nextModule, round: next.round };
}

async function startModule(moduleName, orchestrator, options = {}) {
  if (!MODULE_ORDER.includes(moduleName)) throw new Error(`Bilinmeyen merkezi modül: ${moduleName}`);
  let started;
  try {
    started = await moduleControl(moduleName).start({
      apiBaseUrl: options.apiBaseUrl,
      waitMs: options.waitMs,
      operations: moduleName === "latest" ? ["coin-cards"] : undefined,
      runOnce: true,
      centralManaged: true,
      centralRunId: orchestrator.runId
    });
  } catch (error) {
    started = { ok: false, error: error.message || String(error) };
  }
  if (!started?.ok) {
    await handleModuleRoundFinished({ module: moduleName, runId: orchestrator.runId, ok: false, error: started?.error || "Modül başlatılamadı" });
  }
  return started;
}

async function centralSnapshot() {
  const [orchestrator, latest, pricerange, important, market] = await Promise.all([
    getOrchestratorState(),
    moduleControl("latest").getSnapshot(),
    moduleControl("pricerange").getSnapshot(),
    moduleControl("important").getSnapshot(),
    moduleControl("market").getSnapshot()
  ]);
  return { ok: true, environment: globalThis.FutbinSyncApiConfig.environment(), enabled: orchestrator.enabled, orchestrator, latest, pricerange, important, market };
}

async function stopAllSyncs() {
  await Promise.all([...MODULE_ORDER, MARKET_MODULE].map((name) => moduleControl(name).stop()));
}

async function startMarketSchedule({ runNow = false } = {}) {
  await chrome.alarms.create(MARKET_ALARM, { delayInMinutes: MARKET_INTERVAL_MINUTES, periodInMinutes: MARKET_INTERVAL_MINUTES });
  if (runNow) await runMarket();
}

function stopMarketSchedule() {
  return chrome.alarms.clear(MARKET_ALARM);
}

// A scheduled run is not a round of the round-robin: it never reports MODULE_ROUND_FINISHED, and a run that is
// still going from the previous tick is simply left to finish.
async function runMarket() {
  try {
    await moduleControl(MARKET_MODULE).start({ scheduled: true });
  } catch (error) {
    console.warn("[FC Sync] Futbin Market zamanlı çalıştırma başlatılamadı", error);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MARKET_ALARM) return;
  void enqueueTransition(async () => {
    const orchestrator = await getOrchestratorState();
    if (!orchestrator.enabled || !orchestrator.marketScheduled) {
      await stopMarketSchedule();
      return;
    }
    await runMarket();
  });
});

function moduleControl(name) {
  const control = globalThis.FutbinSyncModuleControls?.[name];
  if (!control) throw new Error(`${name} merkezi denetim modülü yüklenmedi.`);
  return control;
}

async function getOrchestratorState() {
  const stored = await chrome.storage.local.get(ORCHESTRATOR_KEY);
  return { ...idleOrchestratorState, ...(stored[ORCHESTRATOR_KEY] || {}) };
}

async function writeOrchestratorState(state) {
  const next = { ...idleOrchestratorState, ...state, updatedAt: state.updatedAt || Date.now() };
  await chrome.storage.local.set({ [ORCHESTRATOR_KEY]: next });
  chrome.runtime.sendMessage({ futbinSyncModule: "fc-sync", type: "STATE_CHANGED", state: next }).catch(() => {});
  return next;
}

function setFcSyncEnabled(enabled) {
  return chrome.storage.local.set({ [FC_SYNC_ENABLED_KEY]: Boolean(enabled) });
}

function enqueueTransition(task) {
  const next = transitionQueue.then(task, task);
  transitionQueue = next.catch(() => {});
  return next;
}

function moduleLabel(name) {
  return ({ latest: "Latest Player Sync", pricerange: "Price Range Sync", important: "Important Players", market: "Futbin Market" })[name] || name;
}

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("index.html");
  const existing = (await chrome.tabs.query({ url: `${url}*` }))[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, active: true });
});
