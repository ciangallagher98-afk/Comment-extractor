// Runs inside the page itself (the "MAIN" world), from the moment it starts loading.
//
// When you scroll a comment section, TikTok and Instagram download each new batch
// of comments as structured data and then draw it on screen. This script keeps a
// copy of those downloads and hands them to collector.js, which picks out the
// comments. It never changes, blocks or sends anything anywhere: the page works
// exactly as normal.
(() => {
    if (window.__ceCatcherInstalled) return;
    window.__ceCatcherInstalled = true;

    // A cheap first filter so only responses that could hold comments or post
    // details are passed on — not every image, feed or tracking call.
    const MARKERS = {
        "www.tiktok.com": ['"cid"', '"itemStruct"', '"aweme_detail"'],
        "www.instagram.com": ["comment_like_count", "child_comment_count", '"caption"', "edge_media_to_parent_comment"]
    };
    const markers = MARKERS[location.hostname] || [];
    const MAX_BODY = 20 * 1024 * 1024;

    function forward(url, text) {
        if (typeof text !== "string" || !text || text.length > MAX_BODY) return;
        if (!markers.some(m => text.includes(m))) return;
        // Strings cross safely from the page into the extension's own world.
        document.dispatchEvent(new CustomEvent("ce-capture", {
            detail: JSON.stringify({ url: String(url || ""), text })
        }));
    }

    const looksLikeData = type => !type || /json|text|javascript/i.test(type);

    // ── fetch() ──────────────────────────────────────────────────────────
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        window.fetch = function (...args) {
            const result = originalFetch.apply(this, args);
            result.then(response => {
                try {
                    if (!looksLikeData(response.headers.get("content-type"))) return;
                    const url = response.url || (args[0] && args[0].url) || args[0];
                    response.clone().text().then(text => forward(url, text)).catch(() => {});
                } catch {
                    // never let the copy interfere with the page
                }
            }).catch(() => {});
            return result;
        };
    }

    // ── XMLHttpRequest ───────────────────────────────────────────────────
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__ceUrl = url;
        return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("load", () => {
            try {
                if (this.responseType === "" || this.responseType === "text") {
                    forward(this.__ceUrl, this.responseText);
                } else if (this.responseType === "json" && this.response) {
                    forward(this.__ceUrl, JSON.stringify(this.response));
                }
            } catch {
                // never let the copy interfere with the page
            }
        });
        return originalSend.apply(this, args);
    };
})();
