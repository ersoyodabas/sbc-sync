const el = (id) => document.getElementById(id);
const API_CONFIG = globalThis.FutbinSyncApiConfig;
const compactStyles = document.createElement("link");
compactStyles.rel = "stylesheet";
compactStyles.href = "compact.css";
document.head.appendChild(compactStyles);
let latestState = null;
const statusElement = el("status");
const statusRow = document.createElement("div");
statusRow.className = "status-row";
statusElement.parentNode.insertBefore(statusRow, statusElement);
statusRow.appendChild(statusElement);
statusRow.insertAdjacentHTML("beforeend", `<svg id="status-loader" class="status-loader" viewBox="0 0 24 24" aria-label="İşlem devam ediyor" hidden><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3"/><path d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6z"/></svg>`);
el("start").classList.add("compact-action");
el("start").innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg><span>Başlat</span>`;
el("network").classList.add("compact-action");
el("network").innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.7 0 3.3 2.4 3.8 6H8.2C8.7 6.4 10.3 4 12 4zM4.3 10A8 8 0 0 1 7 5.4 16 16 0 0 0 6.2 10zm0 4h1.9c.2 1.8.5 3.3.9 4.6A8 8 0 0 1 4.3 14zm3.9 0h7.6c-.5 3.6-2.1 6-3.8 6s-3.3-2.4-3.8-6zm8.8 4.6c.4-1.3.7-2.8.9-4.6h1.9a8 8 0 0 1-2.8 4.6zM17.8 10c-.2-1.8-.5-3.3-.9-4.6a8 8 0 0 1 2.8 4.6z"/></svg>`;
el("start").onclick = () => send("START_SYNC");
el("stop").onclick = () => send("STOP_SYNC");
el("clear").onclick = () => send("CLEAR_SYNC");
el("network").onclick = () => send("OPEN_NETWORK_MONITOR");
chrome.runtime.onMessage.addListener((m) => { if (m.type === "STATE_CHANGED") render(m.state); });
API_CONFIG.ready.then(() => {
  API_CONFIG.defaultBaseUrl();
}).catch((error) => alert(error.message));
async function send(type, payload = {}) { const r = await chrome.runtime.sendMessage({ type, ...payload }); if (!r.ok) alert(r.error); render((await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" })).state); return r; }
function render(s) {
  latestState = s;
  API_CONFIG.allowedBaseUrl();
  el("status").textContent = s.status || "Hazır"; el("dot").classList.toggle("running", !!s.running);
  el("status-loader").hidden = !s.running || !!s.waitingForNextRun;
  el("start").hidden = !!s.running; el("stop").hidden = !s.running;
  el("pages").textContent = `${s.currentPage || 0} / ${s.totalPages || 0}`;
  el("parsed").textContent = s.parsedPlayers || 0; el("mapped").textContent = s.mappedPlayers || 0;
  el("saved").textContent = s.savedPlayers || 0; el("skipped").textContent = s.skippedPlayers || 0;
  el("results").textContent = `Insert ${s.insertedPlayers || 0} · Update ${s.updatedPlayers || 0}`;
  el("round").textContent = s.roundNumber || 0;
  el("next").textContent = `Sonraki çalışma: ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("tr-TR") : "—"}`;
  renderCountdown();
  el("bar").style.width = `${s.totalPages ? Math.min(100, (s.currentPage / s.totalPages) * 100) : 0}%`;
  renderLogs(s.logs || []);
  renderErrors(s.errors || []);
}

function renderLogs(logs) {
  const container = el("logs");
  container.innerHTML = "";
  const rows = logs
    .filter((entry) => !/^SKIP #/i.test(entry.message) && !/tur hata ile durdu:/i.test(entry.message))
    .slice(-80)
    .reverse();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "log-line log-empty";
    empty.textContent = "Henüz log yok.";
    container.appendChild(empty);
    return;
  }
  rows.forEach((entry) => {
    const line = document.createElement("div");
    line.className = "log-line info";
    const icon = document.createElement("span");
    icon.className = "log-icon";
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 14.5h-2V16h2v.5Zm0-3.5h-2V7h2v6Z"/></svg>`;
    const text = document.createElement("span");
    text.textContent = `${new Date(entry.at).toLocaleTimeString("tr-TR")}  ${entry.message}`;
    line.appendChild(icon);
    line.appendChild(text);
    container.appendChild(line);
  });
}

function renderErrors(errors) {
  const container = el("errors");
  container.innerHTML = "";
  const rows = errors;
  el("error-count").textContent = `${rows.length} kayıt`;
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "log-line log-empty";
    empty.textContent = "Hata yok.";
    container.appendChild(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "error-table";
  table.innerHTML = "<thead><tr><th>#</th><th>Oyuncu</th><th>Player ID</th><th>Club</th><th>League</th><th>Nation</th><th>Rarity</th><th>Position</th><th>Quality</th><th>Mesaj</th></tr></thead>";
  const tbody = document.createElement("tbody");
  rows.forEach((error, index) => {
    const detail = errorDetail(error);
    const row = document.createElement("tr");
    if (detail.url) {
      row.className = "clickable-error-row";
      row.tabIndex = 0;
      row.setAttribute("role", "link");
      row.setAttribute("aria-label", `${detail.player || "Oyuncu"} Futbin sayfasını aç`);
      row.title = "Futbin sayfasını yeni sekmede aç";
      row.addEventListener("click", () => openFutbinUrl(detail.url));
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openFutbinUrl(detail.url);
      });
    }
    [index + 1, detail.player, detail.playerId, detail.club, detail.league, detail.nation, detail.rarity, detail.position, detail.quality, detail.message].forEach((value) => {
      const cell = document.createElement("td"); cell.textContent = value || "—"; row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody); container.appendChild(table);
}
function errorDetail(error) {
  if (error && typeof error === "object") {
    const playerRecord = error.player && typeof error.player === "object" ? error.player : null;
    const playerId = error.futbin_player_id || error.futbinPlayerId || error.FutbinPlayerId ||
      error.player_id || playerRecord?.futbin_player_id || playerRecord?.futbinPlayerId;
    const playerLink = error.futbin_player_link || error.futbinPlayerLink || error.FutbinPlayerLink ||
      error.futbin_player_url || error.futbin_url || error.player_url || error.url ||
      playerRecord?.futbin_player_link || playerRecord?.futbinPlayerLink || playerRecord?.url;
    return { player: playerRecord?.name || playerRecord?.full_name || error.player || error.record || error.name,
    playerId, club: error.futbin_club_id || error.club_id,
    league: error.futbin_league_id || error.league_id, nation: error.futbin_nation_id || error.nation_id,
    rarity: error.futbin_rarity_id || error.rarity_id, position: error.position_name || error.position,
    quality: error.quality_code || error.quality, message: error.message || error.error || JSON.stringify(error),
    url: futbinUrl(playerLink) };
  }
  const message = String(error || "");
  if (message.trim().startsWith("{")) {
    try {
      return errorDetail(JSON.parse(message));
    } catch {
      // Eski string hata formatıyla devam et.
    }
  }
  const value = (key) => message.match(new RegExp(`${key}\\s*[=:]\\s*([^\\s·;|()]+)`, "i"))?.[1];
  const player = message.match(/^(.*?)\s*(?:\||:)/)?.[1];
  const reason = message.match(/Sebep:\s*(.*?)(?:\s*\|\s*Futbin:|$)/i)?.[1] || message;
  const playerId = value("futbin_player_id");
  const urlInMessage = message.match(/https?:\/\/(?:www\.)?futbin\.com\/[^\s"'|]+/i)?.[0];
  return { player, playerId, club: value("futbin_club_id"),
    league: value("futbin_league_id"), nation: value("futbin_nation_id"), rarity: value("futbin_rarity_id"),
    position: value("position"), quality: value("quality"), message: reason, url: futbinUrl(urlInMessage) };
}
function futbinUrl(value) {
  if (value) {
    try {
      const url = new URL(String(value), "https://www.futbin.com");
      if (url.hostname === "futbin.com" || url.hostname.endsWith(".futbin.com")) return url.href;
    } catch {
      return "";
    }
  }
  return "";
}
function openFutbinUrl(url) {
  if (!url) return;
  chrome.tabs.create({ url });
}
function renderCountdown() {
  const target = Number(latestState?.nextRunAt);
  if (!latestState?.running) { el("countdown").textContent = "DURDURULDU"; return; }
  if (!latestState?.waitingForNextRun || !target) { el("countdown").textContent = "İŞLENİYOR"; return; }
  const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  el("countdown").textContent = `${hours}:${minutes}:${remainder}`;
}
setInterval(renderCountdown, 1000);
send("GET_SNAPSHOT").catch(console.error);
