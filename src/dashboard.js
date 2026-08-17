const API_CONFIG = globalThis.FutbinSyncApiConfig;

// Varsayılan API adresi src/config/api.js içindeki tek merkezden gelir.
let DEFAULT_API_BASE_URL = "";
let DEFAULT_WAIT_MS = 5000;

const modules = [
  {
    id: "important",
    title: "Important Players",
    color: "#23c7a6",
    icon: "target",
    operations: [],
    stateKey: "filteredPlayersSyncState",
    snapshotState(response) {
      return response?.state || {};
    },
    logs(response, state) {
      return state?.logs || [];
    },
    errors(_response, state) {
      return state?.errors || [];
    },
    metrics(state) {
      return [
        ["Sayfa", `${num(state.currentPage)} / ${num(state.totalPages)}`],
        ["Parsed", num(state.parsedPlayers)],
        ["Mapped", num(state.mappedPlayers)],
        ["Saved", num(state.savedPlayers)],
        ["Skipped", num(state.skippedPlayers)],
        ["Tur", num(state.roundNumber)]
      ];
    },
    progress(state) {
      return state.totalPages ? (num(state.currentPage) / num(state.totalPages)) * 100 : state.running ? 12 : 0;
    },
    extra: { label: "Aç", title: "Aktif Futbin URL'yi aç", icon: "external" }
  },
  {
    id: "latest",
    title: "Latest Player Sync",
    color: "#55a7ff",
    icon: "zap",
    operations: ["coin-cards"],
    stateKey: "latestSyncState",
    logsKey: "latestSyncLogs",
    errorsKey: "latestSyncErrors",
    snapshotState(response) {
      const root = response?.latestSyncState || {};
      return root.runs?.["coin-cards"] || root;
    },
    logs(response, state) {
      const storedLogs = response?.latestSyncLogs || [];
      return storedLogs.length ? storedLogs : state?.logs || [];
    },
    errors(response) {
      return response?.latestSyncErrors || [];
    },
    metrics(state) {
      return [
        ["YENİ KAYIT", latestInsertedCount(state)],
        ["GÜNCELLENEN", latestUpdatedCount(state)]
      ];
    },
    progress: queueProgress,
    extra: { label: "Aç", title: "Aktif URL'yi aç", icon: "external" }
  },
];

const panels = new Map();
const latestSnapshots = new Map();
const dashboard = document.querySelector("#dashboard");
const template = document.querySelector("#panelTemplate");
const globalStart = document.querySelector("#global-start");
const globalTerminate = document.querySelector("#global-terminate");
let centralSyncEnabled = false;

init();
setInterval(renderCountdowns, 1000);
setInterval(refreshAll, 2500);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.fcSyncEnabled) refreshCentralControl();
  const keys = modules.flatMap((module) => [module.stateKey, module.logsKey, module.errorsKey].filter(Boolean));
  if (keys.some((key) => changes[key])) refreshAll();
});

async function init() {
  await API_CONFIG.ready;
  DEFAULT_API_BASE_URL = API_CONFIG.defaultBaseUrl();
  DEFAULT_WAIT_MS = API_CONFIG.number("WAIT_MS", 5000);
  globalStart.addEventListener("click", () => runCentralSync("START_SYNC"));
  globalTerminate.addEventListener("click", () => runCentralSync("STOP_SYNC"));
  for (const module of modules) {
    mountPanel(module);
  }
  await refreshAll();
  await refreshCentralControl();
}

