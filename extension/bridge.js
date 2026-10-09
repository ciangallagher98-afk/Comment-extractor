// Runs only on the Comment Extractor website. It hands over the comments the
// extension just collected, then deletes its copy so nothing lingers.
(() => {
    const MAX_AGE_MS = 15 * 60 * 1000;   // ignore anything older than 15 minutes
    let delivering = false;

    async function deliver() {
        if (delivering) return;
        delivering = true;
        try {
            const { cePending } = await chrome.storage.local.get("cePending");
            if (!cePending?.payload) return;
            await chrome.storage.local.remove("cePending");
            if (Date.now() - (cePending.at || 0) > MAX_AGE_MS) return;
            window.postMessage({ type: "CE_EXTENSION_PAYLOAD", payload: cePending.payload }, location.origin);
        } finally {
            delivering = false;
        }
    }

    // Lets the page show "Extension installed" or "Update available".
    // Never allowed to stop the hand-off below.
    function announce() {
        try {
            window.postMessage({ type: "CE_EXTENSION_PRESENT", version: chrome.runtime.getManifest().version }, location.origin);
        } catch {
            // version unknown; the page simply shows the install button
        }
    }

    // The page announces itself when it's ready; deliver then, and also right away
    // in case it was ready before this script started.
    window.addEventListener("message", event => {
        if (event.source === window && event.data?.type === "CE_PAGE_READY") { announce(); deliver(); }
    });
    announce();
    deliver();
})();
