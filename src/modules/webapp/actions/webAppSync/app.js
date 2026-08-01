(function () {
  const actions = window.FutbinSyncActions = window.FutbinSyncActions || {};
  let logSequence = 0;
  let logQueue = Promise.resolve();
  let apiLoaderSequence = 0;
  let apiRequestSequence = 0;
  const apiLoaderTokens = new Map();
  const BRIDGE_REQUEST_TYPE = "sbcmonster:webapp-api-request";
  const BRIDGE_RESPONSE_TYPE = "sbcmonster:webapp-api-response";
  let bridgeReadyPromise = null;
  let apiBaseUrlPromise = null;

  removeLegacyWebAppUi();

  window.FutbinSyncWebAppApi = async function (method, endpoint, body = null) {
    const methodName = String(method || "GET").toUpperCase();
    const endpointName = String(endpoint || "api");
    const requestId = `${Date.now()}-${++apiRequestSequence}`;
    const ownsLoader = apiLoaderTokens.size === 0;
    const token = ownsLoader
      ? window.FutbinSyncWebAppApiLoader.show(`${methodName} ${endpointName} API isteği gönderiliyor...`, {
        method: methodName,
        endpoint: endpointName,
        operation: methodName === "GET" ? "load" : "save"
      })
      : null;
    if (ownsLoader) await waitForLoaderPaint();
    try {
      console.groupCollapsed(`[WebAppSync][API][REQUEST] ${methodName} ${endpointName}`);
      console.log("request", {
        requestId,
        method: methodName,
        endpoint: endpointName,
        body
      });
      const response = await sendWebAppApiRequest({ requestId, method: methodName, endpoint: endpointName, body });
      console.log("response", response);
      console.groupEnd();
      if (!response.ok) {
        const message = response.error || response.response?.message || `API isteği başarısız (${response.status || 0})`;
        if (ownsLoader) window.FutbinSyncWebAppApiLoader.hide(token, "failed", message);
        return {
          result: false,
          message,
          data: response.response?.data || null
        };
      }
      if (ownsLoader) window.FutbinSyncWebAppApiLoader.hide(token, "completed");
      return response.response || {};
    } catch (error) {
      console.error(`[WebAppSync][API][ERROR] ${methodName} ${endpointName}`, error);
      try { console.groupEnd(); } catch { /* Grup açık değilse yok say. */ }
      if (ownsLoader) window.FutbinSyncWebAppApiLoader.hide(token, "failed", error.message || String(error));
      throw error;
    }
  };

  async function sendWebAppApiRequest(payload) {
    const bridgeResponse = await sendWebAppApiRequestViaBridge(payload);
    if (bridgeResponse) return bridgeResponse;
    console.warn("[WebAppSync][API] MAIN world bridge kullanılamadı; background API yoluna düşülüyor.", {
      method: payload.method,
      endpoint: payload.endpoint
    });
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        resolve({ ok: false, status: 0, error: "API isteği 60 saniye içinde tamamlanmadı." });
      }, 60000);
      chrome.runtime.sendMessage({
        futbinSyncModule: "webapp",
        type: "WEB_APP_API_REQUEST",
        ...payload
      }).then((response) => {
        window.clearTimeout(timeoutId);
        resolve(response || { ok: false, status: 0, error: "API yanıtı boş döndü." });
      }).catch((error) => {
        window.clearTimeout(timeoutId);
        resolve({ ok: false, status: 0, error: error.message || String(error) });
      });
    });
  }

  async function sendWebAppApiRequestViaBridge(payload) {
    try {
      await ensurePageApiBridge();
    } catch (error) {
      console.warn("[WebAppSync][API_BRIDGE] Bridge yüklenemedi.", error);
      return null;
    }
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, status: 0, error: "MAIN world API isteği 60 saniye içinde tamamlanmadı." });
      }, 60000);
      function onMessage(event) {
        if (event.source !== window || event.data?.type !== BRIDGE_RESPONSE_TYPE) return;
        const response = event.data.payload || {};
        if (String(response.requestId || "") !== String(payload.requestId || "")) return;
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        resolve(response);
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ type: BRIDGE_REQUEST_TYPE, payload }, "*");
    });
  }

  async function ensurePageApiBridge() {
    if (window.__FutbinSyncPageApiBridgeInjected) return Promise.resolve(true);
    if (bridgeReadyPromise) return bridgeReadyPromise;
    const resolvedApiBaseUrl = await resolveWebAppApiBaseUrl();
    bridgeReadyPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const apiBaseUrl = encodeURIComponent(resolvedApiBaseUrl || "");
      script.src = `${chrome.runtime.getURL("src/modules/webapp/actions/webAppSync/page_api_bridge.js")}?apiBaseUrl=${apiBaseUrl}&t=${Date.now()}`;
      script.async = false;
      script.onload = () => {
        window.__FutbinSyncPageApiBridgeInjected = true;
        console.info("[WebAppSync][API_BRIDGE] MAIN world API bridge enjekte edildi.", { src: script.src });
        resolve(true);
      };
      script.onerror = () => reject(new Error("MAIN world API bridge script yüklenemedi."));
      (document.head || document.documentElement).appendChild(script);
    });
    return bridgeReadyPromise;
  }

  function resolveWebAppApiBaseUrl() {
    if (apiBaseUrlPromise) return apiBaseUrlPromise;
    apiBaseUrlPromise = (async () => {
      await window.FutbinSyncApiConfig?.ready;
      const fromConfig = window.FutbinSyncApiConfig?.defaultBaseUrl?.();
      if (!fromConfig) throw new Error("API_BASE_URL .env dosyasından yüklenemedi.");
      return normalizeBaseUrl(fromConfig);
    })();
    return apiBaseUrlPromise;
  }

  function normalizeBaseUrl(value) {
    try {
      const url = new URL(value);
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  window.FutbinSyncWebAppLog = function (step, message, details) {
    if (!isEaPage() || !chrome?.runtime?.sendMessage) return Promise.resolve();
    logSequence += 1;
    const payload = {
      futbinSyncModule: "webapp",
      type: "WEB_APP_SYNC_LOG",
      sequence: logSequence,
      step,
      message,
      details: details === undefined ? null : details,
      pageUrl: location.href,
      requestedAt: Date.now()
    };
    console.log("[WebAppSync][LOG]", payload);
    logQueue = logQueue
      .then(() => chrome.runtime.sendMessage(payload))
      .catch(() => {});
    return logQueue;
  };

  window.FutbinSyncWebAppApiLoader = {
    show(message = "API isteği gönderiliyor...", details = null) {
      const token = ++apiLoaderSequence;
      const substep = buildApiSubstep(message, details, "progressing");
      apiLoaderTokens.set(token, { message, details, substep });
      renderApiLoader();
      window.FutbinSyncWebAppLog("API_SUBSTEP", message, { ...details, substep });
      return token;
    },
    hide(token, status = "completed", error = null) {
      const active = apiLoaderTokens.get(token);
      if (active) {
        window.FutbinSyncWebAppLog("API_SUBSTEP", status === "failed" ? `${active.message} Hata` : `${active.message} Tamamlandı`, {
          ...(active.details || {}),
          substep: buildApiSubstep(active.message, active.details, status, error)
        });
      }
      if (token != null) apiLoaderTokens.delete(token);
      renderApiLoader();
      if (status === "failed") {
        showApiToast(error || active?.message || "API isteği başarısız.", "error");
      }
    },
    async wrap(message, task, details = null) {
      const token = this.show(message, details);
      try {
        await waitForLoaderPaint();
        const result = await task();
        const failed = result?.ok === false || result?.result === false;
        this.hide(token, failed ? "failed" : "completed", result?.message || result?.error || null);
        return result;
      } catch (error) {
        this.hide(token, "failed", error.message || String(error));
        throw error;
      }
    }
  };

  function waitForLoaderPaint() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });
  }

  function renderApiLoader() {
    ensureApiLoaderUi();
    const overlay = document.getElementById("futbin-sync-api-loader");
    if (!overlay) return;
    const mountTarget = loaderMountTarget();
    if (overlay.parentElement !== mountTarget) mountTarget.appendChild(overlay);
    const active = [...apiLoaderTokens.values()].at(-1);
    if (!active) {
      overlay.classList.remove("is-visible");
      overlay.setAttribute("aria-hidden", "true");
      return;
    }

    const method = String(active.details?.method || "").toUpperCase();
    const endpoint = String(active.details?.endpoint || "api");
    const lang = String(active.details?.lang || "").toUpperCase();
    overlay.querySelector(".fsa-loader-title").textContent = active.substep?.title || active.message;
    overlay.querySelector(".fsa-loader-message").textContent = "Endpoint request gönderildi, response bekleniyor.";
    overlay.querySelector(".fsa-loader-meta").textContent = [method, endpoint, lang].filter(Boolean).join(" · ");
    overlay.classList.add("is-visible");
    overlay.setAttribute("aria-hidden", "false");
  }

  function ensureApiLoaderUi() {
    if (!document.getElementById("futbin-sync-api-loader-style")) {
      const style = document.createElement("style");
      style.id = "futbin-sync-api-loader-style";
      style.textContent = `
        #futbin-sync-api-loader {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          display: grid;
          place-items: center;
          background: rgba(3, 7, 18, 0.46);
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none;
          transition: opacity 160ms ease;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #futbin-sync-api-loader.is-visible {
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto !important;
        }
        #futbin-sync-api-loader .fsa-loader-card {
          display: grid;
          justify-items: center;
          gap: 10px;
          width: min(360px, calc(100vw - 40px));
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 8px;
          background: rgba(14, 22, 36, 0.94);
          box-shadow: 0 22px 70px rgba(0, 0, 0, 0.42);
          color: #f8fbff;
          padding: 22px 20px;
          text-align: center;
        }
        #futbin-sync-api-loader .fsa-logo-wrap {
          display: grid;
          place-items: center;
          width: 76px;
          height: 76px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.08);
          animation: fsaPulse 1100ms ease-in-out infinite;
        }
        #futbin-sync-api-loader img {
          width: 54px;
          height: 54px;
          object-fit: contain;
        }
        #futbin-sync-api-loader .fsa-loader-title {
          max-width: 100%;
          overflow-wrap: anywhere;
          font-size: 16px;
          font-weight: 800;
          line-height: 1.25;
        }
        #futbin-sync-api-loader .fsa-loader-message,
        #futbin-sync-api-loader .fsa-loader-meta {
          max-width: 100%;
          overflow-wrap: anywhere;
          color: #b7c7d7;
          font-size: 12px;
          line-height: 1.35;
        }
        #futbin-sync-api-loader .fsa-loader-meta {
          color: #72e6ad;
          font-weight: 800;
          letter-spacing: 0;
        }
        @keyframes fsaPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(114, 230, 173, 0.24); }
          50% { transform: scale(1.04); box-shadow: 0 0 0 10px rgba(114, 230, 173, 0); }
        }
      `;
      loaderMountTarget().appendChild(style);
    }

    if (!document.getElementById("futbin-sync-api-loader")) {
      const overlay = document.createElement("div");
      overlay.id = "futbin-sync-api-loader";
      overlay.setAttribute("aria-hidden", "true");
      overlay.innerHTML = `
        <div class="fsa-loader-card" role="status" aria-live="polite">
          <div class="fsa-logo-wrap"><img alt="SBC Monster" src="${chrome.runtime.getURL("src/assets/img/appLogoSmall.png")}"></div>
          <div class="fsa-loader-title">API isteği gönderiliyor...</div>
          <div class="fsa-loader-message">Endpoint request gönderildi, response bekleniyor.</div>
          <div class="fsa-loader-meta">API</div>
        </div>
      `;
      loaderMountTarget().appendChild(overlay);
    }
  }

  function loaderMountTarget() {
    return document.body || document.documentElement;
  }

  function showApiToast(message, type = "error") {
    ensureApiToastUi();
    const container = document.getElementById("futbin-sync-webapp-toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `fsa-toast ${type}`;
    toast.textContent = message || "İşlem başarısız.";
    container.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("is-hiding");
      window.setTimeout(() => toast.remove(), 220);
    }, 5000);
  }

  function ensureApiToastUi() {
    if (!document.getElementById("futbin-sync-webapp-toast-style")) {
      const style = document.createElement("style");
      style.id = "futbin-sync-webapp-toast-style";
      style.textContent = `
        #futbin-sync-webapp-toast-container {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          display: grid;
          gap: 8px;
          width: min(360px, calc(100vw - 36px));
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #futbin-sync-webapp-toast-container .fsa-toast {
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-left: 4px solid #ff5c83;
          border-radius: 8px;
          background: rgba(28, 10, 18, 0.96);
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.34);
          color: #ffe7ed;
          padding: 12px 14px;
          font-size: 12px;
          font-weight: 700;
          line-height: 1.35;
          overflow-wrap: anywhere;
          opacity: 1;
          transform: translateY(0);
          transition: opacity 180ms ease, transform 180ms ease;
        }
        #futbin-sync-webapp-toast-container .fsa-toast.is-hiding {
          opacity: 0;
          transform: translateY(8px);
        }
      `;
      loaderMountTarget().appendChild(style);
    }
    if (!document.getElementById("futbin-sync-webapp-toast-container")) {
      const container = document.createElement("div");
      container.id = "futbin-sync-webapp-toast-container";
      loaderMountTarget().appendChild(container);
    }
  }

  function buildApiSubstep(message, details = {}, status = "progressing", error = null) {
    const endpoint = String(details?.endpoint || "api");
    const method = String(details?.method || "GET").toUpperCase();
    const lang = String(details?.lang || "en").toLowerCase().startsWith("tr") ? "tr" : "en";
    const isRarity = endpoint.startsWith("rarity");
    const title = describeApiSubstep(endpoint, method, lang, message);
    return {
      key: `${lang}:${endpoint}:${details?.operation || "request"}`,
      parentStepId: isRarity ? (lang === "tr" ? 7 : 3) : (lang === "tr" ? 8 : 4),
      status,
      title,
      detail: error || `${method} ${endpoint}`
    };
  }

  function describeApiSubstep(endpoint, method, lang, fallback) {
    const prefix = lang.toUpperCase();
    if (endpoint === "rarity") return `${prefix} rarity kayıtları yükleniyor`;
    if (endpoint === "rarity/bulk-sync") return `${prefix} yeni rarityler kaydediliyor`;
    if (endpoint === "formation") return "Formation bilgileri yükleniyor";
    if (endpoint === "sbc") return `${prefix} SBC kayıtları yükleniyor`;
    if (endpoint === "sbccategory") return `${prefix} SBC kategorileri yükleniyor`;
    if (endpoint === "sbc/tile-sync") return `${prefix} yeni SBC kayıtları kaydediliyor`;
    if (endpoint === "sbc/sync-screen-data-by-category") return `${prefix} SBC ekran verileri kaydediliyor`;
    return fallback || `${method} ${endpoint}`;
  }

  if (isEaPage()) {
    window.FutbinSyncWebAppLog("INIT", "Web App Sync action dosyası yüklendi.", {
      url: location.href,
      readyState: document.readyState
    });
  }

  actions["web-app-sync"] = {
    defaultTitle: "Web App Sync",
    logTitle: "WEB APP SYNC LOGS",
    statLabel: "Web App",
    hasSyncContent: true,
    stateForView: (state) => state.runs?.["web-app-sync"] || state,
    jobMatches: (job) => job?.operation === "web-app-sync",
    entryMatches: (entry) => entry?.runnerId === "web-app-sync" || entry?.job?.operation === "web-app-sync",
    saveResultMatches: (key) => String(key).startsWith("web-app-sync"),
    currentPlayers(state) {
      const snapshot = state.currentPlayers?.["web-app-sync"];
      return (Number(snapshot?.raritySync?.savedCount) || 0) +
        (Number(snapshot?.sbcSync?.savedCount) || 0);
    },
    skippedCount(state) {
      return Object.entries(state.clubSaveResults || {})
        .filter(([key]) => this.saveResultMatches(key))
        .reduce((total, [, result]) => total + (Number(result?.skipped) || 0), 0);
    },
    currentJobLabel({ activeJob, viewState, currentJobNumber, totalJobs }) {
      if (activeJob) return activeJob.label || "EA Web App";
      if (!viewState.running || !totalJobs) return "İş bekleniyor";
      return currentJobNumber >= totalJobs ? "Bu sekme tamamlandı" : "Sırada bekliyor";
    },
    renderRecords({ records, errors, state, elements, helpers }) {
      const webAppRecords = records.filter((record) => this.entryMatches(record));
      const webAppErrors = errors.filter((entry) => this.entryMatches(entry));
      elements.records.innerHTML = helpers.renderCycleGroups(webAppRecords, webAppErrors, state, (cycleRecords, cycleErrors) =>
        renderWebAppRecords(cycleRecords, cycleErrors, helpers)) ||
        '<div class="empty">Bu sekmede henüz Web App Sync verisi yok.</div>';
    },
    modalHandler: createEaModalHandler()
  };

  if (isEaPage()) {
    window.FutbinSyncWebAppLog("MODAL", "EA sayfası algılandı; modal watcher başlatılıyor.");
    startEaModalMonitoring(actions["web-app-sync"].modalHandler);
  }

  function createEaModalHandler() {
    const lastClickAt = new WeakMap();
    let monitoring = false;

    return {
      modals: [
        {
          name: "livemessage",
          buttonSelector: ".view-modal-container.form-modal .ut-livemessage-footer > button:nth-child(2)"
        },
        {
          name: "ea-alert",
          containerSelector: ".view-modal-container.form-modal .ea-dialog-view-type--alert",
          buttonSelector: ".ut-st-button-group button, button.btn-standard"
        }
      ],
      async monitorModals() {
        if (monitoring) return;
        monitoring = true;
        try {
          let detectedButtonCount = 0;
          for (const modal of this.modals) {
            const buttons = findModalButtons(modal);
            detectedButtonCount += buttons.length;
            for (const button of buttons) {
              if (!isSafeModalButton(button, modal)) continue;
              if (Date.now() - (lastClickAt.get(button) || 0) < 1500) continue;
              lastClickAt.set(button, Date.now());
              window.FutbinSyncWebAppLog("MODAL", `"${modal.name}" modalı kapatılıyor.`, {
                buttonText: normalizeModalText(button.textContent),
                buttonClass: button.className
              });
              await clickModalButton(button);
            }
          }
          if (detectedButtonCount) {
            window.FutbinSyncWebAppLog("MODAL", "Modal taraması tamamlandı.", {
              detectedButtonCount
            });
          }
        } finally {
          monitoring = false;
        }
      },
      startMonitoring() {
        if (this.observer || !document.body) return;

        this.observer = new MutationObserver(() => {
          this.monitorModals();
        });
        this.observer.observe(document.body, {
          childList: true,
          subtree: true
        });
        this.intervalId = window.setInterval(() => {
          this.monitorModals();
        }, 500);
        this.monitorModals();
        window.FutbinSyncWebAppLog("MODAL", "Modal izleme aktif.", {
          observer: "MutationObserver",
          fallbackIntervalMs: 500,
          registeredModals: this.modals.map((modal) => modal.name)
        });
      },
      stopMonitoring() {
        this.observer?.disconnect();
        this.observer = null;
        if (this.intervalId) window.clearInterval(this.intervalId);
        this.intervalId = null;
        window.FutbinSyncWebAppLog("MODAL", "Modal izleme durduruldu.");
      }
    };
  }

  function startEaModalMonitoring(handler) {
    const start = () => handler.startMonitoring();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  function findModalButtons(modal) {
    if (!modal.containerSelector) {
      return [...document.querySelectorAll(modal.buttonSelector)];
    }
    return [...document.querySelectorAll(modal.containerSelector)]
      .flatMap((container) => [...container.querySelectorAll(modal.buttonSelector)]);
  }

  function isSafeModalButton(button, modal) {
    if (!button || button.disabled || button.offsetParent === null) return false;
    if (modal.name === "livemessage") return true;

    const container = button.closest(".ea-dialog-view-type--alert");
    if (!container) return false;
    const buttons = [...container.querySelectorAll("button")].filter((item) => !item.disabled);
    const text = normalizeModalText(button.textContent);
    const safeLabels = ["ok", "okay", "tamam", "continue", "devam", "close", "kapat"];
    return buttons.length === 1 || safeLabels.includes(text);
  }

  async function clickModalButton(button) {
    window.FutbinSyncWebAppLog("MODAL", "Modal butonu tıklama eventleri gönderiliyor.");
    button.scrollIntoView({ block: "center", inline: "nearest" });
    button.focus();
    for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    window.FutbinSyncWebAppLog("MODAL", "Modal butonu tıklama işlemi tamamlandı.");
  }

  function normalizeModalText(value) {
    return String(value || "").trim().toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");
  }

  function isEaPage() {
    return location.hostname === "signin.ea.com" ||
      (location.hostname === "www.ea.com" && location.pathname.includes("/ultimate-team/web-app"));
  }

  function removeLegacyWebAppUi() {
    [
      "futbin-sync-webapp-toast-container",
      "futbin-sync-webapp-toast-style",
      "futbin-sync-api-loader",
      "futbin-sync-api-loader-style"
    ].forEach((id) => document.getElementById(id)?.remove());
  }

  function renderWebAppRecords(records, errors = [], helpers) {
    const rows = [
      renderWebAppHeader(),
      ...errors.map((entry) => helpers.renderErrorRecord(entry)),
      ...records.map((record) => renderWebAppRecord(record, helpers))
    ];
    return `<div class="sync-player-group web-app-sync-group">${rows.join("")}</div>`;
  }

  function renderWebAppHeader() {
    return `<div class="club-player-header sync-header web-app-sync-header">
      <span>LANG</span><span>RARITY</span><span>SBC</span><span>SKIPPED</span><span>POST</span>
    </div>`;
  }

  function renderWebAppRecord(record, helpers) {
    const snapshot = record.player || {};
    const raritySync = snapshot.raritySync || {};
    const sbcSync = snapshot.sbcSync || {};
    const activeLangs = String(raritySync.lang || "en").split(",").map((lang) => lang.trim()).filter(Boolean);
    const rarityNames = (Array.isArray(raritySync.rarities) ? raritySync.rarities : [])
      .map((rarity) => {
        const name = rarity?.name && typeof rarity.name === "object" ? rarity.name : {};
        return activeLangs.map((lang) => name[lang]).find(Boolean) || Object.values(name).find(Boolean);
      })
      .filter(Boolean)
      .join(", ") || "Yeni kayıt yok";
    const skipped = (Number(raritySync.skippedExisting) || 0) +
      (Number(raritySync.skippedPlaceholder) || 0) +
      (Number(sbcSync.skippedCount) || 0);
    const sbcText = `${Number(sbcSync.savedCount) || 0}/${Number(sbcSync.tileCount) || 0}`;
    const postText = record.saveStatus || "okundu";

    return `<article class="player-data-row sync-row web-app-sync-row" title="${helpers.escapeHtml(snapshot.sourceUrl || "")}">
      ${helpers.cell(sbcSync.lang || raritySync.lang || snapshot.loadedElement?.text || "en", "position-cell")}
      ${helpers.cell(rarityNames, "player-cell")}
      ${helpers.cell(sbcText, "rating-cell")}
      ${helpers.cell(skipped, "league-cell")}
      ${helpers.cell(postText, "club-cell")}
    </article>`;
  }
})();
