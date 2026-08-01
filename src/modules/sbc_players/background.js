import { createFutbinConfig } from "./futbin/config.js";
import { createFutbinLogger } from "./futbin/logger.js";
import { createFutbinSbcService } from "./futbin/sbcService.js";

const STATE_KEY = "sbcPlayersSyncState";
const LOGS_KEY = "sbcPlayersSyncLogs";
const ERRORS_KEY = "sbcPlayersSyncErrors";
const MAX_LOGS = 200;
const MAX_ERRORS = 100;
const API_REQUEST_TIMEOUT_MS = 30000;
const API_TIMEOUT_RETRY_MS = 5000;
const SCHEDULE_ALARM = "sbc-players-sync-schedule";
const API_CONFIG = globalThis.FutbinSyncApiConfig;
const futbinLogger = createFutbinLogger("SbcPlayersFutbin", (level, message, details) => appendLog(`Futbin: ${message}`, {
  level,
  ...(details && typeof details === "object" ? details : { details })
}));
const futbinSbcService = createFutbinSbcService({
  config: createFutbinConfig(),
  logger: futbinLogger
});
let activeRunToken = 0;
const activeApiControllers = new Set();
let playerLookupCache = {
  loadedAt: 0,
  apiBaseUrl: "",
  qualities: [],
  rarities: [],
  positions: []
};

const emptyState = {
  running: false,
  queue: [],
  currentJobIndex: -1,
  currentUrl: null,
  apiBaseUrl: "",
  waitMs: 5000,
  allSbcCount: 0,
  missingSbcCount: 0,
  processedSbcCount: 0,
  matchedPlayerCount: 0,
  savedPlayerCount: 0,
  skippedPlayerCount: 0,
  runCount: 0,
  batchActive: false,
  batchRunIndex: 0,
  batchMaxRuns: 0,
  batchIntervalMinutes: 0,
  status: "Hazır",
  error: null,
  nextRunAt: null,
  scheduleTime: null,
  checkIntervalMinutes: null,
  startedAt: null,
  completedAt: null,
  updatedAt: null,
  pausedFutbinModules: [],
  futbinModulesResumeCompleted: false
};

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get([STATE_KEY, LOGS_KEY, ERRORS_KEY]);
  if (!saved[STATE_KEY]) await setState(emptyState);
  if (!saved[LOGS_KEY]) await chrome.storage.local.set({ [LOGS_KEY]: [] });
  if (!saved[ERRORS_KEY]) await chrome.storage.local.set({ [ERRORS_KEY]: [] });
});

chrome.runtime.onStartup.addListener(async () => {
  await API_CONFIG.ready;
  const state = await getState();
  if (state.running) {
    await setState({
      ...state,
      running: false,
      status: "Yarım kalan SBC Players çalışması durduruldu; yeniden başlatılabilir.",
      updatedAt: Date.now()
    });
    return;
  }
  if (state.nextRunAt) {
    await scheduleStoredNextRun(state);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SCHEDULE_ALARM) return;
  await API_CONFIG.ready;
  const state = await getState();
  if (state.running) return;
  await appendLog("Zamanlanmış SBC Players çalışması başlıyor.", {
    scheduledFor: state.nextRunAt ? new Date(Number(state.nextRunAt)).toISOString() : null,
    scheduleTime: state.scheduleTime || null,
    checkIntervalMinutes: state.checkIntervalMinutes || null
  });
  await startSync({
    apiBaseUrl: state.apiBaseUrl || API_CONFIG.defaultBaseUrl(),
    waitMs: state.waitMs || API_CONFIG.number("WAIT_MS", 5000),
    scheduled: true,
    batchMode: state.batchActive === true,
    batchRunIndex: state.batchActive ? Number(state.batchRunIndex) + 1 : 0,
    batchMaxRuns: state.batchMaxRuns,
    batchIntervalMinutes: state.batchIntervalMinutes
  });
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.futbinSyncModule !== "sbc_players") return false;
  handleMessage(message)
    .then(respond)
    .catch(async (error) => {
      await appendError(error.message || String(error), { type: message?.type });
      respond({ ok: false, error: error.message || String(error) });
    });
  return true;
});

globalThis.FutbinSyncModuleControls = globalThis.FutbinSyncModuleControls || {};
globalThis.FutbinSyncModuleControls.sbcPlayers = {
  startWebAppBatch: async () => {
    await API_CONFIG.ready;
    const current = await getState();
    if (current.running || current.nextRunAt) {
      await stopSync("Web App Sync tamamlandı; mevcut SBC Players planı yeni batch ile değiştiriliyor.");
    }
    return startSync({
      batchMode: true,
      batchRunIndex: 1,
      batchMaxRuns: 5,
      batchIntervalMinutes: 10,
      waitMs: API_CONFIG.number("WAIT_MS", 5000)
    });
  },
  getSnapshot: async () => ({ ok: true, state: await getState() })
};

async function handleMessage(message) {
  await API_CONFIG.ready;
  switch (message?.type) {
    case "GET_SNAPSHOT":
      return {
        ok: true,
        [STATE_KEY]: await getState(),
        [LOGS_KEY]: await getLogs(),
        [ERRORS_KEY]: await getErrors()
      };
    case "START_SYNC":
      return startSync(message);
    case "STOP_SYNC":
      return stopSync("Durduruldu.");
    case "CLEAR_SYNC":
      {
        const stateBeforeClear = await getState();
        await cancelActiveRun("Temizlendi.");
        await chrome.alarms.clear(SCHEDULE_ALARM);
        await setState({ ...emptyState, apiBaseUrl: normalizeApiBaseUrl(message.apiBaseUrl) });
        await chrome.storage.local.set({ [LOGS_KEY]: [], [ERRORS_KEY]: [] });
        await resumePausedFutbinModules(stateBeforeClear.pausedFutbinModules || []);
      }
      return { ok: true };
    default:
      return { ok: false, error: "Bilinmeyen mesaj" };
  }
}

