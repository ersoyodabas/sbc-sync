import "./config/api.js";
import "./modules/important/background.js";
import "./modules/latest/background.js";
import "./modules/pricerange/background.js";

const FC_SYNC_ENABLED_KEY = "fcSyncEnabled";
const ORCHESTRATOR_KEY = "fcSyncOrchestratorState";
const MODULE_ORDER = ["latest", "pricerange", "important"];
const READY_STATUS = "Hazır";
let transitionQueue = Promise.resolve();

const idleOrchestratorState = {
  enabled: false,
  activeModule: null,
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
  await stopAllSyncs();
});

chrome.runtime.onStartup.addListener(() => {
  void enqueueTransition(async () => {
    const orchestrator = await getOrchestratorState();
    if (!orchestrator.enabled) {
      await setFcSyncEnabled(false);
      await stopAllSyncs();
      return;
    }
    await stopAllSyncs();
    await setFcSyncEnabled(true);
    await startModule(orchestrator.activeModule || MODULE_ORDER[0], {
      ...orchestrator,
      status: "Tarayıcı başlangıcından sonra devam ediyor"
    });
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
  if (message.type === "GET_SNAPSHOT") return centralSnapshot();

  if (message.type === "START_SYNC") {
    await stopAllSyncs();
    const previous = await getOrchestratorState();
    const next = {
      ...idleOrchestratorState,
      enabled: true,
      activeModule: MODULE_ORDER[0],
      round: 1,
      runId: Number(previous.runId || 0) + 1,
      status: "1. tur · Latest Player Sync başlıyor",
      updatedAt: Date.now()
    };
    await setFcSyncEnabled(true);
    await writeOrchestratorState(next);
    await startModule(MODULE_ORDER[0], next, message);
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
    await stopAllSyncs();
    return centralSnapshot();
  }

  if (message.type === "MODULE_ROUND_FINISHED") return handleModuleRoundFinished(message);
  return { ok: false, error: "Bilinmeyen merkezi senkronizasyon mesajı." };
}

async function handleModuleRoundFinished(message) {
  const current = await getOrchestratorState();
  const moduleName = String(message.module || "");
  if (!current.enabled || current.activeModule !== moduleName || Number(message.runId) !== Number(current.runId)) {
    return { ok: true, ignored: true };
  }
  const currentIndex = MODULE_ORDER.indexOf(moduleName);
  if (currentIndex < 0) return { ok: true, ignored: true };
  const nextIndex = (currentIndex + 1) % MODULE_ORDER.length;
  const nextModule = MODULE_ORDER[nextIndex];
  const next = {
    ...current,
    activeModule: nextModule,
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
  const [orchestrator, latest, pricerange, important] = await Promise.all([
    getOrchestratorState(),
    moduleControl("latest").getSnapshot(),
    moduleControl("pricerange").getSnapshot(),
    moduleControl("important").getSnapshot()
  ]);
  return { ok: true, enabled: orchestrator.enabled, orchestrator, latest, pricerange, important };
}

async function stopAllSyncs() {
  await Promise.all(MODULE_ORDER.map((name) => moduleControl(name).stop()));
}

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
  return ({ latest: "Latest Player Sync", pricerange: "Price Range Sync", important: "Important Players" })[name] || name;
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
