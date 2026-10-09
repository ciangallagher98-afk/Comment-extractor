// Runs in the background. Its one job: when a page finishes collecting, keep the
// comments safe for a moment and open the Comment Extractor website, where
// bridge.js picks them up.
importScripts("config.js");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "CE_SEND") return false;

    chrome.storage.local
        .set({ cePending: { payload: message.payload, at: Date.now() } })
        .then(() => chrome.tabs.create({ url: CE_CONFIG.toolUrl }))
        .then(() => sendResponse({ ok: true }))
        .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));

    return true; // tells Chrome the reply will come after the async work above
});
