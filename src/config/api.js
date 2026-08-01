(function (global) {
  let envCache = null;
  let readyPromise = null;
  let apiBaseUrl = "";
  let configurationError = null;
  const DEFAULT_WAIT_MS = 5000;

  function parseEnv(text) {
    const values = {};
    String(text || "").split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separator = trimmed.indexOf("=");
      if (separator < 0) return;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) values[key] = value;
    });
    return values;
  }

  function envUrl() {
    try {
      return global.chrome?.runtime?.getURL ? global.chrome.runtime.getURL(".env") : null;
    } catch {
      return null;
    }
  }

  function loadSync() {
    if (envCache) return envCache;
    const url = envUrl();
    if (!url || typeof XMLHttpRequest === "undefined") {
      return envCache || {};
    }
    try {
      const request = new XMLHttpRequest();
      request.open("GET", `${url}?t=${Date.now()}`, false);
      request.send(null);
      envCache = request.status >= 200 && request.status < 300 ? parseEnv(request.responseText) : {};
    } catch {
      envCache = {};
    }
    return envCache;
  }

  async function load() {
    if (envCache) return envCache;
    const url = envUrl();
    if (!url) {
      throw new Error("Chrome extension .env kaynağı bulunamadı.");
    }
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`.env yüklenemedi (HTTP ${response.status}).`);
    envCache = parseEnv(await response.text());
    apiBaseUrl = requireApiBaseUrl(envCache.API_BASE_URL);
    return envCache;
  }

  function env() {
    return envCache || loadSync();
  }

  function get(key, fallback = "") {
    const value = env()[key];
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  function number(key, fallback) {
    const value = Number(get(key));
    return Number.isFinite(value) ? value : fallback;
  }

  function normalizeBaseUrl(value) {
    try {
      const url = new URL(value);
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function requireApiBaseUrl(value) {
    const normalized = normalizeBaseUrl(value);
    if (!normalized) throw new Error("API_BASE_URL .env dosyasında tanımlı ve mutlak bir URL olmalıdır.");
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("API_BASE_URL yalnız HTTP veya HTTPS kullanabilir.");
    }
    if (!url.pathname.endsWith("/api/")) {
      throw new Error("API_BASE_URL /api/ ile bitmelidir.");
    }
    return url.href;
  }

  function configuredBaseUrl() {
    if (configurationError) throw configurationError;
    return apiBaseUrl;
  }

  function baseUrlFor(environment) {
    void environment;
    return configuredBaseUrl();
  }

  function defaultBaseUrl() {
    return configuredBaseUrl();
  }

  function allowedBaseUrl(value) {
    void value;
    return configuredBaseUrl();
  }

  readyPromise = load().catch((error) => {
    configurationError = error;
    console.error("[CONFIG] API_BASE_URL yüklenemedi:", error);
    throw error;
  });

  global.FutbinSyncApiConfig = Object.freeze({
    ready: readyPromise,
    load,
    get,
    number,
    defaultBaseUrl,
    baseUrlFor,
    normalizeBaseUrl,
    allowedBaseUrl,
    defaultWaitMs: () => DEFAULT_WAIT_MS,
    isLocal: () => new URL(configuredBaseUrl()).hostname === "localhost",
    isProduction: () => new URL(configuredBaseUrl()).hostname === "api.sbcmonster.com"
  });
})(globalThis);