async function startSync(message = {}) {
  const current = await getState();
  if (current.running) return { ok: true, state: current, alreadyRunning: true };
  const pausedFutbinModules = await pauseActiveFutbinModulesForSbcPlayers();
  await chrome.alarms.clear(SCHEDULE_ALARM);
  const runToken = ++activeRunToken;
  const scheduleConfig = getScheduleConfig();
  const batchActive = message.batchMode === true;
  const batchMaxRuns = batchActive ? Math.max(1, Number(message.batchMaxRuns) || 5) : 0;
  const batchRunIndex = batchActive
    ? Math.min(batchMaxRuns, Math.max(1, Number(message.batchRunIndex) || 1))
    : 0;
  const batchIntervalMinutes = batchActive
    ? Math.max(1, Number(message.batchIntervalMinutes) || 10)
    : 0;

  const state = {
    ...emptyState,
    running: true,
    apiBaseUrl: normalizeApiBaseUrl(message.apiBaseUrl),
    waitMs: Math.min(30000, Math.max(1000, Number(message.waitMs) || 5000)),
    runToken,
    runCount: (Number(current.runCount) || 0) + 1,
    batchActive,
    batchRunIndex,
    batchMaxRuns,
    batchIntervalMinutes,
    startedAt: Date.now(),
    nextRunAt: null,
    scheduleTime: scheduleConfig.timeText,
    checkIntervalMinutes: scheduleConfig.checkIntervalMinutes,
    status: "SBC Players altyapısı hazır. Senaryo bekleniyor.",
    updatedAt: Date.now(),
    pausedFutbinModules,
    futbinModulesResumeCompleted: false
  };
  try {
    await setState(state);
    await appendLog("Altyapı başlatıldı; eksik SBC kayıtları için iş listesi hazırlanacak.", {
      apiBaseUrl: state.apiBaseUrl,
      waitMs: state.waitMs,
      pausedFutbinModules: pausedFutbinModules.map((entry) => entry.module)
    });
    await loadPlayerLookups(state, runToken);
    let result;
    result = await runSbcPlayersSync(state, runToken);
    if (!await isRunActive(runToken)) {
      await resumePausedFutbinModulesOnce(runToken);
      return { ok: true, stopped: true, state: await getState() };
    }

    let completed = {
      ...result,
      running: false,
      completedAt: Date.now(),
      status: result.processedSbcCount > 0 ? `${result.processedSbcCount} SBC kaydı işlendi; sync tamamlandı.` : "İşlenecek uygun SBC kaydı yok ya da endpoint senaryosu bekleniyor.",
      updatedAt: Date.now()
    };
    completed = batchActive
      ? await scheduleNextBatchRun(completed)
      : await scheduleNextRunAfterCompletion(completed, Number(result.processedSbcCount) > 0);
    await setState(completed);
    await resumePausedFutbinModulesOnce(runToken);
    return { ok: true, state: await getState() };
  } catch (error) {
    const wasActive = await isRunActive(runToken);
    if (wasActive) {
      const failedState = await getState();
      let failed = {
        ...failedState,
        running: false,
        status: error.message || String(error),
        error: error.message || String(error),
        completedAt: Date.now(),
        updatedAt: Date.now()
      };
      failed = batchActive ? await scheduleNextBatchRun(failed) : failed;
      await setState(failed);
    }
    await resumePausedFutbinModulesOnce(runToken);
    if (!wasActive) {
      return { ok: true, stopped: true, state: await getState() };
    }
    throw error;
  }
}

async function runSbcPlayersSync(state, runToken) {
  assertRunActive(runToken);
  const jobs = await loadMissingSbcPlayerJobs(state, runToken);
  assertRunActive(runToken);
  const loadedState = await getState();
  let nextState = {
    ...state,
    allSbcCount: loadedState.allSbcCount,
    queue: jobs,
    missingSbcCount: jobs.length,
    status: jobs.length ? "SBC player işi kuyruğa alındı." : "Eksik SBC player işi yok ya da endpoint senaryosu bekleniyor.",
    updatedAt: Date.now()
  };
  await setState(nextState);

  for (let index = 0; index < jobs.length; index += 1) {
    assertRunActive(runToken);
    const job = jobs[index];
    const jobDisplayName = sbcJobDisplayName(job);
    nextState = {
      ...nextState,
      currentJobIndex: index,
      currentUrl: job?.futbinUrl || job?.url || null,
      status: `${jobDisplayName} oyuncu listesi için işlemler başladı (${index + 1}/${jobs.length})`,
      updatedAt: Date.now()
    };
    await setState(nextState);
    assertRunActive(runToken);
    const players = await resolveFutbinPlayersForJob(job, nextState, runToken);
    assertRunActive(runToken);
    const saveResult = await submitSbcPlayers(job, players, nextState, runToken);
    assertRunActive(runToken);
    nextState = {
      ...nextState,
      processedSbcCount: nextState.processedSbcCount + 1,
      matchedPlayerCount: nextState.matchedPlayerCount + players.length,
      savedPlayerCount: nextState.savedPlayerCount + (Number(saveResult?.saved) || 0),
      skippedPlayerCount: nextState.skippedPlayerCount + (Number(saveResult?.skipped) || 0),
      updatedAt: Date.now()
    };
    await setState(nextState);
  }

  return nextState;
}

async function loadPlayerLookups(state, runToken) {
  const apiBaseUrl = normalizeApiBaseUrl(state.apiBaseUrl);
  const cacheAgeMs = Date.now() - Number(playerLookupCache.loadedAt || 0);
  if (playerLookupCache.apiBaseUrl === apiBaseUrl && cacheAgeMs < 10 * 60 * 1000 && playerLookupCache.qualities.length && playerLookupCache.rarities.length && playerLookupCache.positions.length) {
    await appendLog("Quality/Rarity lookup cache kullanılıyor.", {
      qualityCount: playerLookupCache.qualities.length,
      rarityCount: playerLookupCache.rarities.length,
      positionCount: playerLookupCache.positions.length
    });
    return playerLookupCache;
  }

  await appendLog("Quality, Rarity ve Position listeleri API'den alınıyor.", {
    endpoints: ["quality", "rarity", "position"]
  });
  const [qualityResponse, rarityResponse, positionResponse] = await Promise.all([
    apiRequest(apiBaseUrl, "quality", { method: "GET" }, runToken),
    apiRequest(apiBaseUrl, "rarity", { method: "GET" }, runToken),
    apiRequest(apiBaseUrl, "position", { method: "GET" }, runToken)
  ]);
  assertRunActive(runToken);
  playerLookupCache = {
    loadedAt: Date.now(),
    apiBaseUrl,
    qualities: extractApiArray(qualityResponse),
    rarities: extractApiArray(rarityResponse),
    positions: extractApiArray(positionResponse)
  };
  await appendLog("Quality, Rarity ve Position lookup listeleri hazır.", {
    qualityCount: playerLookupCache.qualities.length,
    rarityCount: playerLookupCache.rarities.length,
    positionCount: playerLookupCache.positions.length,
    qualitySamples: playerLookupCache.qualities.slice(0, 8).map((quality) => ({ id: quality.id, code: quality.code, name: localizedText(quality.name) })),
    raritySamples: playerLookupCache.rarities.slice(0, 8).map((rarity) => ({
      id: rarity.id,
      code: rarity.code,
      futbin_rarity: rarity.futbin_rarity,
      futbin_value: rarity.futbin_value,
      futbin_id: rarity.futbin_id,
      name: localizedText(rarity.name)
    })),
    positionSamples: playerLookupCache.positions.slice(0, 12).map((position) => ({ id: position.id, code: position.code, name: localizedText(position.name) }))
  });
  return playerLookupCache;
}

