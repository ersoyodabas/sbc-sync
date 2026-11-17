// Dashboard watchdog.
//
// The dashboard (index.html) is a long-lived tab. After days of running Chrome can kill its renderer ("Aw, Snap!
// Error code: 9", usually memory) and a crashed page cannot reload itself. The service worker is the only part that is
// still alive, so it pings the dashboard tab every minute and reloads it after WATCHDOG_MAX_FAILURES silent pings.
// The sync itself lives in this service worker and chrome.storage, so a dashboard reload never interrupts a run.
export const WATCHDOG_ALARM = "fc-sync-dashboard-watchdog";
export const WATCHDOG_PERIOD_MINUTES = 1;
export const WATCHDOG_MAX_FAILURES = 2;
export const WATCHDOG_PING_TIMEOUT_MS = 8000;
export const DASHBOARD_PING = { futbinSyncModule: "fc-sync-dashboard", type: "PING" };
const FAILURES_KEY = "fcSyncDashboardPingFailures";

// Failure counters survive service-worker restarts through storage.session (falls back to memory).
const memoryFailures = {};
const failureStore = () => chrome.storage.session || null;

async function readFailures() {
  try {
    const stored = await failureStore()?.get(FAILURES_KEY);
    return stored?.[FAILURES_KEY] || { ...memoryFailures };
  } catch {
    return { ...memoryFailures };
  }
}

async function writeFailures(failures) {
  Object.keys(memoryFailures).forEach((key) => delete memoryFailures[key]);
  Object.assign(memoryFailures, failures);
  try {
    await failureStore()?.set({ [FAILURES_KEY]: failures });
  } catch {
    // memory copy is enough
  }
}

async function dashboardTabs() {
  const dashboardUrl = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => typeof tab.url === "string" && tab.url.split(/[?#]/)[0] === dashboardUrl);
}

function ping(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), WATCHDOG_PING_TIMEOUT_MS);
    let request;
    try {
      request = chrome.tabs.sendMessage(tabId, DASHBOARD_PING);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    Promise.resolve(request).then(
      (response) => { clearTimeout(timer); resolve(response?.ok === true); },
      () => { clearTimeout(timer); resolve(false); }
    );
  });
}

export async function checkDashboardTabs() {
  const tabs = await dashboardTabs();
  const previous = await readFailures();
  const next = {};
  for (const tab of tabs) {
    // A discarded tab is parked on purpose and a loading one is mid-reload: neither is a crash.
    if (tab.discarded || tab.status === "loading") continue;
    if (await ping(tab.id)) continue;
    const failures = (previous[tab.id] || 0) + 1;
    if (failures >= WATCHDOG_MAX_FAILURES) {
      try {
        await chrome.tabs.reload(tab.id);
      } catch {
        // tab went away between query and reload
      }
      continue;
    }
    next[tab.id] = failures;
  }
  await writeFailures(next);
}

export async function startWatchdog() {
  // The watchdog must never be able to stop the service worker from booting.
  try {
    const existing = await chrome.alarms.get(WATCHDOG_ALARM);
    if (!existing) await chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: WATCHDOG_PERIOD_MINUTES, periodInMinutes: WATCHDOG_PERIOD_MINUTES });
  } catch (error) {
    console.warn("Dashboard watchdog kurulamadı:", error);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) void checkDashboardTabs();
});
// Alarms persist across service-worker restarts, but re-assert it on every worker start in case it was cleared.
void startWatchdog();
