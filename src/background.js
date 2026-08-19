import "./config/api.js";
import "./modules/important/background.js";
import "./modules/latest/background.js";
import "./modules/pricerange/background.js";

const FC_SYNC_ENABLED_KEY = "fcSyncEnabled";

chrome.runtime.onInstalled.addListener(async () => {
  await setFcSyncEnabled(false);
  await stopAllSyncs();
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.futbinSyncModule !== "fc-sync") return false;
  handleCentralSyncMessage(message)
    .then(respond)
    .catch((error) => respond({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleCentralSyncMessage(message) {
  if (message.type === "GET_SNAPSHOT") {
    const [enabled, latest, important] = await Promise.all([
      isFcSyncEnabled(),
      moduleControl("latest").getSnapshot(),
      moduleControl("important").getSnapshot()
    ]);
    return { ok: true, enabled, latest, important };
  }
  if (message.type === "START_SYNC") {
    await setFcSyncEnabled(true);
    await moduleControl("important").stop();
    const latest = await moduleControl("latest").start({
      apiBaseUrl: message.apiBaseUrl,
      waitMs: message.waitMs,
      operations: ["coin-cards"]
    });
    if (!latest?.ok) {
      await setFcSyncEnabled(false);
      throw new Error(latest?.error || "Latest Player Sync başlatılamadı.");
    }
    return { ok: true, enabled: true, latest };
  }
  if (message.type === "STOP_SYNC") {
    await setFcSyncEnabled(false);
    await stopAllSyncs();
    return { ok: true, enabled: false };
  }
  return { ok: false, error: "Bilinmeyen merkezi senkronizasyon mesajı." };
}

async function stopAllSyncs() {
  await Promise.all([
    moduleControl("latest").stop(),
    moduleControl("important").stop()
  ]);
}

function moduleControl(name) {
  const control = globalThis.FutbinSyncModuleControls?.[name];
  if (!control) throw new Error(`${name} merkezi denetim modülü yüklenmedi.`);
  return control;
}

async function isFcSyncEnabled() {
  return Boolean((await chrome.storage.local.get(FC_SYNC_ENABLED_KEY))[FC_SYNC_ENABLED_KEY]);
}

function setFcSyncEnabled(enabled) {
  return chrome.storage.local.set({ [FC_SYNC_ENABLED_KEY]: Boolean(enabled) });
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