async function loadMissingSbcPlayerJobs(state, runToken) {
  await appendLog("API'den tüm kategorilerdeki SBC kayıtları tek istekte alınıyor.", {
    apiBaseUrl: state.apiBaseUrl,
    endpoint: "sbc/filter",
    category_id: null
  });

  const response = await apiRequest(state.apiBaseUrl, "sbc/filter", {
    method: "POST",
    body: JSON.stringify({
      category_id: null,
      lang: "en"
    })
  }, runToken);
  assertRunActive(runToken);

  const roots = Array.isArray(response?.data) ? response.data : [];
  const allRecords = flattenSbcRecords(roots);
  const baseEligibleRecords = allRecords.filter((sbc) => shouldSyncSbcPlayersBase(sbc));
  const ratingEligibleRecords = baseEligibleRecords.filter((sbc) => hasRatingRequirement(sbc));
  const eligibleJobs = allRecords
    .filter((sbc) => shouldSyncSbcPlayers(sbc))
    .map((sbc) => toSbcPlayerJob(sbc, allRecords, state))
    .filter(Boolean);
  const jobs = eligibleJobs;
  await hydrateFormationSlotsForJobs(state, jobs, runToken);

  await appendLog("SBC kayıtları alındı; tüm uygun kayıtlar işleme alınacak.", {
    rootCount: roots.length,
    allSbcCount: allRecords.length,
    baseEligibleSbcPlayerCount: baseEligibleRecords.length,
    skippedWithoutRatingReqCount: baseEligibleRecords.length - ratingEligibleRecords.length,
    eligibleSbcPlayerCount: eligibleJobs.length,
    queuedSbcPlayerCount: jobs.length,
    selectedSbc: jobs[0]
      ? {
          id: jobs[0].id,
          categoryName: jobs[0].categoryName,
          sbcName: jobs[0].sbcName,
          detailSbcName: jobs[0].detailSbcName,
          source: jobs[0].source,
          parentId: jobs[0].parent_id || null,
          icon_url: jobs[0].icon_url,
          desc: jobs[0].desc,
          formation_id: getSbcFormationId(jobs[0]),
          formationSlotCount: getFormationSlots(jobs[0]).length
        }
      : null
  });

  const current = await getState();
  await setState({
    ...current,
    allSbcCount: allRecords.length,
    missingSbcCount: jobs.length,
    updatedAt: Date.now()
  });

  return jobs;
}

async function hydrateFormationSlotsForJobs(state, jobs, runToken) {
  const missingFormationJobs = jobs.filter((job) => getSbcFormationId(job) > 0 && getFormationSlots(job).length === 0);
  if (!missingFormationJobs.length) {
    await appendLog("Formation slot verisi SBC filter response içinde hazır.", {
      queuedJobCount: jobs.length,
      hydratedNeededCount: 0
    });
    return;
  }

  await appendLog("Formation slot verisi eksik; API'den formationposition kayıtları alınıyor.", {
    endpoint: "formationposition",
    missingJobCount: missingFormationJobs.length,
    formationIds: [...new Set(missingFormationJobs.map(getSbcFormationId).filter(Boolean))]
  });

  const response = await apiRequest(state.apiBaseUrl, "formationposition", { method: "GET" }, runToken);
  assertRunActive(runToken);
  const slots = Array.isArray(response?.data) ? response.data : [];
  const slotsByFormationId = slots.reduce((map, slot) => {
    const formationId = Number(slot?.formation_id);
    if (!formationId) return map;
    if (!map.has(formationId)) map.set(formationId, []);
    map.get(formationId).push(slot);
    return map;
  }, new Map());

  missingFormationJobs.forEach((job) => {
    const formationId = getSbcFormationId(job);
    const formationSlots = (slotsByFormationId.get(formationId) || []).sort((a, b) => Number(a.index_no ?? a.id) - Number(b.index_no ?? b.id));
    if (!formationSlots.length) return;
    const formation = {
      ...(job.formation || job.sbc?.formation || {}),
      id: formationId,
      formation_slots: formationSlots
    };
    job.formation = formation;
    if (job.sbc) job.sbc.formation = formation;
  });

  await appendLog("Formation slot hydrate işlemi tamamlandı.", {
    totalFormationSlotCount: slots.length,
    hydratedJobs: missingFormationJobs.map((job) => ({
      sbcId: job.id,
      name: sbcJobDisplayName(job),
      formation_id: getSbcFormationId(job),
      formationSlotCount: getFormationSlots(job).length,
      slots: getFormationSlots(job).map((slot) => ({
        id: slot.id,
        code: slot.code,
        name: slot.name,
        position_id: slot.position_id,
        position_name: slot.position_name
      }))
    }))
  });
  const stillMissing = missingFormationJobs.filter((job) => getFormationSlots(job).length === 0);
  if (stillMissing.length) {
    await appendError("Formation slot verisi API'den alınamadı; mapleme slot eşleşmesi yapamayabilir.", {
      endpoint: "formationposition",
      missingJobs: stillMissing.map((job) => ({
        sbcId: job.id,
        name: sbcJobDisplayName(job),
        formation_id: getSbcFormationId(job)
      }))
    });
  }
}

async function resolveFutbinPlayersForJob(job, _state, runToken) {
  assertRunActive(runToken);
  const futbinJob = normalizeFutbinJob(job);
  const displayName = sbcJobDisplayName(job);
  if (!futbinJob.categoryName || !futbinJob.sbcName) {
    await appendLog("Futbin oyuncu okuma atlandı; categoryName veya sbcName eksik.", { job });
    return [];
  }

  await appendLog(`${displayName} oyuncu listesi için işlemler başladı.`, {
    ...futbinJob,
    displayName,
    source: job.source,
    sbcId: job.sbcId ?? job.id
  });
  const response = await futbinSbcService.getFullSbcDataAsync(
    futbinJob.categoryName,
    futbinJob.sbcName,
    futbinJob.detailSbcName,
    futbinJob.sbcNameIndex,
    futbinJob.matchContext
  );
  assertRunActive(runToken);

  if (!response.isSuccess) {
    await appendError(response.errorMessage || "Futbin SBC player verisi okunamadı.", {
      job,
      statusCode: response.statusCode
    });
    return [];
  }

  const players = Array.isArray(response.data?.squadPlayers) ? response.data.squadPlayers : [];
  await appendLog("Futbin SBC player verisi okundu.", {
    squadUrl: response.data?.squadUrl || null,
    playerCount: players.length,
    players: players.map((player) => ({
      name: player.name,
      rating: player.rating,
      slot: player.slot,
      position: player.position
    })).slice(0, 20)
  });
  return players.map((player, index) => ({
    ...player,
    sbcId: job?.sbcId ?? job?.sbc_id ?? job?.id ?? null,
    slot: player.slot || "",
    index: index + 1,
    squadUrl: response.data?.squadUrl || null
  }));
}

