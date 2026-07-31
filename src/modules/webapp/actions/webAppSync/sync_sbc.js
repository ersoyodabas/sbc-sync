(function () {
  const modules = window.FutbinSyncWebAppModules = window.FutbinSyncWebAppModules || {};

  const TEXT = {
    en: {
      any: "Any",
      daily: "Daily",
      repeatable: "Repeatable"
    },
    tr: {
      any: "Herhangi",
      daily: "Günlük",
      repeatable: "Tekrarlanabilir"
    }
  };


  const selectors = {
    homeBtn: "button.ut-tab-bar-item.icon-home",
    sbcBtn: "button.ut-tab-bar-item.icon-sbc",
    filterItem: ".ea-filter-bar-item-view",
    tileView: ".ut-sbc-set-tile-view",
    tileIconUrl: "div.content-container > div.tileHeader > img",
    tileName: "div.content-container > div.tileHeader > h1",
    tileDesc: "div.content-container > div.reward-content > div.objective-column > div.challenge > div.tileContent",
    tileSubCount: "div.layout-hub.grid > div:nth-child(1) > div.content-container > div.reward-content > div.objective-column > div.challenge > div.ut-sbc-set-tile-view--progress-block > div > span",
    tileReward: "div.content-container > div.reward-content > div.objective-column > div.group-rewards > ul > li > div > div > span.type",
    tileNoRepeat: "div.ut-squad-building-set-status-label-view.no-repeat",
    tileRepeat: "div.ut-squad-building-set-status-label-view.repeat",
    tileTitle: "div.content-container > div.tileHeader > h1",
    tileProgressLabel: ".ut-progress-bar--label",
    subRow: ".ut-sbc-challenge-table-row-view",
    subTileIconUrl: ".ut-sbc-challenge-table-row-view--image",
    subTileName: ".ut-sbc-challenge-table-row-view--title",
    backBtn: "button.ut-navigation-button-control",
    reqsChecklist: ".sbc-requirements-checklist"
  };

  modules.syncSbc = async function syncSbc(startLang = "en") {
    const core = window.FutbinSyncWebAppCore || {};
    const runner = createSbcRunner(core);
    const requestedLang = normalizeLang(startLang);
    const initialLang = runner.detectPageLang() || requestedLang;

    if (initialLang && initialLang !== requestedLang) {
      throw new Error(`[CRITICAL] SBC ${requestedLang.toUpperCase()} fazı başlamadan önce Home Page dili uyumsuz. Settings bilgisi: ${initialLang}`);
    }

    await runner.log("SBC", "SBC Sync başladı.", { requestedLang, detectedLang: initialLang });
    const result = await runner.doSyncSbc(requestedLang);
    await runner.log("SBC_COMPLETE", `${requestedLang.toUpperCase()} SBC fazı tamamlandı.`, result);
    return result;
  };

  function createSbcRunner(core) {
    const state = {
      isRunning: true,
      currentLang: "en",
      loc: TEXT.en,
      formations: [],
      lastSbcPlayerRequestAt: 0,
      postedParentLookupKeys: new Set()
    };

    const runner = {
      selectors,
      state,
      futClick: core.futClick,
      isElementVisible: core.isElementVisible,
      normalize: core.normalize || ((value) => String(value || "").trim().replace(/\s+/g, " ")),
      sleep: core.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      waitForVisibleElement: core.waitForVisibleElement,
      webAppLog: core.webAppLog || (() => Promise.resolve()),

      consoleLog(step, message, details = null) {
        const payload = {
          at: new Date().toISOString(),
          lang: this.state.currentLang || null,
          step,
          message,
          details: details || null
        };
        console.log("[WEBAPP-SYNC][SBC]", payload);
      },

      async log(step, message, details) {
        this.consoleLog(step, message, details);
        await this.webAppLog(step, message, details);
      },

      stopped() {
        if (!this.state.isRunning) return true;
        if (localStorage.getItem("sbcai_stop_sync") === "true") {
          localStorage.removeItem("sbcai_stop_sync");
          this.state.isRunning = false;
          return true;
        }
        return false;
      },

      async wait(ms) {
        await this.sleep(ms);
        return !this.stopped();
      },

      async click(target) {
        if (this.stopped()) return false;
        const element = typeof target === "string" ? document.querySelector(target) : target;
        if (!element) return false;
        const clicked = await this.futClick(element);
        await this.sleep(100);
        return clicked;
      },

      async waitForElement(selector, timeout = 5000) {
        if (typeof this.waitForVisibleElement === "function") {
          return this.waitForVisibleElement(selector, timeout);
        }
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeout) {
          if (this.stopped()) return null;
          const element = document.querySelector(selector);
          if (element) return element;
          await this.sleep(100);
        }
        return null;
      },

      t(key, params = {}) {
        const fallback = {
          parent_sbc: "Parent SBC",
          single_sbc: "Single SBC",
          sync_saving_named_type: "{type} kaydediliyor: {name}",
          sync_requirements_empty: "{label} requirements boş/geçersiz ({language})",
          sync_requirement_name_empty: "{name} requirements okunamadı ({language})",
          sync_requirements_dom_unreadable: "{name} requirements DOM okunamadı"
        }[key] || key;
        return fallback.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
      },

      toast(key, type = "neutral", details = null) {
        return this.log(`SBC_${type.toUpperCase()}`, key, details);
      },

      detectPageLang() {
        const element = document.querySelector("button.ut-tab-bar-item.icon-settings:not(.sbc-tab-logout-btn)") ||
          document.querySelector(".ut-tab-bar-item.icon-settings:not(.sbc-tab-logout-btn)") ||
          document.querySelector(".icon-settings");
        const text = this.normalize(element?.innerText || element?.textContent).toLowerCase();
        if (text === "settings") return "en";
        if (text === "ayarlar") return "tr";
        return null;
      },

      async api(method, endpoint, body = null) {
        const methodName = String(method || "GET").toUpperCase();
        const loader = window.FutbinSyncWebAppApiLoader;
        const request = () => window.FutbinSyncWebAppApi(methodName, endpoint, body);
        const message = loader?.wrap
          ? await loader.wrap(`${methodName} ${endpoint} API isteği gönderiliyor...`, request, {
            method: methodName,
            endpoint,
            lang: this.state.currentLang,
            operation: methodName === "GET" ? "load" : "save"
          })
          : await request();
        return message;
      },

      get(endpoint) {
        return this.api("GET", endpoint);
      },

      post(endpoint, body) {
        return this.api("POST", endpoint, body);
      },

      getLocalized(input, lang = this.state.currentLang || "en") {
        if (input == null) return "";
        if (typeof input === "object" && !Array.isArray(input)) {
          return input[lang] || input.en || input.tr || input[Object.keys(input)[0]] || "";
        }
        if (typeof input === "string") {
          const trimmed = input.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              return this.getLocalized(JSON.parse(trimmed), lang);
            } catch {
              return input;
            }
          }
          return input;
        }
        return String(input);
      },

      nonNullString(value) {
        return value == null ? "" : String(value);
      },

      normalizeString(value) {
        return this.nonNullString(value)
          .trim()
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
      },

      toSnakeCase(value) {
        return this.nonNullString(value)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .trim()
          .replace(/\s+/g, "_");
      },

      parseSubCount(labelText) {
        const match = this.nonNullString(labelText).match(/\/\s*(\d+)/);
        return match ? parseInt(match[1], 10) : 1;
      },

      normalizeSyncBool(value) {
        if (value === true || value === false) return value;
        if (value == null || value === "") return null;
        if (typeof value === "number") return value !== 0;
        const text = String(value).trim().toLowerCase();
        if (!text) return null;
        if (["true", "1", "yes", "y", "evet"].includes(text)) return true;
        if (["false", "0", "no", "n", "hayir", "hayır"].includes(text)) return false;
        return null;
      },

      normalizeSyncInt(value) {
        if (value == null || value === "") return null;
        const numberValue = typeof value === "number"
          ? value
          : Number(String(value).replace(/[^\d-]/g, ""));
        return Number.isInteger(numberValue) ? numberValue : null;
      },

      normalizeRepeatCount(value) {
        const normalized = this.normalizeSyncInt(value);
        return normalized != null && normalized > 0 ? normalized : null;
      },

      getRepeatableTextFromTile(tile) {
        const repeatElement = tile?.querySelector(this.selectors.tileRepeat) ||
          tile?.querySelector(this.selectors.tileNoRepeat);
        return this.nonNullString(repeatElement?.innerText || repeatElement?.textContent).trim();
      },

      detectRepeatableFromTile(tile) {
        if (!tile) return false;
        if (tile.querySelector(this.selectors.tileNoRepeat)) return false;
        if (tile.querySelector(this.selectors.tileRepeat)) return true;
        return false;
      },

      detectRepeatCountFromTile(tile) {
        const repeatElement = tile?.querySelector(this.selectors.tileRepeat);
        if (!repeatElement) return null;
        const repeatSpan = repeatElement.querySelector(":scope > span") || repeatElement.querySelector("span");
        const rawText = this.nonNullString(repeatSpan?.innerText || repeatElement.innerText).trim();
        if (!rawText) return null;
        const parts = rawText.split(":");
        if (parts.length >= 2) {
          const parsed = parseInt(parts[1].trim(), 10);
          if (!Number.isNaN(parsed)) return parsed;
        }
        const match = rawText.match(/\d+/);
        return match ? parseInt(match[0], 10) : null;
      },

      detectDailyFromName(name) {
        const dailyText = TEXT[this.state.currentLang]?.daily || TEXT.en.daily;
        return Boolean(name && dailyText && String(name).toLowerCase().includes(String(dailyText).toLowerCase()));
      },

      buildDbKey(record, lang) {
        return [
          record?.category_id,
          this.nonNullString(record?.icon_url),
          this.normalizeString(this.getLocalized(record?.name, lang)),
          this.normalizeString(this.getLocalized(record?.desc, lang)),
          this.normalizeString(this.getLocalized(record?.reward, lang))
        ].join("_");
      },

      buildScreenTileKey({ categoryId, icon_url, name, desc, reward }) {
        return [
          categoryId,
          this.nonNullString(icon_url),
          this.normalizeString(name),
          this.normalizeString(desc),
          this.normalizeString(reward)
        ].join("_");
      },

      buildDbMap(dbList, lang) {
        const dbMap = {};
        for (const record of Array.isArray(dbList) ? dbList : []) {
          const key = this.buildDbKey(record, lang);
          if (key) dbMap[key] = record;
        }
        return dbMap;
      },

      buildDbIdentityKey({ categoryId, sort_no, group }) {
        return [
          categoryId,
          Number(sort_no) || 0,
          group === true ? "group" : "single"
        ].join("_");
      },

      buildDbIdentityMap(dbList) {
        const dbMap = {};
        for (const record of Array.isArray(dbList) ? dbList : []) {
          if (record?.parent_id != null) continue;
          const key = this.buildDbIdentityKey({
            categoryId: record.category_id,
            sort_no: record.sort_number ?? record.sort_no,
            group: record.group === true
          });
          if (key) dbMap[key] = record;
        }
        return dbMap;
      },

      getVisibleTileSnapshot(entry, lang) {
        return {
          name: this.normalizeString(entry?.name && typeof entry.name === "object" ? this.getLocalized(entry.name, lang) : entry?.name),
          desc: this.normalizeString(entry?.desc && typeof entry.desc === "object" ? this.getLocalized(entry.desc, lang) : entry?.desc),
          reward: this.normalizeString(entry?.reward && typeof entry.reward === "object" ? this.getLocalized(entry.reward, lang) : entry?.reward),
          icon_url: this.nonNullString(entry?.icon_url ?? entry?.iconUrl).trim()
        };
      },

      compareVisibleTileFields(dbEntry, screenEntry, lang) {
        const db = this.getVisibleTileSnapshot(dbEntry, lang);
        const screen = this.getVisibleTileSnapshot(screenEntry, lang);
        const changedFields = [];
        for (const field of ["name", "desc", "reward", "icon_url"]) {
          if (db[field] !== screen[field]) changedFields.push(field);
        }
        return { changed: changedFields.length > 0, changedFields, db, screen };
      },

      getRepeatableSnapshot(entry) {
        return {
          repeatable: this.normalizeSyncBool(entry?.repeatable),
          repeat_count: this.normalizeRepeatCount(entry?.repeat_count),
          daily: this.normalizeSyncBool(entry?.daily ?? entry?.isDaily),
          repeatable_text: this.nonNullString(entry?.repeatable_text ?? entry?.repeatableText),
          repeatable_source: this.nonNullString(entry?.repeatable_source ?? entry?.repeatableSource)
        };
      },

      compareRepeatableFields(dbEntry, screenEntry) {
        const db = this.getRepeatableSnapshot(dbEntry);
        const screen = this.getRepeatableSnapshot(screenEntry);
        const changedFields = [];
        for (const field of ["repeatable", "repeat_count", "daily"]) {
          if (db[field] !== screen[field]) changedFields.push(field);
        }
        return { changed: changedFields.length > 0, changedFields, db, screen, repeatOnly: changedFields.length > 0 };
      },

      buildLocalizedPayload(value, lang) {
        const result = { en: "", tr: "" };
        if (value && typeof value === "object" && !Array.isArray(value)) {
          result.en = this.nonNullString(value.en);
          result.tr = this.nonNullString(value.tr);
          return result;
        }
        result[lang === "tr" ? "tr" : "en"] = this.nonNullString(value).trim();
        return result;
      },

      activeReqsLang(lang) {
        return normalizeLang(this.state.currentLang || lang || "en");
      },

      reqTextToCode(text) {
        return this.toSnakeCase(this.nonNullString(text).split(":")[0].trim());
      },

      legacyReqText(code, value) {
        if (value === true) return this.nonNullString(code).replace(/_/g, " ");
        const val = this.nonNullString(value).trim();
        return val ? `${this.nonNullString(code).replace(/_/g, " ")}: ${val}` : this.nonNullString(code).replace(/_/g, " ");
      },

      makeReqItem(code, text, lang) {
        const activeLang = this.activeReqsLang(lang);
        return {
          code: this.nonNullString(code).trim(),
          name: {
            en: activeLang === "en" ? this.nonNullString(text).trim() : "",
            tr: activeLang === "tr" ? this.nonNullString(text).trim() : ""
          }
        };
      },

      normalizeReqsItems(reqs, lang) {
        const activeLang = this.activeReqsLang(lang);
        if (!reqs) return [];
        if (typeof reqs === "string") {
          try {
            return this.normalizeReqsItems(JSON.parse(reqs), lang);
          } catch {
            return [];
          }
        }
        if (Array.isArray(reqs)) {
          return reqs.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            if ("code" in item || "name" in item) {
              const code = this.nonNullString(item.code || this.reqTextToCode(item.name?.[activeLang] || item.name?.en || item.name?.tr));
              const name = item.name && typeof item.name === "object"
                ? { en: this.nonNullString(item.name.en).trim(), tr: this.nonNullString(item.name.tr).trim() }
                : { en: "", tr: "" };
              return code ? { code, name } : null;
            }
            const [code, value] = Object.entries(item)[0] || [];
            return code ? this.makeReqItem(code, this.legacyReqText(code, value), activeLang) : null;
          }).filter(Boolean);
        }
        if (typeof reqs === "object") return this.normalizeReqsItems(reqs[activeLang], activeLang);
        return [];
      },

      reqsHasRowsForLang(reqs, lang) {
        const activeLang = this.activeReqsLang(lang);
        const rows = this.normalizeReqsItems(reqs, activeLang);
        return rows.length > 0 && rows.every((row) =>
          this.nonNullString(row?.code).trim() && this.nonNullString(row?.name?.[activeLang]).trim());
      },

      buildReqsPayload(reqs, lang) {
        return this.normalizeReqsItems(reqs, lang);
      },

      buildExistingSbcEntryForRepeatUpdate(dbEntry, screenEntry, lang) {
        const activeLang = this.activeReqsLang(lang);
        const localizedValue = (value, fallback = "") => {
          const fromDb = this.getLocalized(value, activeLang) || this.getLocalized(value, "en") || this.getLocalized(value, "tr");
          return this.nonNullString(fromDb || fallback).trim();
        };

        return {
          ...dbEntry,
          sort_no: Number(screenEntry?.sort_no ?? dbEntry?.sort_number ?? dbEntry?.sort_no) || 0,
          icon_url: this.nonNullString(screenEntry?.icon_url || dbEntry?.icon_url),
          name: this.nonNullString(screenEntry?.name || localizedValue(dbEntry?.name)),
          desc: this.nonNullString(screenEntry?.desc || localizedValue(dbEntry?.desc)),
          category: this.nonNullString(screenEntry?.category || dbEntry?.category),
          sub_count: this.nonNullString(screenEntry?.sub_count || dbEntry?.sub_count),
          reward: this.nonNullString(screenEntry?.reward || localizedValue(dbEntry?.reward)),
          repeatable: this.normalizeSyncBool(screenEntry?.repeatable) === true,
          repeat_count: this.normalizeRepeatCount(screenEntry?.repeat_count),
          daily: this.normalizeSyncBool(screenEntry?.daily) === true,
          isDaily: this.normalizeSyncBool(screenEntry?.daily) === true,
          repeatable_text: this.nonNullString(screenEntry?.repeatable_text),
          repeatable_source: this.nonNullString(screenEntry?.repeatable_source || "tile_status_label"),
          req: dbEntry?.req === true,
          reqs: dbEntry?.reqs || null,
          chemistry: Number(dbEntry?.chemistry) || 0,
          tradeable: dbEntry?.tradeable === true,
          squad_active: dbEntry?.squad_active === true,
          group: screenEntry?.group === true || dbEntry?.group === true,
          exist: false,
          child_count: Number(screenEntry?.child_count ?? dbEntry?.child_count) || 0,
          name_index: Number(dbEntry?.name_index) || 0,
          parent_name: this.nonNullString(dbEntry?.parent_name),
          formation_id: Number(dbEntry?.formation_id) || 0,
          slots: Array.isArray(dbEntry?.slots) ? dbEntry.slots : [],
          sbc_players: this.getExistingSbcPlayers(dbEntry),
          subs: Array.isArray(dbEntry?.subs)
            ? dbEntry.subs.map((sub, index) => this.buildExistingSbcEntryForRepeatUpdate(sub, {
              sort_no: Number(sub?.sort_number ?? sub?.sort_no ?? index + 1) || index + 1,
              icon_url: sub?.icon_url,
              name: localizedValue(sub?.name),
              desc: localizedValue(sub?.desc),
              reward: localizedValue(sub?.reward),
              repeatable: sub?.repeatable,
              repeat_count: sub?.repeat_count,
              daily: sub?.daily,
              group: false
            }, lang))
            : []
        };
      },

      getExistingSbcPlayers(entry) {
        if (Array.isArray(entry?.sbc_players) && entry.sbc_players.length > 0) return entry.sbc_players;
        if (Array.isArray(entry?.sbc_player) && entry.sbc_player.length > 0) return entry.sbc_player;
        if (Array.isArray(entry?.players) && entry.players.length > 0) return entry.players;
        return [];
      },

      hasExistingSbcPlayers(entry) {
        return this.getExistingSbcPlayers(entry).length > 0;
      },

      buildSbcSyncTilePayload(entry, lang, parentName = "") {
        const nameText = this.nonNullString(entry?.name).trim();
        const rewardText = this.nonNullString(entry?.reward).trim();
        const isGroup = entry?.group === true;
        const reqs = isGroup ? null : this.buildReqsPayload(entry?.reqs, lang);
        const subs = Array.isArray(entry?.subs)
          ? entry.subs.map((sub) => this.buildSbcSyncTilePayload(sub, lang, nameText))
          : [];

        return {
          user_id: 1,
          sort_no: Number(entry?.sort_no) || 0,
          icon_url: this.nonNullString(entry?.icon_url),
          name: this.buildLocalizedPayload(entry?.name, lang),
          desc: this.buildLocalizedPayload(entry?.desc, lang),
          category: this.nonNullString(entry?.category),
          sub_count: this.nonNullString(entry?.sub_count),
          reward: this.buildLocalizedPayload(entry?.reward, lang),
          repeatable: this.normalizeSyncBool(entry?.repeatable) === true,
          repeat_count: this.normalizeRepeatCount(entry?.repeat_count),
          daily: this.normalizeSyncBool(entry?.daily ?? entry?.isDaily) === true,
          isDaily: this.normalizeSyncBool(entry?.daily ?? entry?.isDaily) === true,
          repeatable_text: this.nonNullString(entry?.repeatable_text ?? entry?.repeatableText),
          repeatable_source: this.nonNullString(entry?.repeatable_source ?? entry?.repeatableSource),
          force_update: entry?.force_update === true,
          update_reason: this.nonNullString(entry?.update_reason),
          repeatable_changed_fields: Array.isArray(entry?.repeatable_changed_fields) ? entry.repeatable_changed_fields : [],
          req: entry?.req === true,
          reqs,
          chemistry: Number(entry?.chemistry) || 0,
          tradeable: entry?.tradeable === true || !rewardText.toLowerCase().includes("untradeable"),
          squad_active: entry?.squad_active === true,
          group: isGroup,
          exist: entry?.exist === true,
          child_count: Number(entry?.child_count) || subs.length || 0,
          name_index: Number(entry?.name_index) || 0,
          parent_name: this.nonNullString(entry?.parent_name || parentName),
          formation_id: Number(entry?.formation_id) || 0,
          slots: Array.isArray(entry?.slots) ? entry.slots.map((slot) => this.nonNullString(slot)) : [],
          sbc_players: this.normalizeSbcPlayersPayload(entry?.sbc_players),
          subs
        };
      },

      normalizeSbcPlayersPayload(players) {
        return (Array.isArray(players) ? players : [])
          .map((player, index) => ({
            name: this.nonNullString(player?.name).trim(),
            full_name: this.nonNullString(player?.full_name || player?.fullName || player?.name).trim(),
            rating: this.normalizeSyncInt(player?.rating),
            position: this.nonNullString(player?.position).trim(),
            position_id: this.normalizeSyncInt(player?.position_id),
            slot: this.nonNullString(player?.slot || player?.slot_name).trim(),
            slot_name: this.nonNullString(player?.slot_name || player?.slot).trim(),
            slot_id: this.normalizeSyncInt(player?.slot_id),
            quality: this.nonNullString(player?.quality).trim(),
            quality_id: this.normalizeSyncInt(player?.quality_id),
            rarity: this.nonNullString(player?.rarity).trim(),
            rarity_id: this.normalizeSyncInt(player?.rarity_id),
            futbin_rarity: this.nonNullString(player?.futbin_rarity || player?.futbinRarity).trim(),
            price: this.normalizeSyncInt(player?.price),
            price_pc: this.normalizeSyncInt(player?.price_pc),
            price_console: this.normalizeSyncInt(player?.price_console),
            index
          }))
          .filter((player) => player.name || player.rating || player.slot || player.position);
      },

      countTilePlayers(tilePayload) {
        const own = Array.isArray(tilePayload?.sbc_players) ? tilePayload.sbc_players.length : 0;
        const child = (Array.isArray(tilePayload?.subs) ? tilePayload.subs : [])
          .reduce((total, sub) => total + this.countTilePlayers(sub), 0);
        return own + child;
      },

      buildParentLookupKey(categoryId, tilePayload, lang) {
        const parentName = tilePayload?.group === true
          ? tilePayload?.name?.[this.activeReqsLang(lang)] || tilePayload?.name?.en || tilePayload?.name?.tr
          : tilePayload?.parent_name;
        if (!parentName) return "";
        return [
          Number(categoryId) || 0,
          normalizeLang(lang),
          this.normalizeString(parentName),
          Number(tilePayload?.sort_no) || 0
        ].join("|");
      },

      isParentLookupOnlyPayload(tilePayload) {
        return tilePayload?.group === true &&
          (!Array.isArray(tilePayload?.subs) || tilePayload.subs.length === 0) &&
          this.countTilePlayers(tilePayload) === 0;
      },

      validateTileReqsBeforePost(tilePayload, lang, path = "") {
        const label = path || tilePayload?.name?.[this.activeReqsLang(lang)] || tilePayload?.name?.en || tilePayload?.name?.tr || "SBC";
        const subs = Array.isArray(tilePayload?.subs) ? tilePayload.subs : [];
        if (tilePayload?.group === true) {
          return subs.every((sub, index) =>
            this.validateTileReqsBeforePost(sub, lang, `${label} > ${sub?.name?.[this.activeReqsLang(lang)] || sub?.name?.en || sub?.name?.tr || `Sub ${index + 1}`}`));
        }
        if (!this.reqsHasRowsForLang(tilePayload?.reqs, lang)) {
          this.state.isRunning = false;
          this.log("SBC_ERROR", "Tile requirements boş/geçersiz; post iptal edildi.", { label, lang, reqs: tilePayload?.reqs });
          return false;
        }
        return subs.every((sub, index) =>
          this.validateTileReqsBeforePost(sub, lang, `${label} > ${sub?.name?.[this.activeReqsLang(lang)] || sub?.name?.en || sub?.name?.tr || `Sub ${index + 1}`}`));
      },

      isRecoverableTilePostFailure(counters) {
        const stage = String(counters?.lastError?.stage || "");
        return stage === "tile-sync-post" || stage === "tile-sync-post-exception";
      },

      async postTileData(categoryId, sbcEntry, lang, counters) {
        if (!sbcEntry || (sbcEntry.exist && sbcEntry.force_update !== true)) {
          counters.skippedCount += 1;
          return true;
        }
        const tilePayload = this.buildSbcSyncTilePayload(sbcEntry, lang);
        const repeatableOnlyUpdate = sbcEntry?.update_reason === "repeatable_fields_changed_only";
        if (!repeatableOnlyUpdate && !this.validateTileReqsBeforePost(tilePayload, lang, sbcEntry.name)) {
          counters.lastError = {
            stage: "validate-before-post",
            categoryId,
            lang,
            name: sbcEntry.name,
            group: tilePayload?.group === true,
            playerCount: this.countTilePlayers(tilePayload)
          };
          this.consoleLog("SBC_POST_BLOCKED", "Tile payload validation başarısız; API post gönderilmedi.", counters.lastError);
          return false;
        }

        counters.postedCount += 1;
        await this.log("SBC_SAVE", "SBC tile API'ye gönderiliyor.", {
          categoryId,
          lang,
          name: sbcEntry.name,
          group: tilePayload.group,
          subs: tilePayload.subs?.length || 0,
          playerCount: this.countTilePlayers(tilePayload),
          updateReason: sbcEntry.update_reason || null
        });

        const parentLookupKey = this.buildParentLookupKey(categoryId, tilePayload, lang);
        if (parentLookupKey && this.isParentLookupOnlyPayload(tilePayload)) {
          if (this.state.postedParentLookupKeys.has(parentLookupKey)) {
            counters.skippedCount += 1;
            counters.postedCount -= 1;
            await this.log("SBC_SKIP", "Aynı parent SBC için tekrar eden parent lookup isteği atlandı.", {
              name: sbcEntry.name,
              parentLookupKey
            });
            return true;
          }
          this.state.postedParentLookupKeys.add(parentLookupKey);
        }
        if (parentLookupKey && tilePayload?.group === true && !this.isParentLookupOnlyPayload(tilePayload)) {
          this.state.postedParentLookupKeys.add(parentLookupKey);
        }

        let saveResult = null;
        try {
          saveResult = await this.post("sbc/tile-sync", {
            tile: tilePayload,
            lang,
            category_id: categoryId,
            user_id: 1
          });
        } catch (error) {
          counters.failedCount += 1;
          counters.lastError = {
            stage: "tile-sync-post-exception",
            categoryId,
            lang,
            name: sbcEntry.name,
            group: tilePayload.group,
            subs: tilePayload.subs?.length || 0,
            playerCount: this.countTilePlayers(tilePayload),
            message: error.message || String(error),
            stack: error.stack || null
          };
          await this.log("SBC_ERROR", "SBC tile API isteği hata döndü; sonraki tile ile devam edilecek.", counters.lastError);
          return false;
        }
        if (saveResult?.result) {
          counters.insertedCount += Number(saveResult.data?.inserted) || 0;
          counters.updatedCount += Number(saveResult.data?.updated) || 0;
          counters.tileDeletedCount += Number(saveResult.data?.deleted) || 0;
          counters.savedCount += 1;
          await this.log("SBC_SAVE", "SBC tile kaydedildi.", {
            name: sbcEntry.name,
            data: saveResult.data || null
          });
          return true;
        }

        counters.failedCount += 1;
        counters.lastError = {
          stage: "tile-sync-post",
          categoryId,
          lang,
          name: sbcEntry.name,
          group: tilePayload.group,
          subs: tilePayload.subs?.length || 0,
          playerCount: this.countTilePlayers(tilePayload),
          message: saveResult?.message || "Bilinmeyen hata",
          response: saveResult || null
        };
        await this.log("SBC_ERROR", "SBC tile kayıt hatası.", {
          name: sbcEntry.name,
          message: saveResult?.message || "Bilinmeyen hata",
          response: saveResult || null
        });
        return false;
      },

      readReqs(lang = this.state.currentLang || "en") {
        const checklist = document.querySelector(this.selectors.reqsChecklist);
        if (!checklist) return null;
        const items = Array.from(checklist.querySelectorAll("li"));
        if (!items.length) return null;
        const texts = items.map((li) => this.nonNullString(li.innerText || li.textContent).trim());
        if (texts.some((text) => !text)) return null;
        const result = texts.map((text) => {
          const code = this.reqTextToCode(text);
          return code ? this.makeReqItem(code, text, lang) : null;
        }).filter(Boolean);
        return result.length === texts.length ? result : null;
      },

      async waitForReqsReady(name = "SBC", timeout = 10000) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeout) {
          if (this.stopped()) return false;
          const checklist = document.querySelector(this.selectors.reqsChecklist);
          const items = checklist ? Array.from(checklist.querySelectorAll("li")) : [];
          const texts = items.map((li) => this.nonNullString(li.innerText || li.textContent).trim());
          if (items.length > 0 && texts.every(Boolean)) return true;
          await this.sleep(150);
        }
        this.state.isRunning = false;
        await this.log("SBC_ERROR", "Requirements DOM hazır olmadı.", { name });
        return false;
      },

      async readReqsOrStop(name = "SBC", lang = "en", timeout = 10000) {
        const ready = await this.waitForReqsReady(name, timeout);
        if (!ready) return null;
        const reqs = this.readReqs(lang);
        if (!this.reqsHasRowsForLang(reqs, lang)) {
          this.state.isRunning = false;
          await this.log("SBC_ERROR", "Requirements okunamadı veya boş.", { name, lang, reqs });
          return null;
        }
        return reqs;
      },

      getReqsLangArray(reqs, lang = "en") {
        const activeLang = this.activeReqsLang(lang);
        return this.normalizeReqsItems(reqs, activeLang)
          .filter((item) => this.nonNullString(item?.code).trim() && this.nonNullString(item?.name?.[activeLang]).trim())
          .map((item) => ({ [item.code]: item.name[activeLang] }));
      },

      hasChemistryReqs(reqsJson) {
        const reqs = this.getReqsLangArray(reqsJson, this.state.currentLang || "en");
        return reqs.some((req) => Object.keys(req).some((key) =>
          key.toLowerCase().includes("chemistry") || key.toLowerCase().includes("kimya")));
      },

      async readSlots(lang, reqs, name) {
        const slots = [];
        if (lang !== "en") return slots;
        if (!this.hasChemistryReqs(reqs)) return slots;
        const pitchView = await this.waitForElement(".ut-squad-pitch-view", 10000);
        if (!pitchView) {
          this.state.isRunning = false;
          await this.log("SBC_ERROR", "Pitch view bulunamadı.", { name });
          return null;
        }
        const allowedSlots = document.querySelectorAll(".ut-squad-pitch-view > .ut-squad-slot-view:not(.locked)");
        if (allowedSlots.length === 0) {
          this.state.isRunning = false;
          await this.log("SBC_ERROR", "Kimya şartı var ama müsait slot bulunamadı.", { name });
          return null;
        }
        for (const slot of allowedSlots) {
          const positionCode = slot.querySelector("div.ut-squad-slot-pedestal-view > span.label")?.innerText?.trim();
          if (positionCode) slots.unshift(positionCode);
        }
        if (!slots.length) {
          this.state.isRunning = false;
          await this.log("SBC_ERROR", "Slot pozisyonları okunamadı.", { name });
          return null;
        }
        return slots;
      },

      readSbcPlayersFromPitch(name = "SBC") {
        const pitchView = document.querySelector(".ut-squad-pitch-view");
        if (!pitchView) return [];

        const slotElements = Array.from(pitchView.querySelectorAll(".ut-squad-slot-view:not(.locked)"));
        const players = slotElements.map((slotElement, index) => {
          const slot = this.readSlotLabel(slotElement);
          const card = this.findPlayerCardElement(slotElement);
          if (!card) return null;

          const nameText = this.readPlayerName(card);
          const rating = this.readFirstInt(card, [
            "[class*='rating']",
            "[class*='Rating']",
            ".rating",
            ".ut-player-card--rating"
          ]);
          const position = this.readPlayerPosition(card) || slot;
          const price = this.readPrice(card);
          const rarityInfo = this.readRarityInfo(card);

          if (!nameText && !rating) return null;

          return {
            name: nameText,
            full_name: nameText,
            rating,
            position,
            slot,
            quality: rarityInfo.quality,
            rarity: rarityInfo.rarity,
            futbin_rarity: rarityInfo.futbin_rarity,
            price,
            price_pc: price,
            price_console: price,
            index
          };
        }).filter(Boolean);

        this.log("SBC_PLAYERS", "SBC player bilgileri pitch üzerinden okundu.", {
          name,
          slotCount: slotElements.length,
          playerCount: players.length
        });

        return players;
      },

      readSlotLabel(slotElement) {
        return this.nonNullString(
          slotElement?.querySelector("div.ut-squad-slot-pedestal-view > span.label")?.innerText ||
          slotElement?.querySelector("[class*='pedestal'] span.label")?.innerText ||
          slotElement?.querySelector("[class*='position']")?.innerText ||
          slotElement?.getAttribute("aria-label")
        ).trim();
      },

      findPlayerCardElement(slotElement) {
        const candidates = [
          ".ut-player-card",
          ".ut-item-card",
          ".listFUTItem",
          "[class*='player-card']",
          "[class*='PlayerCard']",
          "[class*='playerCard']",
          "[class*='card'][class*='player']",
          "[class*='item-card']",
          "[class*='ItemCard']"
        ];
        for (const selector of candidates) {
          const element = slotElement?.querySelector(selector);
          if (element) return element;
        }
        const image = slotElement?.querySelector("img[alt], img[src*='players'], img[src*='items/images']");
        return image?.closest("[class*='card'], [class*='item'], [class*='player']") || null;
      },

      readPlayerName(card) {
        const selectors = [
          "[class*='name']",
          "[class*='Name']",
          ".ut-player-card--name",
          ".player-name",
          ".name"
        ];
        for (const selector of selectors) {
          const text = this.nonNullString(card.querySelector(selector)?.innerText || card.querySelector(selector)?.textContent).trim();
          if (text && !/^\d+$/.test(text)) return text;
        }
        const alt = this.nonNullString(card.querySelector("img[alt]")?.getAttribute("alt")).trim();
        if (alt && !/club|nation|rarity|card/i.test(alt)) return alt;
        return this.nonNullString(card.getAttribute("aria-label") || card.getAttribute("title")).trim();
      },

      readPlayerPosition(card) {
        const selectors = [
          "[class*='position']",
          "[class*='Position']",
          ".ut-player-card--position",
          ".position"
        ];
        for (const selector of selectors) {
          const text = this.nonNullString(card.querySelector(selector)?.innerText || card.querySelector(selector)?.textContent).trim();
          if (/^[A-Z]{1,3}$/.test(text)) return text;
        }
        const text = this.nonNullString(card.innerText || card.textContent);
        const match = text.match(/\b(GK|CB|LB|RB|LWB|RWB|CDM|CM|CAM|LM|RM|LW|RW|CF|ST)\b/i);
        return match ? match[1].toUpperCase() : "";
      },

      readFirstInt(root, selectors = []) {
        for (const selector of selectors) {
          const text = this.nonNullString(root.querySelector(selector)?.innerText || root.querySelector(selector)?.textContent);
          const number = this.normalizeSyncInt(text);
          if (number != null) return number;
        }
        return null;
      },

      readPrice(card) {
        const text = this.nonNullString(card.innerText || card.textContent);
        const priceMatch = text.match(/([\d.,]+)\s*(K|M)\b/i) ||
          (text.toLowerCase().includes("coin") ? text.match(/([\d.,]+)/i) : null);
        if (!priceMatch) return null;
        const base = Number(priceMatch[1].replace(/,/g, "."));
        if (!Number.isFinite(base)) return null;
        const suffix = this.nonNullString(priceMatch[2]).toUpperCase();
        if (suffix === "M") return Math.round(base * 1000000);
        if (suffix === "K") return Math.round(base * 1000);
        return Math.round(base);
      },

      readRarityInfo(card) {
        const source = [
          card.className,
          ...Array.from(card.querySelectorAll("img")).map((img) => `${img.src || ""} ${img.alt || ""}`)
        ].join(" ").toLowerCase();
        const quality = source.includes("bronze")
          ? "bronze"
          : source.includes("silver")
            ? "silver"
            : source.includes("gold")
              ? "gold"
              : source.includes("special")
                ? "special"
                : "";
        const rarityMatch = source.match(/(?:cards|card)[^\s]*\/(?:tiny|hd)?\/?(\d+_[a-z0-9_]+)/i) ||
          source.match(/\b(\d+_[a-z0-9_]*(?:bronze|silver|gold|special)[a-z0-9_]*)\b/i);
        const futbinRarity = rarityMatch ? rarityMatch[1] : "";
        const rarity = futbinRarity ? futbinRarity.split("_")[0] : "";
        return { quality, rarity, futbin_rarity: futbinRarity };
      },

      async readSbcPlayersFromWebApp({ categoryName, parentName, detailSbcName, nameIndex = 0 }) {
        const players = this.readSbcPlayersFromPitch(detailSbcName || parentName);
        await this.log(players.length ? "SBC_PLAYERS" : "SBC_WARN", players.length
          ? "SBC player bilgileri Web App pitch üzerinden kullanıldı."
          : "SBC player bilgisi Web App pitch üzerinde bulunamadı; boş oyuncu listesiyle devam ediliyor.", {
          categoryName,
          parentName,
          detailSbcName,
          nameIndex,
          playerCount: players.length
        });
        return players;
      },

      formationIdFromScreen(name) {
        const pitchView = document.querySelector(".ut-squad-pitch-view");
        const classList = Array.from(pitchView?.classList || []);
        const fcode = classList.find((className) => /^f\d+/i.test(className)) || classList[classList.length - 1] || null;
        const formation = this.state.formations.find((item) => item?.code === fcode);
        const formationId = Number(formation?.id) || 0;
        if (!formationId) this.log("SBC_ERROR", "Formation bilgisi okunamadı.", { name, fcode });
        return formationId;
      },

      async waitForTilesReady() {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 10000) {
          if (this.stopped()) return false;
          const tiles = document.querySelectorAll(this.selectors.tileView);
          const notReady = [...tiles].filter((tile) => {
            const title = tile.querySelector(this.selectors.tileTitle)?.innerText?.trim();
            const name = tile.querySelector(this.selectors.tileName)?.innerText?.trim();
            const desc = tile.querySelector(this.selectors.tileDesc)?.innerText?.trim();
            const iconUrl = tile.querySelector(this.selectors.tileIconUrl)?.src;
            return !title || !name || !desc || !iconUrl;
          });
          if (tiles.length > 0 && notReady.length === 0) return true;
          await this.sleep(150);
        }
        return false;
      },

      async waitForSubRowsReady(expectedCount = 0) {
        const startedAt = Date.now();
        const expected = Number(expectedCount) || 0;
        while (Date.now() - startedAt < 12000) {
          if (this.stopped()) return false;
          const rows = Array.from(document.querySelectorAll(this.selectors.subRow));
          const readyRows = rows.filter((row) => {
            const icon = row.querySelector(this.selectors.subTileIconUrl)?.src ||
              row.querySelector(this.selectors.subTileIconUrl)?.getAttribute("src");
            const name = row.querySelector(this.selectors.subTileName)?.innerText?.trim();
            return icon && name;
          });
          if (rows.length > 0 && readyRows.length === rows.length && (!expected || rows.length >= expected)) return true;
          await this.sleep(150);
        }
        return false;
      },

      async readSubRows(lang, dbSubs = [], expectedCount = null, parentName = "", categoryName = "") {
        const expectedRows = Number(expectedCount);
        if (Number.isInteger(expectedRows) && expectedRows > 0) {
          const rowsReady = await this.waitForSubRowsReady(expectedRows);
          if (!rowsReady) {
            this.state.isRunning = false;
            await this.log("SBC_ERROR", "Sub row DOM hazır değil.", { expectedRows });
            return null;
          }
        } else {
          await this.waitForElement(this.selectors.subRow, 10000);
        }

        const subs = [];
        let subSortNo = 1;
        for (let rowIdx = 0; rowIdx < document.querySelectorAll(this.selectors.subRow).length; rowIdx += 1) {
          if (this.stopped()) return null;
          const currentRows = Array.from(document.querySelectorAll(this.selectors.subRow));
          const row = currentRows[rowIdx];
          if (!row) break;

          const dbSub = dbSubs?.[rowIdx];
          const rowIconUrl = row.querySelector(this.selectors.subTileIconUrl)?.src || dbSub?.icon_url || null;
          const rowName = row.querySelector(this.selectors.subTileName)?.innerText?.trim() ||
            (dbSub ? this.getLocalized(dbSub.name, lang) : null);
          const rowRepeatable = this.detectRepeatableFromTile(row);
          const rowRepeatCount = this.detectRepeatCountFromTile(row);
          const rowRepeatableText = this.getRepeatableTextFromTile(row);
          const rowDaily = this.detectDailyFromName(rowName);
          const rowRepeatCompare = dbSub
            ? this.compareRepeatableFields(dbSub, {
              repeatable: rowRepeatable,
              repeat_count: rowRepeatCount,
              daily: rowDaily,
              repeatable_text: rowRepeatableText,
              repeatable_source: "sub_row_status_label"
            })
            : { changed: false, changedFields: [], db: null, screen: null };
          const dbSubNameReady = dbSub && this.getLocalized(dbSub.name, lang).trim();
          const dbSubReqsReady = dbSub && this.reqsHasRowsForLang(dbSub.reqs, lang);
          const dbSubPlayersReady = dbSub && this.hasExistingSbcPlayers(dbSub);

          if (dbSubNameReady && dbSubReqsReady && dbSubPlayersReady && !rowRepeatCompare.changed) {
            subs.push(this.buildExistingSbcEntryForRepeatUpdate(dbSub, {
              sort_no: subSortNo++,
              icon_url: rowIconUrl,
              name: rowName,
              repeatable: rowRepeatable,
              repeat_count: rowRepeatCount,
              daily: rowDaily,
              repeatable_text: rowRepeatableText,
              repeatable_source: "sub_row_status_label",
              group: false
            }, lang));
            continue;
          }

          if (dbSubNameReady && dbSubReqsReady && dbSubPlayersReady && rowRepeatCompare.changed) {
            const repeatUpdateSub = this.buildExistingSbcEntryForRepeatUpdate(dbSub, {
              sort_no: subSortNo++,
              icon_url: rowIconUrl,
              name: rowName,
              repeatable: rowRepeatable,
              repeat_count: rowRepeatCount,
              daily: rowDaily,
              repeatable_text: rowRepeatableText,
              repeatable_source: "sub_row_status_label",
              group: false
            }, lang);
            repeatUpdateSub.force_update = true;
            repeatUpdateSub.update_reason = "repeatable_fields_changed";
            repeatUpdateSub.repeatable_changed_fields = rowRepeatCompare.changedFields;
            subs.push(repeatUpdateSub);
            continue;
          }

          await this.click(row);
          await this.waitForElement(".btn-standard.primary", 5000);
          const goToChallengeBtn = document.querySelector(".btn-standard.primary");
          if (!goToChallengeBtn) {
            await this.log("SBC_WARN", "Go to Challenge butonu bulunamadı, sub SBC atlandı.", { rowIdx });
            continue;
          }
          await this.click(goToChallengeBtn);
          await this.waitForElement(".ut-squad-pitch-view", 10000);

          const rowsAfterClick = Array.from(document.querySelectorAll(this.selectors.subRow));
          const currentSubRow = rowsAfterClick[rowIdx] || row;
          const icon_url = currentSubRow?.querySelector(this.selectors.subTileIconUrl)?.src || null;
          const name = currentSubRow?.querySelector(this.selectors.subTileName)?.innerText?.trim() || null;
          const desc = currentSubRow?.querySelector(this.selectors.tileDesc)?.innerText?.trim() || null;
          const reward = document.querySelector("div.ut-sbc-challenge-details-view > div.rewards-container > ul > li > div.rowContent > div > span.ut-sbc-reward-table-cell-view--label")?.innerText?.trim() || null;
          const repeatable = this.detectRepeatableFromTile(currentSubRow);
          const repeat_count = this.detectRepeatCountFromTile(currentSubRow);
          const repeatable_text = this.getRepeatableTextFromTile(currentSubRow);
          const repeatable_source = "sub_row_status_label";
          const name_index = subs.filter((item) => item.name === name).length;
          const reqs = await this.readReqsOrStop(name || `Sub ${rowIdx + 1}`, lang, 10000);
          if (!reqs) return null;

          await this.waitForElement(".ut-squad-pitch-view", 10000);
          const formation_id = this.formationIdFromScreen(name);
          if (!formation_id) {
            this.state.isRunning = false;
            return null;
          }

          const slots = await this.readSlots(lang, reqs, name);
          if (slots === null) return null;
          const sbc_players = await this.readSbcPlayersFromWebApp({
            categoryName,
            parentName,
            detailSbcName: name,
            nameIndex: name_index
          });

          subs.push({
            sort_no: subSortNo++,
            icon_url,
            name,
            desc,
            reward,
            repeatable,
            repeat_count,
            daily: this.detectDailyFromName(name),
            repeatable_text,
            repeatable_source,
            reqs,
            formation_id,
            slots,
            sbc_players,
            name_index
          });

          const backBtn = document.querySelector(this.selectors.backBtn);
          if (!backBtn) return null;
          await this.click(backBtn);
          await this.waitForElement(this.selectors.subRow, 10000);
        }
        return subs;
      },

      async syncLatestSbcScreenDataByCategory(categoryId, dbList = null, lang = "en", counters) {
        const screenTiles = document.querySelectorAll(this.selectors.tileView);
        const tileInfos = Array.from(screenTiles).map((tile, index) => ({
          name: tile.querySelector(this.selectors.tileName)?.innerText?.trim() || null,
          icon_url: tile.querySelector(this.selectors.tileIconUrl)?.src || null,
          sort_number: index + 1,
          reward: tile.querySelector(this.selectors.tileReward)?.innerText?.trim() || null
        })).filter((tile) => tile.name !== null);

        let response = null;
        try {
          response = await this.post("sbc/sync-screen-data-by-category", {
            user_id: 1,
            category_id: Number(categoryId),
            screen_tiles: tileInfos
          });
        } catch (error) {
          await this.log("SBC_WARN", "Screen cleanup API isteği hata döndü; kategori sync devam edecek.", {
            categoryId,
            message: error.message || String(error),
            stack: error.stack || null,
            dbCount: Array.isArray(dbList) ? dbList.length : null,
            lang
          });
          return null;
        }
        if (response?.result) {
          counters.deletedCount += Number(response.data?.deleted_count ?? response.data?.deletedCount) || 0;
          counters.updatedSortCount += Number(response.data?.updated_sort_count ?? response.data?.updatedSortCount) || 0;
        } else {
          await this.log("SBC_WARN", "Screen cleanup hatası.", {
            categoryId,
            message: response?.message || null,
            dbCount: Array.isArray(dbList) ? dbList.length : null,
            lang
          });
        }
        return response;
      },

      async ensureDependencies() {
        if (!this.state.formations.length) {
          const formationRes = await this.get("formation");
          if (!formationRes?.result) {
            throw new Error(`[CRITICAL] Formation listesi alınamadı: ${formationRes?.message || "Bilinmeyen hata"}`);
          }
          this.state.formations = Array.isArray(formationRes.data) ? formationRes.data : [];
          await this.log("SBC", "Formation dependency yüklendi.", { count: this.state.formations.length });
        }
      },

      async doSyncSbc(lang) {
        const normalizedLang = normalizeLang(lang);
        this.state.currentLang = normalizedLang;
        this.state.loc = TEXT[normalizedLang] || TEXT.en;
        this.state.isRunning = true;
        localStorage.removeItem("sbcai_stop_sync");
        await this.ensureDependencies();
        await this.log("SBC", "SBC dil fazı başladı.", { lang: normalizedLang });

        const counters = {
          lang: normalizedLang,
          dbCount: 0,
          categoryCount: 0,
          processedCategoryCount: 0,
          tileCount: 0,
          savedCount: 0,
          skippedCount: 0,
          postedCount: 0,
          failedCount: 0,
          insertedCount: 0,
          updatedCount: 0,
          deletedCount: 0,
          tileDeletedCount: 0,
          updatedSortCount: 0,
          aborted: false,
          errorMessage: null,
          completedAt: null
        };

        const dbRes = await this.get("sbc");
        if (!dbRes?.result) throw new Error(`[CRITICAL] DB SBC listesi alınamadı: ${dbRes?.message || "Bilinmeyen hata"}`);
        const dbList = Array.isArray(dbRes.data) ? dbRes.data : [];
        counters.dbCount = dbList.length;
        const dbMap = this.buildDbMap(dbList, normalizedLang);
        const dbIdentityMap = this.buildDbIdentityMap(dbList);

        await this.click(this.selectors.homeBtn);
        const sbcBtn = await this.waitForElement(this.selectors.sbcBtn, 5000);
        if (!sbcBtn) throw new Error("[CRITICAL] SBC butonu bulunamadı.");
        await this.click(sbcBtn);
        const firstFilter = await this.waitForElement(this.selectors.filterItem, 5000);
        if (!firstFilter) throw new Error("[CRITICAL] SBC kategori filter bar bulunamadı.");

        const catRes = await this.get("sbccategory");
        if (!catRes?.result) throw new Error(`[CRITICAL] SBC kategori listesi alınamadı: ${catRes?.message || "Bilinmeyen hata"}`);
        const syncCats = (Array.isArray(catRes.data) ? catRes.data : []).filter((category) => category.sync);
        counters.categoryCount = syncCats.length;
        await this.log("SBC", "Senkronize edilecek SBC kategorileri hazır.", {
          lang: normalizedLang,
          categoryCount: syncCats.length,
          dbCount: dbList.length
        });

        for (const category of syncCats) {
          if (this.stopped()) break;
          const categoryName = this.getLocalized(category.name, normalizedLang).trim().toLowerCase();
          const categoryId = Number(category.id ?? category.Id ?? category.category_id ?? category.CategoryId ?? 0);
          await this.log("SBC_CATEGORY_START", "SBC kategori işleniyor.", {
            lang: normalizedLang,
            categoryName,
            categoryId
          });
          if (!categoryName || !categoryId) {
            await this.log("SBC_WARN", "Kategori adı veya ID geçersiz, atlandı.", { category });
            continue;
          }

          const currentFilter = Array.from(document.querySelectorAll(this.selectors.filterItem))
            .find((element) => element.innerText?.trim().toLowerCase() === categoryName);
          if (!currentFilter) {
            await this.log("SBC_WARN", "DOM'da kategori filtresi bulunamadı, atlandı.", {
              categoryName,
              lang: normalizedLang
            });
            continue;
          }

          await this.click(currentFilter);
          await this.waitForElement(this.selectors.tileView, 5000);
          const tilesReady = await this.waitForTilesReady();
          if (!tilesReady) {
            await this.log("SBC_WARN", "Kategori tile'ları hazır olmadı, kategori atlandı.", {
              categoryName
            });
            continue;
          }

          if (normalizedLang === "en") {
            await this.syncLatestSbcScreenDataByCategory(categoryId, dbList, normalizedLang, counters);
          }

          const anyComplete = Array.from(document.querySelectorAll(this.selectors.tileView))
            .some((tile) => tile.classList.contains("complete"));
          if (anyComplete) {
            await this.log("SBC", "Kategori atlandı; tamamlanmış öğe bulundu.", { categoryName });
            continue;
          }

          counters.processedCategoryCount += 1;
          let tileIndex = 0;
          let tileSortNo = 1;
          let hasInvalidTile = false;
          let invalidReason = null;

          while (!hasInvalidTile) {
            if (this.stopped()) break;
            const tiles = document.querySelectorAll(this.selectors.tileView);
            if (tileIndex >= tiles.length) break;
            const tile = tiles[tileIndex];
            counters.tileCount += 1;

            const qs = (selector) => tile.querySelector(selector);
            const icon_url = qs(this.selectors.tileIconUrl)?.src || null;
            const name = qs(this.selectors.tileName)?.innerText?.trim() || null;
            const desc = qs(this.selectors.tileDesc)?.innerText?.trim() || null;
            if (!icon_url || !name || !desc) {
              await this.log("SBC_ERROR", "Zorunlu tile alanı eksik; kategori döngüsü durduruldu.", {
                icon_url,
                name,
                desc,
                categoryName
              });
              invalidReason = "Zorunlu tile alanı eksik.";
              hasInvalidTile = true;
              break;
            }

            const progressText = qs(this.selectors.tileProgressLabel)?.innerText?.trim() || "";
            const subCount = this.parseSubCount(progressText);
            const isGroup = subCount > 1;
            const sub_count = qs(this.selectors.tileSubCount)?.innerText?.trim() || null;
            const reward = qs(this.selectors.tileReward)?.innerText?.trim() || null;
            const repeatable = this.detectRepeatableFromTile(tile);
            const repeat_count = this.detectRepeatCountFromTile(tile);
            const repeatable_text = this.getRepeatableTextFromTile(tile);
            const repeatable_source = "tile_status_label";
            const daily = this.detectDailyFromName(name);
            const tileContext = {
              lang: normalizedLang,
              categoryName,
              categoryId,
              tileIndex,
              sortNo: tileSortNo,
              name,
              desc,
              reward,
              isGroup,
              subCount
            };
            await this.log("SBC_TILE_START", "SBC tile değerlendiriliyor.", tileContext);

            const dbKey = this.buildScreenTileKey({ categoryId, icon_url, name, desc, reward });
            const dbIdentityKey = this.buildDbIdentityKey({ categoryId, sort_no: tileSortNo, group: isGroup });
            const dbVisibleEntry = dbMap[dbKey] || null;
            const dbIdentityEntry = dbIdentityMap[dbIdentityKey] || null;
            const dbEntry = dbVisibleEntry;
            const visibleCompare = dbEntry
              ? this.compareVisibleTileFields(dbEntry, { icon_url, name, desc, reward }, normalizedLang)
              : { changed: false, changedFields: [], db: null, screen: null };
            const repeatCompare = dbEntry
              ? this.compareRepeatableFields(dbEntry, { repeatable, repeat_count, daily, repeatable_text, repeatable_source })
              : { changed: false, changedFields: [], db: null, screen: null };

            const visibleFieldChanged = Boolean(dbEntry && visibleCompare.changed);
            const repeatableFieldChanged = repeatCompare.changed;
            const shouldUpdateBackend = !dbEntry || repeatableFieldChanged;
            const shouldOpenDetail = !dbEntry;
            const repeatableOnlyChange = dbEntry && repeatableFieldChanged;
            const decisionReason = !dbEntry
              ? "new_tile"
              : repeatableFieldChanged
                ? `repeatable_fields_changed:${repeatCompare.changedFields.join(",")}`
                : "unchanged";

            await this.log("SBC_TILE_DECISION", "SBC tile karar verildi.", {
              ...tileContext,
              dbFound: Boolean(dbEntry),
              matchedBy: dbVisibleEntry ? "visible" : (dbIdentityEntry ? "identity_ignored" : "none"),
              visibleFieldChanged,
              visibleChangedFields: visibleCompare.changedFields,
              repeatableFieldChanged,
              repeatableChangedFields: repeatCompare.changedFields,
              shouldUpdateBackend,
              shouldOpenDetail,
              reason: decisionReason
            });

            if (!shouldUpdateBackend) {
              counters.skippedCount += 1;
              tileSortNo += 1;
              tileIndex += 1;
              continue;
            }

            const sbcEntry = {
              sort_no: tileSortNo++,
              category: currentFilter.innerText?.trim(),
              icon_url,
              name,
              desc,
              sub_count,
              reward,
              repeatable,
              repeat_count,
              daily,
              repeatable_text,
              repeatable_source,
              group: isGroup,
              subs: [],
              child_count: isGroup ? subCount : 0,
              exist: false,
              force_update: repeatCompare.changed,
              update_reason: repeatableOnlyChange ? "repeatable_fields_changed_only" : null,
              repeatable_changed_fields: repeatCompare.changedFields
            };

            if (!shouldOpenDetail) {
              const repeatUpdateEntry = this.buildExistingSbcEntryForRepeatUpdate(dbEntry, {
                sort_no: sbcEntry.sort_no,
                category: currentFilter.innerText?.trim(),
                icon_url,
                name,
                desc,
                sub_count,
                reward,
                repeatable,
                repeat_count,
                daily,
                repeatable_text,
                repeatable_source,
                group: isGroup,
                child_count: Number(dbEntry?.child_count) || (isGroup ? subCount : 0)
              }, normalizedLang);
              repeatUpdateEntry.force_update = true;
              repeatUpdateEntry.update_reason = repeatableOnlyChange ? "repeatable_fields_changed_only" : `repeatable_fields_changed:${repeatCompare.changedFields.join(",")}`;
              repeatUpdateEntry.repeatable_changed_fields = repeatCompare.changedFields;
              repeatUpdateEntry.subs = [];
              const postResult = await this.postTileData(categoryId, repeatUpdateEntry, normalizedLang, counters);
              if (!postResult) {
                if (this.isRecoverableTilePostFailure(counters)) {
                  await this.log("SBC_WARN", "Repeatable tile kayıt isteği başarısız oldu; sonraki tile ile devam edilecek.", {
                    categoryName,
                    name,
                    lastError: counters.lastError || null
                  });
                  tileIndex += 1;
                  continue;
                }
                invalidReason = `Repeatable tile kayıt isteği başarısız: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
              tileIndex += 1;
              continue;
            }

            if (isGroup) {
              await this.click(tile);
              await this.waitForElement(this.selectors.subRow, 10000);
              const subs = await this.readSubRows(normalizedLang, dbEntry?.subs || [], subCount, name, currentFilter.innerText?.trim() || categoryName);
              if (subs === null) {
                invalidReason = `Sub SBC bilgileri okunamadı: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
              sbcEntry.subs = subs || [];
              sbcEntry.child_count = sbcEntry.subs.length;
              if (sbcEntry.child_count === 0 || sbcEntry.child_count !== subCount) {
                this.state.isRunning = false;
                await this.log("SBC_ERROR", "Geçersiz child_count.", {
                  name,
                  current: sbcEntry.child_count,
                  expected: subCount
                });
                invalidReason = `Geçersiz child_count: ${categoryName} > ${name} (${sbcEntry.child_count}/${subCount})`;
                hasInvalidTile = true;
                break;
              }

              const backBtn = document.querySelector(this.selectors.backBtn);
              if (backBtn) {
                await this.click(backBtn);
                await this.waitForElement(this.selectors.filterItem, 10000);
              }
              const catFilterEl = Array.from(document.querySelectorAll(this.selectors.filterItem))
                .find((element) => element.innerText?.trim().toLowerCase() === categoryName);
              if (catFilterEl) await this.click(catFilterEl);
              await this.waitForElement(this.selectors.tileView, 5000);
              if (!await this.waitForTilesReady()) {
                invalidReason = `Kategori tile listesi geri dönüş sonrası hazır olmadı: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
              const postResult = await this.postTileData(categoryId, sbcEntry, normalizedLang, counters);
              if (!postResult) {
                if (this.isRecoverableTilePostFailure(counters)) {
                  await this.log("SBC_WARN", "Group SBC tile-sync isteği başarısız oldu; sonraki tile ile devam edilecek.", {
                    categoryName,
                    name,
                    lastError: counters.lastError || null
                  });
                  tileIndex += 1;
                  continue;
                }
                invalidReason = `Group SBC tile-sync kayıt isteği başarısız: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
            } else if (shouldOpenDetail) {
              await this.click(tile);
              await this.waitForElement(".ut-squad-pitch-view", 10000);
              sbcEntry.reqs = await this.readReqsOrStop(name, normalizedLang, 10000);
              if (!sbcEntry.reqs) {
                invalidReason = `SBC requirements okunamadı: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
              await this.waitForElement(".ut-squad-pitch-view", 10000);
              const formation_id = this.formationIdFromScreen(name);
              sbcEntry.formation_id = formation_id;
              if (!formation_id) {
                this.state.isRunning = false;
                invalidReason = `Formation bilgisi okunamadı: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }

              const slots = await this.readSlots(normalizedLang, sbcEntry.reqs, name);
              if (slots === null) {
                invalidReason = `Slot bilgileri okunamadı: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
              sbcEntry.slots = slots;
              const sbcPlayers = await this.readSbcPlayersFromWebApp({
                categoryName: currentFilter.innerText?.trim() || categoryName,
                parentName: name,
                detailSbcName: name,
                nameIndex: 0
              });
              sbcEntry.sbc_players = sbcPlayers;

              const backBtn = document.querySelector(this.selectors.backBtn);
              if (backBtn) {
                await this.click(backBtn);
                await this.waitForElement(this.selectors.filterItem, 10000);
              }
              const catFilterSingle = Array.from(document.querySelectorAll(this.selectors.filterItem))
                .find((element) => element.innerText?.trim().toLowerCase() === categoryName);
              if (catFilterSingle) await this.click(catFilterSingle);
              await this.waitForElement(this.selectors.tileView, 5000);
              if (!await this.waitForTilesReady()) {
                invalidReason = `Single SBC dönüş sonrası tile listesi hazır olmadı: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
              const postResult = await this.postTileData(categoryId, sbcEntry, normalizedLang, counters);
              if (!postResult) {
                if (this.isRecoverableTilePostFailure(counters)) {
                  await this.log("SBC_WARN", "Single SBC tile-sync isteği başarısız oldu; sonraki tile ile devam edilecek.", {
                    categoryName,
                    name,
                    lastError: counters.lastError || null
                  });
                  tileIndex += 1;
                  continue;
                }
                invalidReason = `Single SBC tile-sync kayıt isteği başarısız: ${categoryName} > ${name}`;
                hasInvalidTile = true;
                break;
              }
            }

            tileIndex += 1;
          }

          if (hasInvalidTile || this.stopped()) {
            counters.aborted = true;
            counters.failedCount += counters.failedCount > 0 ? 0 : 1;
            counters.errorMessage = invalidReason || (this.stopped() ? "SBC sync durduruldu." : "SBC sync geçersiz tile nedeniyle durdu.");
            await this.log("SBC_ABORT", "SBC kategori döngüsü hata nedeniyle durdu.", {
              lang: normalizedLang,
              categoryName,
              reason: counters.errorMessage,
              lastError: counters.lastError || null
            });
            break;
          }
        }

        counters.completedAt = Date.now();
        await this.log("SBC", "SBC dil fazı tamamlandı.", counters);
        return counters;
      }
    };

    return runner;
  }

  function normalizeLang(value) {
    const lang = String(value || "en").toLowerCase();
    return lang.startsWith("tr") ? "tr" : "en";
  }

})();