function mountPanel(module) {
  const fragment = template.content.cloneNode(true);
  const panel = fragment.querySelector(".sync-panel");
  panel.dataset.module = module.id;
  panel.style.setProperty("--module-color", module.color);
  panel.querySelector(".module-icon").innerHTML = icon(module.icon);
  panel.querySelector("h2").textContent = module.title;
  panel.querySelector(".logs-icon").innerHTML = icon("logs");
  panel.querySelector(".errors-icon").innerHTML = icon("alert");
  panel.querySelector(".countdown-icon").innerHTML = icon("clock");

  const clear = panel.querySelector(".clear");
  const extra = panel.querySelector(".extra");
  clear.innerHTML = icon("trash");
  clear.title = "Panel verisini temizle";
  extra.innerHTML = icon(module.extra.icon);
  extra.title = module.extra.title;
  extra.hidden = module.hasExtra === false;

  clear.addEventListener("click", () => clearModule(module));
  extra.addEventListener("click", () => extraAction(module));

  dashboard.appendChild(fragment);
  panels.set(module.id, panel);
}

async function refreshAll() {
  await Promise.all(modules.map((module) => refreshModule(module)));
}

async function refreshModule(module) {
  try {
    const response = await send(module, "GET_SNAPSHOT");
    latestSnapshots.set(module.id, response);
    renderModule(module, response);
  } catch (error) {
    renderError(module, error);
  }
}

async function clearModule(module) {
  if (centralSyncEnabled) {
    showToast("FC Sync çalışırken panel verisi temizlenemez. Önce merkezi denetimden tamamen sonlandırın.");
    return;
  }
  await action(module, "CLEAR_SYNC", { apiBaseUrl: DEFAULT_API_BASE_URL });
}

async function refreshCentralControl() {
  try {
    const response = await chrome.runtime.sendMessage({ futbinSyncModule: "fc-sync", type: "GET_SNAPSHOT" });
    centralSyncEnabled = Boolean(response?.enabled);
    globalStart.disabled = centralSyncEnabled;
    globalTerminate.disabled = !centralSyncEnabled;
    globalStart.setAttribute("aria-pressed", String(centralSyncEnabled));
    globalTerminate.setAttribute("aria-pressed", String(!centralSyncEnabled));
  } catch (error) {
    globalStart.disabled = true;
    globalTerminate.disabled = true;
    showToast(`Merkezi denetim kullanılamıyor: ${error.message || error}`);
  }
}

async function runCentralSync(type) {
  globalStart.disabled = true;
  globalTerminate.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      futbinSyncModule: "fc-sync",
      type,
      apiBaseUrl: DEFAULT_API_BASE_URL,
      waitMs: DEFAULT_WAIT_MS
    });
    if (!response?.ok) throw new Error(response?.error || "İşlem başarısız.");
    await Promise.all([refreshAll(), refreshCentralControl()]);
  } catch (error) {
    showToast(`FC Sync: ${error.message || error}`);
  } finally {
    await refreshCentralControl();
  }
}