async function submitSbcPlayers(job, players, _state, runToken) {
  assertRunActive(runToken);
  if (job?.group === true || job?.sbc?.group === true) {
    await appendLog("Group SBC player sahibi olamaz; kayıt gönderimi atlandı.", {
      sbcId: job?.sbcId ?? job?.id,
      name: job?.name
    });
    return { saved: 0, skipped: players.length };
  }

  if (!Array.isArray(players) || players.length === 0) {
    await appendLog("Oyuncu bulunamadı; SBC kayıt gönderimi atlandı.", {
      sbcId: job?.sbcId ?? job?.id,
      name: job?.name
    });
    return { saved: 0, skipped: 0 };
  }

  const mappingDetails = [];
  const payload = buildSbcSavePayload(job, players, mappingDetails);
  const sourceSbc = job.sbc || job;
  const formationSlots = getFormationSlots(sourceSbc);
  const mappingLog = {
    sbcId: payload.id,
    name: sbcJobDisplayName(job),
    futbinPlayerCount: players.length,
    formationSlotCount: formationSlots.length,
    payloadPlayerCount: payload.sbc_player.length,
    formationSlots: formationSlots.map((slot) => ({
      id: slot.id,
      code: slot.code,
      name: slot.name,
      position_id: slot.position_id,
      position_name: slot.position_name,
      position: localizedText(slot.position?.name)
    })),
    mappingDetails
  };
  await appendLog("SBC player mapleme tamamlandı.", mappingLog);
  futbinLogger.info("[SbcPlayers] Mapping completed before API POST", mappingLog);
  if (!payload.sbc_player.length) {
    await appendError("SBC player mapleme sonucu boş kaldı; API'ye boş sbc_player gönderimi iptal edildi.", {
      sbcId: job?.sbcId ?? job?.id,
      name: sbcJobDisplayName(job),
      futbinPlayerCount: players.length,
      formationSlotCount: formationSlots.length,
      mappingDetails,
      samplePlayers: players.slice(0, 20).map((player) => ({
        name: player.name,
        rating: player.rating,
        slot: player.slot,
        position: player.position
      }))
    });
    await appendLog("SBC kaydı API'ye gönderilmedi; sbc_player listesi boş.", {
      sbcId: job?.sbcId ?? job?.id,
      futbinPlayerCount: players.length,
      formationSlotCount: formationSlots.length,
      mappingDetails
    });
    return { saved: 0, skipped: players.length };
  }
  await appendLog("SBC kaydı sbc_player listesiyle API'ye gönderiliyor.", {
    endpoint: "sbc",
    sbcId: payload.id,
    playerCount: payload.sbc_player.length,
    squadLink: payload.squad_link || null,
    sbcPlayers: payload.sbc_player.map(toSbcPlayerLogDto)
  });
  futbinLogger.info("[SbcPlayers] API POST payload ready", {
    endpoint: "sbc",
    sbcId: payload.id,
    playerCount: payload.sbc_player.length,
    sbcPlayers: payload.sbc_player
  });

  let response;
  try {
    response = await apiRequest(job.apiBaseUrl, "sbc", {
      method: "POST",
      headers: {
        "X-Sbc-Players-Sync": "true",
        "X-App-User-Id": "1"
      },
      body: JSON.stringify(payload)
    }, runToken);
  } catch (error) {
    const errorLog = {
      sbcId: payload.id,
      playerCount: payload.sbc_player.length,
      message: error.message || String(error),
      sbcPlayers: payload.sbc_player.map(toSbcPlayerLogDto),
      mappingDetails
    };
    await appendError("SBC player API POST hata verdi.", errorLog);
    futbinLogger.error("[SbcPlayers] API POST failed", {
      error: error.message || String(error),
      ...errorLog
    });
    throw error;
  }
  assertRunActive(runToken);

  await appendLog("SBC player listesi API'ye kaydedildi.", {
    sbcId: payload.id,
    playerCount: payload.sbc_player.length,
    message: response?.message || null,
    result: response?.result,
    responseData: response?.data || null
  });
  futbinLogger.info("[SbcPlayers] API POST success", {
    sbcId: payload.id,
    playerCount: payload.sbc_player.length,
    response
  });

  return { saved: payload.sbc_player.length, skipped: Math.max(0, players.length - payload.sbc_player.length), response };
}

async function stopSync(status = "Durduruldu.") {
  await cancelActiveRun(status);
  await chrome.alarms.clear(SCHEDULE_ALARM);
  const state = await getState();
  await setState({
    ...state,
    running: false,
    batchActive: false,
    nextRunAt: null,
    status,
    completedAt: Date.now(),
    updatedAt: Date.now()
  });
  await appendLog(status);
  await resumePausedFutbinModulesOnce();
  return { ok: true, state: await getState() };
}

async function cancelActiveRun(status = "Durduruldu.") {
  activeRunToken += 1;
  for (const controller of activeApiControllers) {
    try { controller.abort(status); } catch { /* Request zaten kapanmis olabilir. */ }
  }
  activeApiControllers.clear();
  futbinSbcService.cancel?.(status);
}

async function pauseActiveFutbinModulesForSbcPlayers() {
  const controls = globalThis.FutbinSyncModuleControls || {};
  const paused = [];
  for (const moduleName of ["important", "latest"]) {
    const control = controls[moduleName];
    if (!control?.pauseForSbcPlayers) continue;
    try {
      const response = await control.pauseForSbcPlayers();
      if (response?.paused) {
        paused.push({ module: moduleName, pausedAt: Date.now() });
        await appendLog(`${moduleDisplayName(moduleName)} SBC Players için geçici duraklatıldı.`);
      }
    } catch (error) {
      await appendError(`${moduleDisplayName(moduleName)} geçici duraklatılamadı.`, {
        module: moduleName,
        error: error.message || String(error)
      });
    }
  }
  return paused;
}

async function resumePausedFutbinModulesOnce(runToken = activeRunToken) {
  const state = await getState();
  if (runToken !== activeRunToken && state.running) return;
  if (state.futbinModulesResumeCompleted) return;
  const pausedModules = Array.isArray(state.pausedFutbinModules) ? state.pausedFutbinModules : [];
  if (!pausedModules.length) return;
  await setState({
    ...state,
    pausedFutbinModules: [],
    futbinModulesResumeCompleted: true,
    updatedAt: Date.now()
  });
  await resumePausedFutbinModules(pausedModules);
}

async function resumePausedFutbinModules(pausedModules = []) {
  const controls = globalThis.FutbinSyncModuleControls || {};
  const modules = [...new Set((Array.isArray(pausedModules) ? pausedModules : [])
    .map((entry) => entry?.module)
    .filter(Boolean))];
  for (const moduleName of modules) {
    const control = controls[moduleName];
    if (!control?.resumeAfterSbcPlayers) continue;
    try {
      const response = await control.resumeAfterSbcPlayers();
      if (response?.resumed === false && !response?.alreadyRunning) {
        await appendLog(`${moduleDisplayName(moduleName)} için resume gerekmedi.`);
      } else {
        await appendLog(`${moduleDisplayName(moduleName)} SBC Players sonrası yeniden başlatıldı.`);
      }
    } catch (error) {
      await appendError(`${moduleDisplayName(moduleName)} resume edilemedi.`, {
        module: moduleName,
        error: error.message || String(error)
      });
    }
  }
}

function moduleDisplayName(moduleName) {
  if (moduleName === "important") return "Important Players";
  if (moduleName === "latest") return "Latest Player Sync";
  return moduleName;
}

async function scheduleStoredNextRun(state) {
  const nextRunAt = Number(state.nextRunAt);
  if (!nextRunAt || Number.isNaN(nextRunAt)) return;
  if (nextRunAt <= Date.now()) {
    await appendLog("Bekleyen SBC Players zamanı geldi; çalışma başlatılıyor.", {
      nextRunAt: new Date(nextRunAt).toISOString()
    });
    await startSync({
      apiBaseUrl: state.apiBaseUrl || API_CONFIG.defaultBaseUrl(),
      waitMs: state.waitMs || API_CONFIG.number("WAIT_MS", 5000),
      scheduled: true,
      batchMode: state.batchActive === true,
      batchRunIndex: state.batchActive ? Number(state.batchRunIndex) + 1 : 0,
      batchMaxRuns: state.batchMaxRuns,
      batchIntervalMinutes: state.batchIntervalMinutes
    });
    return;
  }
  await chrome.alarms.clear(SCHEDULE_ALARM);
  await chrome.alarms.create(SCHEDULE_ALARM, { when: nextRunAt });
  await appendLog("Bekleyen SBC Players alarmı yeniden kuruldu.", {
    nextRunAt: new Date(nextRunAt).toISOString(),
    scheduleTime: state.scheduleTime || null,
    checkIntervalMinutes: state.checkIntervalMinutes || null
  });
}

