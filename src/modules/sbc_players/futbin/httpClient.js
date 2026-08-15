import { futbinFailure, futbinSuccess } from "./response.js";
import { FUTBIN_CHALLENGE_MAX_WAIT_MS, futbinChallengeTimeoutError, isFutbinChallengeHtml } from "../../futbin/challenge.js";

export class FutbinHttpClient {
  constructor(config, logger = null) {
    this.config = config;
    this.logger = logger;
    this.cache = new Map();
    this.activeControllers = new Set();
    this.activeTabIds = new Set();
    this.cancelSerial = 0;
    this.tabQueue = Promise.resolve();
  }

  async get(endpoint, queryParameters = {}, useCache = true) {
    return this.send({ method: "GET", endpoint, queryParameters }, useCache);
  }

  async post(endpoint, body, queryParameters = {}, contentType = "application/json", useCache = false) {
    return this.send({ method: "POST", endpoint, queryParameters, body, contentType }, useCache);
  }

  clearCache(endpoint = null) {
    if (!endpoint) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(endpoint)) this.cache.delete(key);
    }
  }

  cancelAll(reason = "Futbin request cancelled") {
    this.cancelSerial += 1;
    for (const controller of this.activeControllers) {
      try { controller.abort(reason); } catch { /* Request zaten kapanmis olabilir. */ }
    }
    this.activeControllers.clear();
    for (const tabId of this.activeTabIds) {
      try { chrome.tabs.remove(tabId); } catch { /* Sekme zaten kapanmis olabilir. */ }
    }
    this.activeTabIds.clear();
  }

  getCacheStats() {
    const entries = [...this.cache.values()];
    return {
      entryCount: entries.length,
      sizeBytes: entries.reduce((sum, item) => sum + (item.response.rawContent?.length || 0), 0),
      oldestEntry: entries.length ? Math.min(...entries.map((item) => item.timestamp)) : null,
      newestEntry: entries.length ? Math.max(...entries.map((item) => item.timestamp)) : null
    };
  }

  async send(request, useCache = true) {
    const sendCancelSerial = this.cancelSerial;
    const url = this.buildUrl(request.endpoint, request.queryParameters);
    const cacheKey = this.buildCacheKey(request.endpoint, request.queryParameters);
    if (useCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      const ageMinutes = (Date.now() - cached.timestamp) / 60000;
      if (ageMinutes < this.config.cacheDurationMinutes) return cached.response;
      this.cache.delete(cacheKey);
    }

    if ((request.method || "GET").toUpperCase() === "GET") {
      const response = await this.sendViaBrowserTab(request, url, cacheKey, useCache, sendCancelSerial);
      return response;
    }

    let lastResponse = null;
    let lastError = null;
    const maxRetries = Math.max(1, Number(this.config.maxRetries) || 1);
    for (let attempt = 1; attempt <= maxRetries;) {
      if (sendCancelSerial !== this.cancelSerial) {
        return futbinFailure("Futbin request cancelled", 0, null, 0, url);
      }
      const startedAt = performance.now();
      const controller = new AbortController();
      this.activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), Math.max(1, this.config.timeoutSeconds) * 1000);
      try {
        this.logger?.info?.(`Futbin ${request.method} ${url}`, { attempt, maxRetries });
        const response = await fetch(url, {
          method: request.method || "GET",
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
          headers: this.buildHeaders(request),
          body: request.method === "POST" ? request.body : undefined
        });
        this.logger?.info?.(`Futbin response headers alındı`, {
          url,
          status: response.status,
          ok: response.ok,
          attempt
        });
        const rawContent = await response.text();
        const elapsed = Math.round(performance.now() - startedAt);
        const headers = Object.fromEntries([...response.headers.entries()]);
        this.logger?.info?.(`Futbin response body okundu`, {
          url,
          status: response.status,
          ok: response.ok,
          elapsedMilliseconds: elapsed,
          contentLength: String(rawContent || "").length,
          contentType: headers["content-type"] || null
        });
        if (response.ok) {
          lastResponse = futbinSuccess(rawContent, response.status, rawContent, elapsed, url, headers);
          if (useCache) this.cache.set(cacheKey, { timestamp: Date.now(), response: lastResponse });
          await this.cooldownAfterRequest(url, sendCancelSerial);
          return lastResponse;
        }
        lastResponse = futbinFailure(`HTTP ${response.status} from Futbin`, response.status, rawContent, elapsed, url);
        if (this.isTimeoutStatus(response.status)) {
          this.logger?.warning?.("Futbin timeout status aldı; 5 saniye sonra aynı istek tekrar denenecek.", {
            url,
            status: response.status,
            waitMs: 5000,
            attempt
          });
          await delay(5000);
          continue;
        }
        await this.cooldownAfterRequest(url, sendCancelSerial);
        if (!this.shouldRetryStatus(response.status) || attempt >= maxRetries) return lastResponse;
      } catch (error) {
        lastError = error;
        const elapsed = Math.round(performance.now() - startedAt);
        const isTimeout = error?.name === "AbortError";
        lastResponse = futbinFailure(isTimeout ? `Futbin request timeout (${this.config.timeoutSeconds} sn)` : error?.message, 0, null, elapsed, url, error);
        this.logger?.warning?.(`Futbin request hata/timeout`, {
          url,
          attempt,
          maxRetries: isTimeout ? "timeout-success-until-stopped" : maxRetries,
          elapsedMilliseconds: elapsed,
          timeoutSeconds: this.config.timeoutSeconds,
          errorName: error?.name || null,
          errorMessage: error?.message || String(error)
        });
        if (sendCancelSerial !== this.cancelSerial) return lastResponse;
        if (isTimeout) {
          this.logger?.warning?.("Futbin timeout alındı; 5 saniye sonra aynı istek tekrar denenecek.", {
            url,
            waitMs: 5000,
            attempt
          });
          await delay(5000);
          continue;
        }
        if (attempt >= maxRetries) return lastResponse;
        await this.cooldownAfterRequest(url, sendCancelSerial);
      } finally {
        clearTimeout(timeout);
        this.activeControllers.delete(controller);
      }
      await delay(this.retryDelay(attempt));
      attempt += 1;
    }
    return lastResponse || futbinFailure(lastError?.message || "Futbin request failed", 0, null, 0, url, lastError);
  }

  async sendViaBrowserTab(request, url, cacheKey, useCache, sendCancelSerial) {
    let attempt = 1;
    while (true) {
      if (sendCancelSerial !== this.cancelSerial) {
        return futbinFailure("Futbin browser navigation cancelled", 0, null, 0, url);
      }
      const startedAt = performance.now();
      try {
        this.logger?.info?.("Futbin browser tab navigasyonu başlıyor", { url, attempt });
        const rawContent = await this.enqueueTabNavigation(url, sendCancelSerial);
        const elapsed = Math.round(performance.now() - startedAt);
        const response = futbinSuccess(rawContent, 200, rawContent, elapsed, url, {
          "x-sbcmonster-source": "browser-tab"
        });
        this.logger?.info?.("Futbin browser tab HTML okundu", {
          url,
          attempt,
          elapsedMilliseconds: elapsed,
          contentLength: String(rawContent || "").length
        });
        if (useCache) this.cache.set(cacheKey, { timestamp: Date.now(), response });
        return response;
      } catch (error) {
        const elapsed = Math.round(performance.now() - startedAt);
        if (sendCancelSerial !== this.cancelSerial) {
          return futbinFailure("Futbin browser navigation cancelled", 0, null, elapsed, url, error);
        }
        this.logger?.warning?.("Futbin browser tab hata/timeout aldı; 5 saniye sonra aynı URL tekrar denenecek.", {
          url,
          attempt,
          elapsedMilliseconds: elapsed,
          errorName: error?.name || null,
          errorMessage: error?.message || String(error),
          waitMs: 5000
        });
        await delay(5000);
        attempt += 1;
      }
    }
  }

  enqueueTabNavigation(url, sendCancelSerial) {
    const run = () => this.readHtmlWithBrowserTab(url, sendCancelSerial);
    const queued = this.tabQueue.then(run, run);
    this.tabQueue = queued.catch(() => {});
    return queued;
  }

  async readHtmlWithBrowserTab(url, sendCancelSerial) {
    if (sendCancelSerial !== this.cancelSerial) throw new Error("Futbin browser navigation cancelled");
    const tab = await chrome.tabs.create({ url, active: false });
    const tabId = tab.id;
    if (!tabId) throw new Error(`Futbin sekmesi oluşturulamadı: ${url}`);
    this.logger?.info?.("Futbin sekmesi açıldı", { url, tabId });
    this.activeTabIds.add(tabId);
    try {
      this.logger?.info?.("Futbin hedef DOM polling başladı; page complete beklenmeyecek.", { url, tabId, maxWaitMs: Math.max(60000, Number(this.config.tabNavigationTimeoutMs) || 60000) });
      if (sendCancelSerial !== this.cancelSerial) throw new Error("Futbin browser navigation cancelled");
      const html = await this.waitForReadableFutbinHtml(tabId, url, sendCancelSerial);
      if (!html || html.length < 1000) throw new Error(`Futbin tab HTML yanıtı geçersiz: ${url}`);
      this.logger?.info?.("Futbin hedef HTML hazır; sekme kapatılacak", {
        url,
        tabId,
        contentLength: String(html || "").length
      });
      return html;
    } finally {
      this.activeTabIds.delete(tabId);
      this.logger?.info?.("Futbin sekmesi kapatılıyor", { url, tabId });
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }

  async readTabOuterHtml(tabId, url) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML
    });
    const html = results?.[0]?.result || "";
    this.logger?.info?.("Futbin tab outerHTML okundu", {
      url,
      tabId,
      contentLength: String(html || "").length
    });
    return html;
  }

  async waitForReadableFutbinHtml(tabId, url, sendCancelSerial) {
    const targetDomTimeoutMs = Math.max(60000, Number(this.config.tabNavigationTimeoutMs) || 60000);
    const startedAt = Date.now();
    let deadline = startedAt + targetDomTimeoutMs;
    let lastHtml = "";
    let lastError = null;
    let challengeLogged = false;
    let challengeDetectedAt = null;
    while (Date.now() < deadline) {
      if (sendCancelSerial !== this.cancelSerial) throw new Error("Futbin browser navigation cancelled");
      try {
        lastHtml = await this.readTabOuterHtml(tabId, url);
        lastError = null;
      } catch (error) {
        lastError = error;
        await delay(250);
        continue;
      }
      const status = futbinHtmlReadiness(lastHtml);
      if (status.ready) {
        if (challengeLogged) await this.notifyChallengeState({ resolved: true });
        this.logger?.info?.("Futbin hedef DOM okundu", {
          url,
          tabId,
          contentLength: String(lastHtml || "").length,
          targetDomReady: status.targetDomReady
        });
        return lastHtml;
      }
      if (status.cloudflare && !challengeLogged) {
        challengeLogged = true;
        challengeDetectedAt = Date.now();
        deadline = challengeDetectedAt + FUTBIN_CHALLENGE_MAX_WAIT_MS;
        await this.focusChallengeTab(tabId);
        await this.notifyChallengeState({ waiting: true, tabId, url, detectedAt: challengeDetectedAt });
        this.logger?.info?.(`Futbin Cloudflare doğrulaması algılandı; açık sekmede doğrulama bekleniyor · ${url}`, {
          url,
          tabId,
          maxWaitMs: FUTBIN_CHALLENGE_MAX_WAIT_MS
        });
      }
      await delay(250);
    }
    const status = futbinHtmlReadiness(lastHtml);
    if (challengeLogged) await this.notifyChallengeState({ waiting: false });
    if (lastError && !lastHtml) throw lastError;
    throw new Error(status.cloudflare
      ? futbinChallengeTimeoutError(url)
      : `Futbin hedef HTML ${Math.round(targetDomTimeoutMs / 1000)} saniye içinde okunamadı: ${url}`);
  }

  async focusChallengeTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (error) {
      this.logger?.warning?.("Futbin doğrulama sekmesi öne getirilemedi", { tabId, error: error.message || String(error) });
    }
  }

  async notifyChallengeState(details) {
    if (typeof this.config.onChallengeStateChange !== "function") return;
    try {
      await this.config.onChallengeStateChange(details);
    } catch (error) {
      this.logger?.warning?.("Futbin doğrulama durumu güncellenemedi", { error: error.message || String(error) });
    }
  }

  buildUrl(endpoint, queryParameters = {}) {
    const base = this.config.baseUrl || "https://futbin.com";
    const url = new URL(endpoint, base);
    Object.entries(queryParameters || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    return url.href;
  }

  buildCacheKey(endpoint, queryParameters = {}) {
    const params = Object.entries(queryParameters || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    return params ? `${endpoint}?${params}` : endpoint;
  }

  buildHeaders(request) {
    const headers = {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
      "Accept-Language": this.config.acceptLanguage,
      "Upgrade-Insecure-Requests": "1"
    };
    if (request.method === "POST") headers["Content-Type"] = request.contentType || "application/json";
    return headers;
  }

  retryDelay(attempt) {
    const base = Number(this.config.retryDelayMs) || 1000;
    const jitterMin = Number(this.config.minDelayMs) || 0;
    const jitterMax = Math.max(jitterMin, Number(this.config.maxDelayMs) || jitterMin);
    return base * attempt + Math.round(jitterMin + Math.random() * (jitterMax - jitterMin));
  }

  shouldRetryStatus(status) {
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  isTimeoutStatus(status) {
    return status === 408 || status === 504 || status === 524;
  }

  async cooldownAfterRequest(url, sendCancelSerial) {
    const waitMs = Math.max(0, Number(this.config.requestCooldownMs) || 0);
    if (!waitMs || sendCancelSerial !== this.cancelSerial) return;
    this.logger?.info?.("Futbin request sonrası 5 saniye bekleniyor.", { url, waitMs });
    await delay(waitMs);
  }
}

function futbinHtmlReadiness(html) {
  const text = String(html || "");
  const cloudflare = isFutbinChallengeHtml(text);
  const targetDomReady = /table[^>]+class=["'][^"']*players-table|tr[^>]+class=["'][^"']*player-row|class=["'][^"']*table-player-name|class=["'][^"']*challenges-wrapper|href=["'][^"']*(squad-building-challenge|squad-building-challenges|\/squad\/)[^"']*["']|playerName|resourceId|lineup|starters|formation|completed challenges/i.test(text);
  return {
    cloudflare,
    targetDomReady,
    ready: targetDomReady
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
