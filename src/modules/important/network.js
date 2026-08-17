const port = chrome.runtime.connect({ name: "important-players-network" });
const status = document.getElementById("status");
const requests = document.getElementById("requests");
const activeRequests = new Set();
let connected = true;
status.textContent = "Bağlı — request bekleniyor";
port.onMessage.addListener(async (message) => {
  console.groupCollapsed(`[ImportantPlayersSync Network] ${message.method} ${message.url}`);
  console.log("Request headers:", message.headers);
  console.log("Request body:", message.body);
  try { console.log("Request JSON:", message.body ? JSON.parse(message.body) : null); } catch { /* JSON olmayan body */ }
  console.groupEnd();
  const item = document.createElement("li");
  item.textContent = `${message.method} ${message.url} — gönderiliyor`;
  requests.prepend(item);
  try {
    const response = await xhrRequest(message);
    const text = response.text;
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    console.log(`[ImportantPlayersSync Network Response] ${response.status} ${message.url}`, data);
    item.className = response.ok ? "ok" : "error";
    item.textContent = `${message.method} ${message.url} — HTTP ${response.status}`;
    if (connected) port.postMessage({ id: message.id, ok: true, responseOk: response.ok, status: response.status, data });
  } catch (error) {
    console.error(`[ImportantPlayersSync Network Error] ${message.url}`, error);
    item.className = "error";
    item.textContent = `${message.method} ${message.url} — ${error.message}`;
    if (connected) port.postMessage({ id: message.id, ok: false, error: error.message });
  }
});
port.onDisconnect.addListener(() => {
  connected = false;
  activeRequests.forEach((xhr) => xhr.abort());
  activeRequests.clear();
  status.textContent = "Bağlantı kesildi";
  status.className = "error";
});

function xhrRequest(message) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeRequests.add(xhr);
    xhr.open(message.method, message.url, true);
    xhr.timeout = 30000;
    Object.entries(message.headers || {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.onload = () => {
      activeRequests.delete(xhr);
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: xhr.responseText || "" });
    };
    xhr.onerror = () => { activeRequests.delete(xhr); reject(new Error(`XHR network error: ${message.url}`)); };
    xhr.ontimeout = () => { activeRequests.delete(xhr); reject(new Error(`XHR timeout: ${message.url}`)); };
    xhr.onabort = () => { activeRequests.delete(xhr); reject(new Error(`XHR iptal edildi: ${message.url}`)); };
    xhr.send(message.method === "GET" || message.method === "HEAD" ? undefined : message.body);
  });
}