async function scheduleNextBatchRun(state) {
  const runIndex = Math.max(1, Number(state.batchRunIndex) || 1);
  const maxRuns = Math.max(1, Number(state.batchMaxRuns) || 5);
  const intervalMinutes = Math.max(1, Number(state.batchIntervalMinutes) || 10);
  await chrome.alarms.clear(SCHEDULE_ALARM);

  if (runIndex >= maxRuns) {
    const status = `${state.status} SBC Players batch ${maxRuns}/${maxRuns} tamamlandı; otomatik çalışma durduruldu.`;
    await appendLog("SBC Players Web App sonrası batch tamamlandı.", {
      completedRuns: runIndex,
      maxRuns
    });
    return {
      ...state,
      running: false,
      batchActive: false,
      nextRunAt: null,
      status,
      updatedAt: Date.now()
    };
  }

  const nextRunAt = Date.now() + intervalMinutes * 60 * 1000;
  await chrome.alarms.create(SCHEDULE_ALARM, { when: nextRunAt });
  await appendLog("SBC Players Web App sonrası sonraki batch turu planlandı.", {
    completedRuns: runIndex,
    nextRun: runIndex + 1,
    maxRuns,
    intervalMinutes,
    nextRunAt: new Date(nextRunAt).toISOString()
  });
  return {
    ...state,
    running: false,
    batchActive: true,
    nextRunAt,
    status: `${state.status} Batch ${runIndex}/${maxRuns}; ${intervalMinutes} dakika sonra ${runIndex + 1}. tur başlayacak.`,
    updatedAt: Date.now()
  };
}

async function scheduleNextRunAfterCompletion(state, hadNewData) {
  const config = getScheduleConfig();
  const now = Date.now();
  const schedule = nextSbcPlayersSchedule(now, config, hadNewData);
  const nextRunAt = schedule.nextRunAt;
  const status = schedule.mode === "interval"
    ? `${state.status} Yeni veri işlendi; ${config.checkIntervalMinutes} dakika sonra tekrar kontrol edilecek.`
    : `${state.status} Sonraki çalışma ${formatLocalDateTime(nextRunAt)} (${config.timeText}) için planlandı.`;
  await chrome.alarms.clear(SCHEDULE_ALARM);
  await chrome.alarms.create(SCHEDULE_ALARM, { when: nextRunAt });
  await appendLog("SBC Players sonraki çalışma planlandı.", {
    hadNewData,
    mode: schedule.mode,
    nextRunAt: new Date(nextRunAt).toISOString(),
    localNextRunAt: formatLocalDateTime(nextRunAt),
    scheduleTime: config.timeText,
    checkIntervalMinutes: config.checkIntervalMinutes
  });
  return {
    ...state,
    status,
    nextRunAt,
    scheduleTime: config.timeText,
    checkIntervalMinutes: config.checkIntervalMinutes,
    updatedAt: Date.now()
  };
}

function getScheduleConfig() {
  const parsed = parseDailyTime(API_CONFIG.get("SBC_PLAYERS_SYNC_TIME", API_CONFIG.get("WEB_APP_SYNC_TIME", "20:00"))) || { hour: 20, minute: 0, text: "20:00" };
  const checkIntervalMinutes = Math.max(1, Number(API_CONFIG.get("SBC_PLAYERS_CHECK_INTERVAL_MINUTES", "15")) || 15);
  return {
    hour: parsed.hour,
    minute: parsed.minute,
    timeText: parsed.text,
    checkIntervalMinutes
  };
}

function nextSbcPlayersSchedule(nowMs, config, hadNewData) {
  const todayTarget = dailyTargetAt(nowMs, config.hour, config.minute);
  if (nowMs < todayTarget) return { nextRunAt: todayTarget, mode: "daily" };
  if (hadNewData) return { nextRunAt: nowMs + config.checkIntervalMinutes * 60 * 1000, mode: "interval" };
  return { nextRunAt: dailyTargetAt(nowMs + 24 * 60 * 60 * 1000, config.hour, config.minute), mode: "daily" };
}

function dailyTargetAt(baseMs, hour, minute) {
  const date = new Date(baseMs);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function parseDailyTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function formatLocalDateTime(value) {
  return new Date(value).toLocaleString("tr-TR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...emptyState, ...(stored[STATE_KEY] || {}) };
}

async function setState(state) {
  if (state?.running === true && Number(state.runToken) !== Number(activeRunToken)) {
    return getState();
  }
  const next = { ...emptyState, ...state, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", futbinSyncModule: "sbc_players", state: next }).catch(() => {});
  return next;
}

async function getLogs() {
  const stored = await chrome.storage.local.get(LOGS_KEY);
  return Array.isArray(stored[LOGS_KEY]) ? stored[LOGS_KEY] : [];
}

async function getErrors() {
  const stored = await chrome.storage.local.get(ERRORS_KEY);
  return Array.isArray(stored[ERRORS_KEY]) ? stored[ERRORS_KEY] : [];
}

async function appendLog(message, details = null) {
  const logs = await getLogs();
  await chrome.storage.local.set({
    [LOGS_KEY]: [...logs, { at: Date.now(), message, details }].slice(-MAX_LOGS)
  });
}

async function appendError(message, details = null) {
  const errors = await getErrors();
  await chrome.storage.local.set({
    [ERRORS_KEY]: [...errors, { at: Date.now(), message, details }].slice(-MAX_ERRORS)
  });
}

function normalizeApiBaseUrl(value) {
  return API_CONFIG.allowedBaseUrl(value || API_CONFIG.defaultBaseUrl());
}

async function apiRequest(apiBaseUrl, endpoint, options = {}, runToken = activeRunToken) {
  await API_CONFIG.ready;
  void apiBaseUrl;
  assertRunActive(runToken);
  const url = new URL(endpoint, API_CONFIG.defaultBaseUrl()).href;
  const method = options.method || "GET";
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  let attempt = 1;
  while (true) {
    assertRunActive(runToken);
    await appendLog("API request gönderiliyor.", { method, url, attempt, body: parseJsonForLog(options.body) });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("API request timeout"), API_REQUEST_TIMEOUT_MS);
    activeApiControllers.add(controller);
    let response;
    let rawText = "";
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body,
        signal: controller.signal
      });
      assertRunActive(runToken);
      rawText = await response.text();
      assertRunActive(runToken);
    } catch (error) {
      assertRunActive(runToken);
      const isTimeout = error?.name === "AbortError";
      if (!isTimeout) throw error;
      await appendError("API request timeout aldı; 5 saniye sonra aynı istek tekrar denenecek.", {
        method,
        url,
        attempt,
        timeoutMs: API_REQUEST_TIMEOUT_MS,
        retryAfterMs: API_TIMEOUT_RETRY_MS,
        endpoint
      });
      await delay(API_TIMEOUT_RETRY_MS, runToken);
      attempt += 1;
      continue;
    } finally {
      clearTimeout(timeout);
      activeApiControllers.delete(controller);
    }
    const payload = parseJsonForLog(rawText) || {};
    await appendLog("API response alındı.", {
      method,
      url,
      attempt,
      status: response.status,
      ok: response.ok,
      result: payload?.result,
      message: payload?.message || null,
      data: payload?.data || null,
      errors: payload?.errors || null
    });
    if (isApiTimeoutStatus(response.status)) {
      await appendError("API timeout status aldı; 5 saniye sonra aynı istek tekrar denenecek.", {
        method,
        url,
        attempt,
        status: response.status,
        retryAfterMs: API_TIMEOUT_RETRY_MS,
        endpoint,
        message: payload?.message || null
      });
      await delay(API_TIMEOUT_RETRY_MS, runToken);
      attempt += 1;
      continue;
    }
    if (!response.ok || payload?.result === false) {
      throw new Error(payload?.message || `API HTTP ${response.status}: ${url}`);
    }
    return payload;
  }
}

