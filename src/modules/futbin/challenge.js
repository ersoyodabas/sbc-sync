export const FUTBIN_CHALLENGE_MAX_WAIT_MS = 5 * 60 * 1000;

const CHALLENGE_MARKERS = [
  "cloudflare",
  "ray id",
  "güvenlik doğrulaması",
  "guvenlik dogrulamasi",
  "checking your browser",
  "verifying you are human",
  "kötü niyetli bot",
  "kotu niyetli bot",
  "malicious bots",
  "security service"
];

export function isFutbinChallengeHtml(html) {
  const normalized = String(html || "").toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => normalized.includes(marker));
}

export function futbinChallengeTimeoutError(url) {
  return `Futbin Cloudflare doğrulaması ${Math.round(FUTBIN_CHALLENGE_MAX_WAIT_MS / 1000)} saniye içinde tamamlanmadı: ${url}`;
}