async function extraAction(module) {
  const snapshot = latestSnapshots.get(module.id);
  const state = module.snapshotState(snapshot);
  if (state.awaitingFutbinVerification && state.futbinChallengeTabId) {
    try {
      const tab = await chrome.tabs.get(state.futbinChallengeTabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      // Sekme kullanıcı tarafından kapatılmış olabilir; URL fallback'i kullanılacak.
    }
  }
  if (state.awaitingFutbinVerification && state.futbinChallengeUrl) {
    await chrome.tabs.create({ url: state.futbinChallengeUrl, active: true });
    return;
  }
  if (module.id === "latest") {
    await chrome.tabs.create({ url: "https://sbcmonster.com/coin-kartlari", active: true });
    return;
  }
  const url = state.futbinChallengeUrl || state.currentUrl || state.queue?.[state.currentJobIndex]?.url;
  if (url) await chrome.tabs.create({ url, active: true });
}

async function action(module, type, payload = {}) {
  try {
    const response = await send(module, type, payload);
    if (!response?.ok) throw new Error(response?.error || "İşlem başarısız.");
    await refreshModule(module);
  } catch (error) {
    showToast(`${module.title}: ${error.message || error}`);
    await refreshModule(module);
  }
}

function send(module, type, payload = {}) {
  return chrome.runtime.sendMessage({ futbinSyncModule: module.id, type, ...payload });
}

function renderModule(module, response) {
  const panel = panels.get(module.id);
  const state = module.snapshotState(response);
  const logs = module.logs(response, state);
  const errors = module.errors(response, state);
  panel.dataset.running = state.running ? "true" : "false";

  const challengeUrl = state.awaitingFutbinVerification ? safeFutbinUrl(state.futbinChallengeUrl) : "";
  panel.querySelector(".status-text").textContent = [state.status || "Hazır", challengeUrl].filter(Boolean).join(" · ");
  panel.querySelector(".progress-bar").style.width = `${clamp(module.progress(state), 0, 100)}%`;
  const metrics = [...module.metrics(state), ["TOPLAM SÜRE", elapsedDurationText(state)]];
  panel.querySelector(".metric-grid").innerHTML = metrics.map(([label, value]) => `
    <div class="metric" data-metric-label="${escapeHtml(label)}"><span>${icon(metricIcon(label))}${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");

  renderCountdown(module, state);
  renderLines(panel.querySelector(".logs"), logs, "Henüz log yok.", false, module.id);
  renderLines(panel.querySelector(".errors"), errors, "Hata yok.", true, module.id);
  panel.querySelector(".log-count").textContent = String(logs.length || 0);
  panel.querySelector(".error-count").textContent = String(errors.length || 0);
}

function renderError(module, error) {
  const panel = panels.get(module.id);
  panel.querySelector(".status-text").textContent = `Dashboard okuyamadı: ${error.message || error}`;
}

function renderLines(container, entries, emptyText, isError = false, moduleId = null) {
  if (moduleId === "latest" && !isError) {
    renderLatestLines(container, entries, emptyText);
    return;
  }
  const rows = (Array.isArray(entries) ? entries : []).slice(-70).reverse();
  if (!rows.length) {
    container.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  container.innerHTML = rows.map((entry) => {
    const at = entryTime(entry);
    const message = moduleId === "latest" && !isError
      ? latestLogText(entry)
      : moduleId === "important" && isError
        ? importantErrorText(entry)
        : entryMessage(entry, isError);
    const className = isError ? "error-line" : "log-line";
    const futbinUrl = isError && moduleId === "important" ? importantErrorFutbinUrl(entry) : "";
    if (futbinUrl) {
      return `<a class="${className}" href="${escapeHtml(futbinUrl)}" target="_blank" rel="noopener noreferrer"><time>${escapeHtml(at)}</time><span>${escapeHtml(message)}</span></a>`;
    }
    return `<div class="${className}"><time>${escapeHtml(at)}</time><span>${escapeHtml(message)}</span></div>`;
  }).join("");
}

function importantErrorFutbinUrl(entry) {
  if (typeof entry === "string") {
    const text = entry.trim();
    if (text.startsWith("{")) {
      try {
        return importantErrorFutbinUrl(JSON.parse(text));
      } catch {
        // Metin içindeki URL kontrolüyle devam et.
      }
    }
    return safeFutbinUrl(text.match(/https?:\/\/(?:www\.)?futbin\.com\/[^\s"'|]+/i)?.[0]);
  }
  if (!entry || typeof entry !== "object") return "";

  const directCandidates = [
    entry.futbin_player_link,
    entry.futbinPlayerLink,
    entry.FutbinPlayerLink,
    entry.futbin_player_url,
    entry.futbinUrl,
    entry.player_url,
    entry.url
  ];
  for (const candidate of directCandidates) {
    const url = safeFutbinUrl(candidate);
    if (url) return url;
  }

  for (const [key, value] of Object.entries(entry)) {
    if (!/(futbin|player).*(url|link)|(url|link).*(futbin|player)/i.test(key)) continue;
    const url = safeFutbinUrl(value);
    if (url) return url;
  }

  for (const nested of [entry.player, entry.record, entry.rawPlayer, entry.details]) {
    const url = importantErrorFutbinUrl(nested);
    if (url) return url;
  }

  return importantErrorFutbinUrl(entry.message || entry.error || "");
}

function safeFutbinUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value), "https://www.futbin.com");
    return url.hostname === "futbin.com" || url.hostname.endsWith(".futbin.com") ? url.href : "";
  } catch {
    return "";
  }
}

function importantErrorText(entry) {
  const raw = entryMessage(entry, true);
  if (!raw) return "Bilinmeyen oyuncu hatası";

  const player = raw.match(/^(.*?)\s*\|/)?.[1]?.trim();
  const reason = raw.match(/Sebep:\s*(.*?)(?:\s*\|\s*Futbin:|$)/i)?.[1]?.trim();
  const playerId = errorValue(raw, "futbin_player_id");
  const clubId = errorValue(raw, "futbin_club_id");
  const leagueId = errorValue(raw, "futbin_league_id");
  const position = errorValue(raw, "position");
  const rating = errorValue(raw, "rating");

  if (!player && !reason) return raw;

  const identity = [player, playerId ? `Player ID ${playerId}` : ""].filter(Boolean).join(" · ");
  const context = [
    clubId ? `Club ${clubId}` : "",
    leagueId ? `League ${leagueId}` : "",
    position || "",
    rating ? `Rating ${rating}` : ""
  ].filter(Boolean).join(" · ");

  return [identity, reason, context].filter(Boolean).join(" | ");
}

function errorValue(message, key) {
  return String(message || "").match(new RegExp(`${key}\\s*[=:]\\s*([^\\s·;|()]+)`, "i"))?.[1] || "";
}

function renderLatestLines(container, entries, emptyText) {
  const rows = latestDisplayEntries(entries).slice(-70).reverse();
  if (!rows.length) {
    container.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  const existing = new Map([...container.querySelectorAll(".log-line[data-log-key]")]
    .map((line) => [line.dataset.logKey, line]));
  const activeKeys = new Set();
  const fragment = document.createDocumentFragment();

  rows.forEach((entry, index) => {
    const key = latestDashboardLogKey(entry, index);
    const playerState = latestPlayerLogState(entry);
    const line = existing.get(key) || document.createElement("div");
    line.className = `log-line${playerState ? ` has-status-icon ${playerState}` : ""}`;
    line.dataset.logKey = key;
    line.innerHTML = `<time>${escapeHtml(entryTime(entry))}</time><span class="log-message">${latestDashboardLogIcon(playerState)}<span>${escapeHtml(latestLogText(entry))}</span></span>`;
    activeKeys.add(key);
    fragment.appendChild(line);
  });

  existing.forEach((line, key) => {
    if (!activeKeys.has(key)) line.remove();
  });
  container.replaceChildren(fragment);
}

function latestDisplayEntries(entries) {
  const latestByKey = new Map();
  const orderedEntries = [...(Array.isArray(entries) ? entries : [])]
    .sort((left, right) => entryTimeValue(left) - entryTimeValue(right));
  orderedEntries.forEach((entry, index) => {
    const playerKey = latestPlayerLogKey(entry);
    const key = playerKey || `event:${entry?.id || `${entryTimeValue(entry)}:${entry?.eventType || index}`}`;
    latestByKey.set(key, entry);
  });
  return [...latestByKey.values()].sort((left, right) => entryTimeValue(left) - entryTimeValue(right));
}

function latestDashboardLogKey(entry, index) {
  return latestPlayerLogKey(entry) || `event:${entry?.id || `${entryTimeValue(entry)}:${entry?.eventType || index}`}`;
}

function latestPlayerLogKey(entry = {}) {
  const eventType = String(entry?.eventType || "");
  if (!["card-processing", "new-card-detected", "card-updated", "card-completed"].includes(eventType)) return "";
  const url = String(entry.url || "").trim().toLocaleLowerCase("tr-TR");
  if (url) return `player-url:${url}`;
  const name = String(entry.playerName || entry.name || "").trim().toLocaleLowerCase("tr-TR");
  return name ? `player:${entry.rating || ""}:${name}` : "";
}

function latestPlayerLogState(entry = {}) {
  if (entry.eventType === "card-processing") return "processing";
  if (["new-card-detected", "card-updated", "card-completed"].includes(entry.eventType)) return "success";
  return "";
}

function latestDashboardLogIcon(state) {
  if (state === "processing") {
    return `<span class="log-state-icon loader" aria-label="İşleniyor"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M21 12a9 9 0 0 0-9-9"/></svg></span>`;
  }
  if (state === "success") {
    return `<span class="log-state-icon success" aria-label="Başarılı">${icon("saved")}</span>`;
  }
  return "";
}

function entryTimeValue(entry) {
  const value = entry?.at || entry?.requestedAt || entry?.createdAt || entry?.completedAt || entry?.updatedAt;
  const date = typeof value === "number" || String(value || "").match(/^\d+$/) ? new Date(Number(value)) : new Date(value || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function latestLogText(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (entry.message) return String(entry.message);
  const name = entry.playerName || entry.name || "Latest Player";
  const rating = entry.rating ? `Rating ${entry.rating}` : null;
  const price = entry.priceCross ? `Price Cross ${num(entry.priceCross).toLocaleString("tr-TR")}` : null;
  const pieces = [rating, name, price].filter(Boolean);
  if (pieces.length) return pieces.join(" · ");
  if (entry.eventType) return String(entry.eventType);
  return "Latest Sync log";
}

function renderCountdowns() {
  for (const module of modules) {
    const snapshot = latestSnapshots.get(module.id);
    if (!snapshot) continue;
    const state = module.snapshotState(snapshot);
    renderCountdown(module, state);
    renderElapsedMetric(module, state);
  }
}

function renderElapsedMetric(module, state) {
  const panel = panels.get(module.id);
  const metric = panel?.querySelector('.metric[data-metric-label="TOPLAM SÜRE"] strong');
  if (metric) metric.textContent = elapsedDurationText(state);
}

function renderCountdown(module, state) {
  const panel = panels.get(module.id);
  const element = panel.querySelector(".countdown");
  const value = panel.querySelector(".countdown-value");
  if (state.running && !state.waitingForNextRun) {
    element.hidden = true;
    value.textContent = "";
    return;
  }
  if (!state.nextRunAt) {
    element.hidden = true;
    value.textContent = "";
    return;
  }
  const seconds = Math.max(0, Math.ceil((Number(state.nextRunAt) - Date.now()) / 1000));
  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  element.hidden = false;
  value.textContent = `${hh}:${mm}:${ss}`;
}

function queueProgress(state) {
  const total = Math.max(num(state.queue?.length), 1);
  const index = Math.max(num(state.currentJobIndex), 0);
  const pageRatio = state.totalPages ? num(state.currentPage) / Math.max(num(state.totalPages), 1) : 0;
  if (state.running) return ((index + pageRatio) / total) * 100;
  return state.nextRunAt ? 100 : 0;
}

function entryTime(entry) {
  if (!entry || typeof entry !== "object") return "--:--";
  const value = entry?.at || entry?.requestedAt || entry?.createdAt || entry?.completedAt || entry?.updatedAt || entry?.date;
  if (!value) return "--:--";
  const date = typeof value === "number" || String(value).match(/^\d+$/) ? new Date(Number(value)) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 12);
  return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function entryMessage(entry, isError) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (entry.message) return entry.message;
  if (entry.error) return entry.error;
  if (entry.step) return `${entry.step}: ${entry.details?.message || entry.status || "log"}`;
  if (isError && entry.player) return `${entry.player?.playerName || entry.player?.name || "Kayıt"}: ${entry.stage || "hata"}`;
  return JSON.stringify(entry);
}

function metricIcon(label) {
  const key = String(label || "").toLowerCase();
  if (key.includes("sayfa")) return "pages";
  if (key.includes("parsed")) return "scan";
  if (key.includes("mapped")) return "map";
  if (key.includes("saved")) return "saved";
  if (key.includes("skipped")) return "skip";
  if (key.includes("yeni")) return "card";
  if (key.includes("güncellenen")) return "saved";
  if (key.includes("eksik")) return "alert";
  if (key.includes("işlenen")) return "scan";
  if (key.includes("bulunan")) return "target";
  if (key.includes("tur")) return "round";
  if (key.includes("kuyruk")) return "queue";
  if (key.includes("kart")) return "card";
  if (key.includes("run")) return "run";
  if (key.includes("adım")) return "step";
  if (key.includes("saat")) return "clock";
  if (key.includes("tab")) return "tab";
  if (key.includes("süre")) return "clock";
  return "dot";
}

function icon(name) {
  const icons = {
    refresh: `<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.4 5.6L21 8"/><path d="M21 3v5h-5"/></svg>`,
    target: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`,
    zap: `<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 10-13h-7z"/></svg>`,
    layout: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M3 9h18"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z"/></svg>`,
    stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
    activity: `<svg viewBox="0 0 24 24"><path d="M4 12h4l2-6 4 12 2-6h4"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>`,
    external: `<svg viewBox="0 0 24 24"><path d="M14 3h7v7"/><path d="m10 14 11-11"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>`,
    network: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3 3 15 0 18"/><path d="M12 3c-3 3-3 15 0 18"/></svg>`,
    server: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01"/><path d="M7 17h.01"/></svg>`,
    clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
    logs: `<svg viewBox="0 0 24 24"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`,
    alert: `<svg viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.7 18a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`,
    pages: `<svg viewBox="0 0 24 24"><path d="M4 4h11l5 5v11H4z"/><path d="M15 4v5h5"/></svg>`,
    scan: `<svg viewBox="0 0 24 24"><path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M7 12h10"/></svg>`,
    map: `<svg viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15"/><path d="M15 6v15"/></svg>`,
    saved: `<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>`,
    skip: `<svg viewBox="0 0 24 24"><path d="m5 5 14 14"/><path d="M19 5 5 19"/></svg>`,
    round: `<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>`,
    queue: `<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/></svg>`,
    card: `<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8"/><path d="M8 13h5"/></svg>`,
    run: `<svg viewBox="0 0 24 24"><path d="M4 17a8 8 0 1 0 2-11"/><path d="M4 4v5h5"/></svg>`,
    step: `<svg viewBox="0 0 24 24"><path d="M5 6h4v4H5z"/><path d="M15 14h4v4h-4z"/><path d="M9 8h3a4 4 0 0 1 4 4v2"/></svg>`,
    tab: `<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M4 9h16"/></svg>`,
    dot: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>`
  };
  return icons[name] || icons.refresh;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5200);
}

function latestInsertedCount(state) {
  const latestResult = state?.clubSaveResults?.["coin-card:latest"] || {};
  return num(latestResult.inserted) || num(state?.newlyInsertedCoinCardIds?.length);
}

function latestUpdatedCount(state) {
  const results = state?.clubSaveResults || {};
  const detailUpdated = Object.entries(results)
    .filter(([key]) => /^coin-card:\d+$/i.test(key))
    .reduce((total, [, result]) => total + num(result?.updated), 0);
  return detailUpdated || num(results["coin-card:latest"]?.updated);
}

function num(value) {
  return Number(value) || 0;
}

function elapsedDurationText(state = {}) {
  const start = firstTimeValue(state.startedAt, state.runStartedAt, state.run_started_at);
  if (!start) return "--";
  const end = state.running ? Date.now() : firstTimeValue(state.completedAt, state.finishedAt, state.updatedAt) || Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return formatElapsedSeconds(seconds);
}

function firstTimeValue(...values) {
  for (const value of values) {
    const time = timeValue(value);
    if (time) return time;
  }
  return 0;
}

function timeValue(value) {
  if (!value) return 0;
  const date = typeof value === "number" || String(value).match(/^\d+$/) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatElapsedSeconds(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours} Sa. ${minutes} Dk. ${seconds} Sn.`;
  if (minutes) return `${minutes} Dk. ${seconds} Sn.`;
  return `${seconds} Saniye`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[character]);
}