async function delay(ms, runToken = activeRunToken) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  assertRunActive(runToken);
}

function isApiTimeoutStatus(status) {
  return status === 408 || status === 504 || status === 524;
}

async function isRunActive(runToken) {
  if (runToken !== activeRunToken) return false;
  const state = await getState();
  return state.running === true && Number(state.runToken) === Number(runToken);
}

function assertRunActive(runToken) {
  if (runToken !== activeRunToken) {
    throw new Error("SBC Players sync stop edildi.");
  }
}

function flattenSbcRecords(records = [], parent = null, output = []) {
  records.forEach((record) => {
    if (!record || typeof record !== "object") return;
    const { subs, ...self } = record;
    const normalized = { ...self, parentSbc: parent };
    output.push(normalized);
    if (Array.isArray(subs)) flattenSbcRecords(subs, normalized, output);
  });
  return output;
}

function shouldSyncSbcPlayers(sbc) {
  return shouldSyncSbcPlayersBase(sbc) && hasRatingRequirement(sbc);
}

function shouldSyncSbcPlayersBase(sbc) {
  if (!sbc || sbc.group === true) return false;
  if (sbc.chemistry !== null && sbc.chemistry !== undefined && String(sbc.chemistry).trim() !== "") return false;
  const players = Array.isArray(sbc.sbc_player) ? sbc.sbc_player : [];
  return players.length === 0;
}

function hasRatingRequirement(sbc) {
  const reqs = Array.isArray(sbc?.reqs) ? sbc.reqs : [];
  return reqs.some((req) => String(req?.code || "").toLowerCase().includes("rating"));
}

function toSbcPlayerJob(sbc, allRecords, state) {
  const parent = sbc.parentSbc || allRecords.find((item) => Number(item.id) === Number(sbc.parent_id)) || null;
  const categoryName = localizedText(sbc.category?.name) || localizedText(parent?.category?.name) || sbc.category?.code || parent?.category?.code || "";
  const parentName = localizedText(parent?.name) || localizedText(sbc.name);
  const detailName = localizedText(sbc.name);
  if (!categoryName || !parentName || !detailName) {
    return null;
  }
  const siblingSubs = parent
    ? allRecords.filter((item) => Number(item.parent_id) === Number(parent.id) && localizedText(item.name) === detailName)
    : [];
  const nameIndex = Math.max(0, siblingSubs.findIndex((item) => Number(item.id) === Number(sbc.id)));
  return {
    ...sbc,
    apiBaseUrl: state.apiBaseUrl,
    sbc,
    id: sbc.id,
    sbcId: sbc.id,
    sbc_id: sbc.id,
    categoryId: sbc.category_id,
    category_id: sbc.category_id,
    categoryName,
    sbcName: parentName,
    detailSbcName: detailName,
    parentName,
    parent_name: parentName,
    name: detailName,
    desc: localizedText(sbc.desc),
    reward: localizedText(sbc.reward),
    icon_url: sbc.icon_url || "",
    source: parent ? "sub" : "root",
    name_index: nameIndex,
    sbcNameIndex: nameIndex,
    req: sbc.req,
    squadLink: sbc.squad_link || null
  };
}

function buildSbcSavePayload(job, players, mappingDetails = []) {
  const source = job.sbc || job;
  const payload = structuredCloneSafe(source);
  const usedSlotIds = new Set();
  delete payload.parentSbc;
  delete payload.sbc;
  delete payload.apiBaseUrl;
  delete payload.categoryName;
  delete payload.sbcName;
  delete payload.detailSbcName;
  delete payload.parentName;
  delete payload.parent_name;
  delete payload.name_index;
  delete payload.sbcNameIndex;
  delete payload.squadLink;
  payload.subs = [];
  payload.user_sbc = null;
  payload.category = null;
  payload.formation = null;
  payload.sbc_player = players
    .map((player, index) => toSbcPlayerPayload(source, player, index, usedSlotIds, mappingDetails))
    .filter(Boolean);
  payload.sbc_player.forEach((player) => {
    player.user_id = 1;
    player.system = true;
  });
  if (players[0]?.squadUrl) payload.squad_link = players[0].squadUrl;
  payload.integration_date = new Date().toISOString();
  payload.update_date = new Date().toISOString();
  payload.update_user_id = 1;
  payload.user_id = 1;
  payload.group = false;
  return payload;
}

function toSbcPlayerPayload(sbc, player, index, usedSlotIds, mappingDetails = []) {
  const matchedSlot = findFormationSlot(sbc, player.slot || player.position, usedSlotIds);
  if (!matchedSlot?.id) {
    mappingDetails.push({
      index: index + 1,
      ok: false,
      reason: "formation_slot_not_matched",
      player: toFutbinPlayerLogDto(player),
      requested: player.slot || player.position || ""
    });
    appendError("Futbin oyuncusu formation slot ile eşleşmedi.", {
      sbcId: sbc.id,
      player: player.name,
      slot: player.slot,
      position: player.position
    }).catch(() => {});
    return null;
  }
  usedSlotIds.add(Number(matchedSlot.id));
  const raw = player.raw || {};
  const playerPositionCode = normalizePositionCode(firstText(player.position, raw.position));
  const matchedPosition = resolvePositionLookup(playerPositionCode);
  const positionName = normalizePositionCode(localizedText(matchedPosition?.name) || matchedPosition?.code || playerPositionCode);
  const positionCode = positionName.toLowerCase();
  const futbinRarity = firstText(player.futbinRarity, player.futbin_rarity, raw.futbin_rarity);
  const matchedQuality = resolveQualityLookup(player, raw);
  const matchedRarity = resolveRarityLookup(player, raw, futbinRarity);

  const dto = {
    id: 0,
    sbc_id: sbc.id,
    user_id: 1,
    slot_id: matchedSlot.id,
    system: true,
    create_date: new Date().toISOString(),
    update_date: new Date().toISOString(),
    name: firstText(player.name, raw.name, raw.playerName, raw.common_name, raw.commonName),
    full_name: firstText(player.fullName, player.full_name, raw.full_name, raw.fullName, raw.common_name, raw.commonName, raw.name),
    quality_id: matchedQuality?.id || null,
    rarity_id: matchedRarity?.id || null,
    league_id: toNullableInt(player.league?.id ?? raw.league?.id),
    club_id: toNullableInt(player.club?.id ?? raw.club?.id),
    nation_id: toNullableInt(player.nation?.id ?? raw.nation?.id),
    rating: Number(player.rating) || 0,
    position_id: matchedPosition?.id || null,
    position_code: positionCode,
    position_name: positionName,
    price_pc: Number(player.pricePc ?? player.price_pc ?? 0) || 0,
    price_console: Number(player.priceConsole ?? player.price_console ?? 0) || 0,
    futbin_rarity: futbinRarity,
    matching_player_count: null,
    player: null,
    is_specific_player: Boolean(player.playerId || player.resourceId || raw.raw?.player_id || raw.raw?.resource_id),
    position: matchedPosition || null,
    quality: null,
    rarity: null,
    league: null,
    club: null,
    nation: null,
    index: index + 1
  };
  mappingDetails.push({
    index: index + 1,
    ok: true,
    player: toFutbinPlayerLogDto(player),
    requested: player.slot || player.position || "",
    matchedSlot: {
      id: matchedSlot.id,
      code: matchedSlot.code,
      name: matchedSlot.name,
      position_id: matchedSlot.position_id,
      position_name: matchedSlot.position_name
    },
    matchedPlayerPosition: matchedPosition ? {
      id: matchedPosition.id,
      code: matchedPosition.code,
      name: localizedText(matchedPosition.name),
      requested: playerPositionCode
    } : null,
    dto: toSbcPlayerLogDto(dto)
  });
  return dto;
}

