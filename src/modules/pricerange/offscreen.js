chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  try {
    if (message?.type === "PARSE_PRICE_RANGE_HTML") {
      respond({ ok: true, ...globalThis.FutbinPriceRangeParser.parsePage(message.html, message.pageUrl) });
      return true;
    }
    if (message?.type === "PARSE_PRICE_RANGE_PLAYER_HTML") {
      respond({ ok: true, ...globalThis.FutbinPriceRangeParser.parsePlayerDetail(message.html, message.playerUrl) });
      return true;
    }
  } catch (error) {
    respond({ ok: false, error: error.message || String(error) });
  }
});