function toFutbinPlayerLogDto(player) {
  return {
    name: player.name,
    fullName: player.fullName || player.full_name,
    rating: player.rating,
    slot: player.slot,
    position: player.position,
    playerId: player.playerId,
    resourceId: player.resourceId,
    pricePc: player.pricePc ?? player.price_pc,
    priceConsole: player.priceConsole ?? player.price_console,
    futbinRarity: player.futbinRarity || player.futbin_rarity,
    league: player.league,
    club: player.club,
    nation: player.nation
  };
}

function toSbcPlayerLogDto(player) {
  return {
    sbc_id: player.sbc_id,
    user_id: player.user_id,
    slot_id: player.slot_id,
    system: player.system,
    name: player.name,
    full_name: player.full_name,
    quality_id: player.quality_id,
    rarity_id: player.rarity_id,
    rating: player.rating,
    position_id: player.position_id,
    position_code: player.position_code,
    position_name: player.position_name,
    price_pc: player.price_pc,
    price_console: player.price_console,
    futbin_rarity: player.futbin_rarity,
    is_specific_player: player.is_specific_player,
    futbin: player.player?.futbin || null,
    images: player.player?.images || null
  };
}

function resolveQualityLookup(player, raw = {}) {
  const qualityText = normalizeLookupKey(firstText(player.quality, raw.quality));
  const rarityText = normalizeLookupKey(firstText(player.rarity, raw.rarity));
  const futbinRarity = normalizeLookupKey(firstText(player.futbinRarity, player.futbin_rarity, raw.futbin_rarity));
  const inferredQuality = inferBaseQualityKey(futbinRarity, qualityText) || inferQualityKeyFromRarity(rarityText) || qualityText;
  if (!inferredQuality) return null;
  return playerLookupCache.qualities.find((quality) => {
    const candidates = [
      quality.code,
      localizedText(quality.name),
      localizedText(quality.name, "tr")
    ].map(normalizeLookupKey).filter(Boolean);
    return candidates.includes(inferredQuality);
  }) || null;
}

function inferBaseQualityKey(...values) {
  const combined = values.map(normalizeLookupKey).filter(Boolean).join("_");
  if (!combined) return "";
  if (combined.includes("bronze")) return "bronze";
  if (combined.includes("silver")) return "silver";
  if (combined.includes("gold")) return "gold";
  return "";
}

function inferQualityKeyFromRarity(rarity) {
  const value = normalizeLookupKey(rarity);
  if (!value) return "";
  if (value !== "common" && value !== "rare") return "special";
  return "";
}

function resolveRarityLookup(player, raw = {}, futbinRarity = "") {
  const rarityText = normalizeLookupKey(firstText(player.rarity, raw.rarity));
  const futbinRarityKey = normalizeLookupKey(firstText(futbinRarity, player.futbinRarity, player.futbin_rarity, raw.futbin_rarity));
  const futbinPrefix = normalizeLookupKey(String(futbinRarityKey || "").split("_")[0]);
  const rawRareType = toNullableInt(raw.rare_type ?? raw.rareType ?? raw.statsCard?.rareType);
  const exact = playerLookupCache.rarities.find((rarity) => {
    const candidates = rarityLookupCandidates(rarity);
    return (futbinRarityKey && candidates.includes(futbinRarityKey))
      || (rarityText && candidates.includes(rarityText));
  });
  if (exact) return exact;

  if (rawRareType) {
    const byRareType = playerLookupCache.rarities.find((rarity) => Number(rarity.futbin_id) === rawRareType || Number(rarity.futbin_value) === rawRareType);
    if (byRareType) return byRareType;
  }

  if (futbinPrefix) {
    const byPrefix = playerLookupCache.rarities.find((rarity) => {
      const candidates = rarityLookupCandidates(rarity);
      return candidates.includes(futbinPrefix) || Number(rarity.futbin_id) === Number(futbinPrefix);
    });
    if (byPrefix) return byPrefix;
  }

  return null;
}

function resolvePositionLookup(positionCode) {
  const requested = normalizeLookupKey(positionCode);
  if (!requested) return null;
  return playerLookupCache.positions.find((position) => {
    const candidates = [
      position.code,
      localizedText(position.name),
      localizedText(position.name, "tr")
    ].map(normalizeLookupKey).filter(Boolean);
    return candidates.includes(requested);
  }) || null;
}

function rarityLookupCandidates(rarity) {
  return [
    rarity.code,
    rarity.futbin_rarity,
    rarity.futbin_value,
    rarity.req_key,
    rarity.futwiz_id,
    localizedText(rarity.name),
    localizedText(rarity.name, "tr")
  ].map(normalizeLookupKey).filter(Boolean);
}

function normalizeLookupKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[_\s-]+/g, "_")
    .replace(/[^\p{L}\p{N}_]+/gu, "")
    .trim();
}

function buildFutbinPlayerMeta(player, raw, matchedSlot) {
  return {
    source: "futbin_sbc_solution",
    futbin: {
      player_id: toNullableInt(player.playerId ?? raw.raw?.player_id ?? raw.playerId ?? raw.player_id),
      resource_id: toNullableInt(player.resourceId ?? raw.raw?.resource_id ?? raw.resourceId ?? raw.resource_id),
      card_id: toNullableInt(player.cardId ?? raw.raw?.card_id ?? raw.cardId ?? raw.card_id),
      base_id: toNullableInt(player.baseId ?? raw.raw?.base_id ?? raw.baseId ?? raw.base_id),
      rarity: firstText(player.futbinRarity, player.futbin_rarity, raw.futbin_rarity),
      url: firstText(raw.raw?.url, raw.url),
      data_url: firstText(raw.raw?.data_url, raw.data_url)
    },
    name: firstText(player.name, raw.name, raw.playerName),
    full_name: firstText(player.fullName, player.full_name, raw.full_name, raw.fullName),
    rating: Number(player.rating) || 0,
    slot: player.slot || "",
    position: player.position || "",
    slot_id: matchedSlot.id,
    position_id: matchedSlot.position_id || null,
    price_pc: Number(player.pricePc ?? player.price_pc ?? 0) || 0,
    price_console: Number(player.priceConsole ?? player.price_console ?? 0) || 0,
    images: {
      card_bg_url: firstText(player.cardBgUrl, player.card_bg_url, raw.card_bg_url, raw.images?.card_bg_url, raw.images?.background),
      card_player_img_url: firstText(player.cardPlayerImgUrl, player.card_player_img_url, raw.card_player_img_url, raw.images?.card_player_img_url, raw.images?.player),
      card: firstText(raw.images?.card, raw.images?.card_2x),
      player: firstText(raw.images?.player, raw.images?.player_2x)
    },
    league: buildImageDto(player.league || raw.league),
    club: buildImageDto(player.club || raw.club),
    nation: buildImageDto(player.nation || raw.nation),
    raw
  };
}

function buildNamedDto(value) {
  if (!value) return null;
  if (typeof value === "string") return { name: { en: value, tr: value }, code: value };
  if (typeof value !== "object") return null;
  return {
    id: toNullableInt(value.id),
    code: firstText(value.code, value.short_name, value.shortName, value.name),
    name: normalizeNameObject(value.name || value)
  };
}

function buildImageDto(value) {
  if (!value || typeof value !== "object") return null;
  return {
    id: toNullableInt(value.id),
    code: firstText(value.code, value.short_name, value.shortName),
    name: normalizeNameObject(value.name || value),
    image_url: firstText(value.image, value.image_url, value.imageUrl, value.url),
    image_url_2x: firstText(value.image_2x, value.image2x, value.image_url_2x)
  };
}

function findFormationSlot(sbc, slotOrPosition, usedSlotIds = new Set()) {
  const slots = getFormationSlots(sbc);
  const requested = normalizePositionCode(slotOrPosition);
  if (!slots.length) return null;
  const direct = slots.find((slot) => {
    if (usedSlotIds.has(Number(slot.id))) return false;
    const candidates = [
      slot.code,
      slot.name,
      slot.position_name,
      localizedText(slot.position?.name),
      localizedText(slot.position?.name, "tr")
    ].map(normalizePositionCode);
    return requested && candidates.includes(requested);
  });
  if (direct) return direct;

  if (!requested) return slots.find((slot) => !usedSlotIds.has(Number(slot.id))) || null;
  const requestedFamily = positionFamily(requested);
  const familyMatch = slots.find((slot) => {
    if (usedSlotIds.has(Number(slot.id))) return false;
    const candidates = [
      slot.code,
      slot.name,
      slot.position_name,
      localizedText(slot.position?.name),
      localizedText(slot.position?.name, "tr")
    ].map((value) => positionFamily(normalizePositionCode(value)));
    return candidates.includes(requestedFamily);
  });
  if (familyMatch) return familyMatch;

  return slots.find((slot) => !usedSlotIds.has(Number(slot.id))) || null;
}

function getFormationSlots(sbc) {
  const formation = sbc?.formation || sbc?.sbc?.formation || null;
  if (!formation) return [];
  const slots = Array.isArray(formation.formation_slots)
    ? formation.formation_slots
    : Array.isArray(formation.formation_slot)
      ? formation.formation_slot
      : [];
  return slots
    .filter(Boolean)
    .sort((a, b) => Number(a.index_no ?? a.id ?? 0) - Number(b.index_no ?? b.id ?? 0));
}

function getSbcFormationId(sbc) {
  return Number(sbc?.formation_id || sbc?.sbc?.formation_id || sbc?.formation?.id || sbc?.sbc?.formation?.id || 0);
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value || {}));
  }
}

function normalizePositionCode(value) {
  return String(value || "").trim().toUpperCase();
}

function positionFamily(value) {
  const normalized = normalizePositionCode(value);
  if (normalized === "LCB" || normalized === "RCB") return "CB";
  if (normalized === "LB" || normalized === "LWB") return "LB";
  if (normalized === "RB" || normalized === "RWB") return "RB";
  if (normalized === "LCDM" || normalized === "RCDM") return "CDM";
  if (normalized === "LCM" || normalized === "RCM") return "CM";
  if (normalized === "LCAM" || normalized === "RCAM") return "CAM";
  if (normalized === "LS" || normalized === "RS") return "ST";
  if (normalized === "LCF" || normalized === "RCF") return "CF";
  return normalized;
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function normalizeNameObject(value) {
  if (!value) return {};
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text ? { en: text, tr: text } : {};
  }
  if (typeof value === "object") {
    const en = firstText(value.en, value.name, value.label, value.code);
    const tr = firstText(value.tr, value.name, value.label, value.code, en);
    return {
      ...(en ? { en } : {}),
      ...(tr ? { tr } : {})
    };
  }
  return {};
}

function normalizeFutbinJob(job = {}) {
  return {
    categoryName: firstText(job.categoryName, job.category_name, job.category, job.parentCategoryName, job.parent_category_name),
    sbcName: firstText(job.sbcName, job.sbc_name, job.parentName, job.parent_name, job.name),
    detailSbcName: firstText(job.detailSbcName, job.detail_sbc_name, job.detailName, job.detail_name, job.name),
    sbcNameIndex: Number(job.sbcNameIndex ?? job.sbc_name_index ?? job.nameIndex ?? job.name_index ?? 0) || 0,
    matchContext: {
      name: firstText(job.detailSbcName, job.detail_sbc_name, job.detailName, job.detail_name, job.name),
      desc: firstText(job.desc, localizedText(job.sbc?.desc)),
      reward: firstText(job.reward, localizedText(job.sbc?.reward)),
      iconUrl: firstText(job.icon_url, job.iconUrl, job.sbc?.icon_url)
    }
  };
}

function firstText(...values) {
  for (const value of values) {
    const raw = value && typeof value === "object" ? localizedText(value) : value;
    const text = String(raw ?? "").trim();
    if (text) return text;
  }
  return "";
}

function localizedText(value, lang = "en") {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return String(value[lang] || value.en || value.tr || value.name || value.code || "").trim();
  }
  return String(value).trim();
}

function sbcJobDisplayName(job) {
  const childName = firstText(job?.detailSbcName, job?.name, localizedText(job?.sbc?.name));
  const parentName = firstText(job?.parentName, job?.parent_name, localizedText(job?.parentSbc?.name), localizedText(job?.sbc?.parentSbc?.name));
  if (parentName && childName && parentName.toLowerCase() !== childName.toLowerCase()) {
    return `${parentName} / ${childName}`;
  }
  return childName || parentName || `SBC ${job?.sbcId ?? job?.id ?? ""}`.trim();
}

function parseJsonForLog(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractApiArray(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.data?.items)) return response.data.items;
  return [];
}
