// Runs on TikTok and Instagram pages, in the extension's own private space.
//
// It does four jobs:
//   1. Receives the data copied by catcher.js and keeps every comment for the
//      post you're on (duplicates are merged).
//   2. When you press "Start collecting", scrolls the comment section and clicks
//      "view replies" / "load more" so the site loads everything.
//   3. Shows a small progress panel in the corner of the page.
//   4. When finished, puts the comments in thread order and sends them to the
//      Comment Extractor website.
(() => {
    const platform = ceDetectPlatform(location.hostname);
    if (!platform) return;

    // ── State ────────────────────────────────────────────────────────────
    const store = new Map();     // comment id -> comment
    let post = null;
    let seq = 0;
    let currentUrl = location.href;
    let postId = platform.postIdFromUrl(location.href);
    let run = null;              // details of an active collecting run

    const ctx = () => ({ postId, mediaId: post?.mediaId || null });

    function resetForNewPost() {
        store.clear();
        post = null;
        seq = 0;
        postId = platform.postIdFromUrl(location.href);
    }

    function absorb(result) {
        if (result.post && (!post || result.post.text || !post.text)) {
            post = { ...(post || {}), ...result.post };
        }
        for (const c of result.comments) {
            if (!c.id) continue;
            const existing = store.get(c.id);
            if (existing) {
                // Seen again: keep the best of both copies.
                existing.likes = Math.max(existing.likes, c.likes);
                existing.parentId = existing.parentId || c.parentId;
                existing.replyTotal = Math.max(existing.replyTotal || 0, c.replyTotal || 0);
                if (!existing.text && c.text) existing.text = c.text;
            } else {
                store.set(c.id, { ...c, seq: seq++ });
            }
        }
        if (run) updatePanel();
    }

    function absorbText(text) {
        if (!postId) return;
        // Some responses carry a "for (;;);" guard prefix, and some hold several
        // JSON documents, one per line.
        const cleaned = text.replace(/^\s*for\s*\(;;\);\s*/, "");
        const docs = [];
        try {
            docs.push(JSON.parse(cleaned));
        } catch {
            for (const line of cleaned.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
                try { docs.push(JSON.parse(trimmed)); } catch { /* not JSON */ }
            }
        }
        for (const doc of docs) {
            try { absorb(platform.extract(doc, ctx())); } catch { /* unexpected shape */ }
        }
    }

    // ── 1. Data from catcher.js ──────────────────────────────────────────
    document.addEventListener("ce-capture", event => {
        try {
            const { text } = JSON.parse(event.detail);
            if (platform.postIdFromUrl(location.href) !== postId) resetForNewPost();
            absorbText(text);
        } catch {
            // ignore anything unreadable
        }
    });

    // The first batch is often built into the page itself rather than downloaded.
    function scanPageData() {
        for (const selector of platform.initialDataSelectors) {
            document.querySelectorAll(selector).forEach(el => {
                const text = el.textContent;
                if (text && text.length > 50) absorbText(text);
            });
        }
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", scanPageData, { once: true });
    } else {
        scanPageData();
    }

    // These sites change pages without a full reload, so watch the address bar.
    setInterval(() => {
        if (location.href === currentUrl) return;
        currentUrl = location.href;
        const nextId = platform.postIdFromUrl(location.href);
        if (nextId === postId) return;
        if (run) finish("cancelled", "You moved to a different page, so collecting stopped.");
        resetForNewPost();
    }, 800);

    // ── 2. Scrolling and expanding ───────────────────────────────────────
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clicked = new WeakSet();

    const isVisible = el => {
        if (!el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none";
    };

    function clickExpanders(limit = 4) {
        let clicks = 0;
        const tryClick = el => {
            if (clicks >= limit) return;
            const target = el.closest('button, [role="button"]') || el;
            if (clicked.has(target) || !isVisible(target)) return;
            // Never follow a link: that would leave the post.
            if (target.closest("a[href]")) return;
            clicked.add(target);
            target.click();
            clicks++;
        };

        const candidates = document.querySelectorAll('button, [role="button"], span, p');
        for (const el of candidates) {
            if (clicks >= limit) break;
            const text = (el.innerText || "").trim();
            if (!text || text.length > 40 || /hide|less/i.test(text)) continue;
            if (platform.expanderPatterns.some(re => re.test(text))) tryClick(el);
        }

        if (platform.expanderAriaLabels) {
            for (const el of document.querySelectorAll("[aria-label]")) {
                if (clicks >= limit) break;
                const label = el.getAttribute("aria-label") || "";
                if (platform.expanderAriaLabels.some(re => re.test(label))) tryClick(el);
            }
        }
        return clicks;
    }

    function openCommentsTab() {
        if (!platform.commentsTabPattern) return false;
        for (const el of document.querySelectorAll('button, [role="tab"], [role="button"], span, p')) {
            const text = (el.innerText || "").trim();
            if (text.length < 30 && platform.commentsTabPattern.test(text) && isVisible(el)) {
                (el.closest('button, [role="tab"], [role="button"]') || el).click();
                return true;
            }
        }
        return false;
    }

    // Comments sit in their own scrolling box. Find every visible scrolling box
    // that isn't the video feed, and scroll it to the bottom so the next batch loads.
    let scrollBoxes = [];
    function findScrollBoxes() {
        scrollBoxes = Array.from(document.querySelectorAll("div, ul, section")).filter(el => {
            if (el.clientHeight < 150 || el.scrollHeight <= el.clientHeight + 40) return false;
            const overflow = getComputedStyle(el).overflowY;
            if (overflow !== "auto" && overflow !== "scroll") return false;
            if (el.querySelector("video")) return false;   // the feed: scrolling it changes video
            return isVisible(el);
        });
    }

    function scrollComments() {
        for (const el of scrollBoxes) {
            if (el.isConnected) el.scrollTop = el.scrollHeight;
        }
    }

    async function collectLoop() {
        const startedAt = Date.now();
        let idleTicks = 0;
        let tick = 0;

        while (run && run.state === "running") {
            if (tick % 5 === 0) findScrollBoxes();
            if (tick === 3 && store.size === 0) openCommentsTab();

            const before = store.size;
            const clicks = clickExpanders();
            scrollComments();

            // A human-ish pace: fast enough to be useful, slow enough not to
            // hammer the site or look like a bot.
            await sleep(1200 + Math.random() * 700);
            tick++;

            if (!run || run.state !== "running") return;
            idleTicks = store.size === before && clicks === 0 ? idleTicks + 1 : 0;

            if (store.size >= run.max) return finish("done", `Reached your limit of ${run.max.toLocaleString()} comments.`);
            if (idleTicks >= 8) {
                return store.size
                    ? finish("done", "No more comments are loading.")
                    : finish("empty", "No comments were found. Reload the page and try again.");
            }
            if (Date.now() - startedAt > CE_CONFIG.maxMinutes * 60 * 1000) {
                return finish("done", `Stopped after ${CE_CONFIG.maxMinutes} minutes.`);
            }
        }
    }

    // ── 4. Thread order and sending ──────────────────────────────────────
    // Top-level comments keep the order the site showed them in; each reply
    // goes straight after its parent, oldest first. The website relies on this
    // order to rebuild threads when it pushes to Pulsar.
    function assemble(max) {
        const all = Array.from(store.values());
        const tops = all.filter(c => !c.parentId).sort((a, b) => a.seq - b.seq);
        const byParent = new Map();
        for (const c of all) {
            if (!c.parentId) continue;
            if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
            byParent.get(c.parentId).push(c);
        }

        const ordered = [];
        const placed = new Set();
        const place = (c, isReply) => {
            if (placed.has(c.id)) return;
            placed.add(c.id);
            ordered.push({
                author: c.author,
                text: c.text,
                likes: c.likes,
                timestamp: c.timestamp,
                isReply
            });
        };
        for (const top of tops) {
            place(top, false);
            const replies = (byParent.get(top.id) || [])
                .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || "") || a.seq - b.seq);
            // Replies to replies are flattened under the same top-level comment.
            const queue = [...replies];
            while (queue.length) {
                const r = queue.shift();
                place(r, true);
                queue.push(...(byParent.get(r.id) || []));
            }
        }
        // Replies whose parent never loaded go at the end.
        for (const c of all.sort((a, b) => a.seq - b.seq)) place(c, true);

        return ordered.slice(0, max);
    }

    async function send() {
        const comments = assemble(run?.max || CE_CONFIG.hardMax);
        if (!comments.length) return;
        const payload = {
            id: crypto.randomUUID(),
            version: 1,
            platform: platform.key,
            platformName: platform.name,
            url: location.href,
            collectedAt: new Date().toISOString(),
            post: post ? { author: post.author, text: post.text, likes: post.likes, timestamp: post.timestamp } : null,
            comments
        };
        await chrome.runtime.sendMessage({ type: "CE_SEND", payload });
    }

    async function finish(state, message) {
        if (!run) return;
        run.state = state;
        run.message = message;
        updatePanel();

        if (state === "done" || state === "stopped") {
            try {
                await send();
                run.message = `${message} Sent ${Math.min(store.size, run.max).toLocaleString()} comments to Comment Extractor.`;
                run.state = "sent";
            } catch (error) {
                run.message = `Couldn't send: ${error.message}. Try "Send again".`;
                run.state = "error";
            }
            updatePanel();
        }
    }

    function start(max) {
        if (run && run.state === "running") return;
        run = { state: "running", max: Math.min(Math.max(1, max || CE_CONFIG.defaultMax), CE_CONFIG.hardMax), message: "" };
        showPanel();
        collectLoop();
    }

    // ── 3. Progress panel ────────────────────────────────────────────────
    // Built inside a "shadow root" so the site's styles can't affect it.
    let panelHost = null;
    let panel = null;

    function showPanel() {
        if (!panelHost) {
            panelHost = document.createElement("div");
            panelHost.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;";
            const shadow = panelHost.attachShadow({ mode: "closed" });
            shadow.innerHTML = `
                <style>
                    .box { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; width: 270px;
                           background: #fff; color: #0f172a; border: 1px solid #e2e8f0; border-radius: 14px;
                           box-shadow: 0 10px 30px rgba(15,23,42,.18); padding: 14px 16px; }
                    .title { font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
                    .close { cursor: pointer; color: #94a3b8; border: 0; background: none; font-size: 16px; }
                    .count { font-size: 26px; font-weight: 700; margin: 6px 0 0; }
                    .sub { color: #64748b; font-size: 12px; min-height: 16px; }
                    .bar { height: 6px; background: #e2e8f0; border-radius: 3px; margin: 10px 0; overflow: hidden; }
                    .fill { height: 100%; width: 0; background: #4f46e5; transition: width .4s; }
                    .row { display: flex; gap: 8px; margin-top: 10px; }
                    button.act { flex: 1; border: 0; border-radius: 9px; padding: 8px; font-weight: 600; cursor: pointer; }
                    .primary { background: #4f46e5; color: #fff; }
                    .ghost { background: #f1f5f9; color: #334155; }
                    .hidden { display: none; }
                </style>
                <div class="box">
                    <div class="title">Comment Extractor <button class="close" title="Close">×</button></div>
                    <div class="count">0</div>
                    <div class="sub status"></div>
                    <div class="bar"><div class="fill"></div></div>
                    <div class="sub message"></div>
                    <div class="row">
                        <button class="act primary send">Stop &amp; send</button>
                        <button class="act ghost cancel">Cancel</button>
                    </div>
                </div>`;
            panel = {
                count: shadow.querySelector(".count"),
                status: shadow.querySelector(".status"),
                fill: shadow.querySelector(".fill"),
                message: shadow.querySelector(".message"),
                send: shadow.querySelector(".send"),
                cancel: shadow.querySelector(".cancel"),
                close: shadow.querySelector(".close")
            };
            panel.send.onclick = () => {
                if (!run) return;
                if (run.state === "running") finish("stopped", "Stopped early.");
                else finish("done", "Sending again.");
            };
            panel.cancel.onclick = () => {
                if (run?.state === "running") finish("cancelled", "Cancelled. Nothing was sent.");
            };
            panel.close.onclick = () => {
                if (run?.state === "running") finish("cancelled", "Cancelled. Nothing was sent.");
                panelHost.remove();
                panelHost = null;
            };
        }
        if (!panelHost.isConnected) document.documentElement.appendChild(panelHost);
        updatePanel();
    }

    function updatePanel() {
        if (!panel || !run) return;
        const collected = Math.min(store.size, run.max);
        const expected = post?.commentCount ? Math.min(post.commentCount, run.max) : run.max;
        panel.count.textContent = `${collected.toLocaleString()} comment${collected === 1 ? "" : "s"}`;
        panel.status.textContent = run.state === "running"
            ? `Collecting from ${platform.name}${post?.commentCount ? ` · about ${post.commentCount.toLocaleString()} on this post` : ""}…`
            : "";
        panel.fill.style.width = `${Math.min(100, (collected / Math.max(1, expected)) * 100)}%`;
        panel.message.textContent = run.message || "";

        const running = run.state === "running";
        panel.send.textContent = running ? "Stop & send" : "Send again";
        panel.send.classList.toggle("hidden", !running && !["sent", "error", "stopped"].includes(run.state));
        panel.cancel.classList.toggle("hidden", !running);
    }

    // ── Messages from the toolbar popup ──────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === "CE_STATUS") {
            sendResponse({
                platform: platform.name,
                postId,
                collected: store.size,
                expected: post?.commentCount || null,
                running: run?.state === "running"
            });
        } else if (message?.type === "CE_START") {
            if (!postId) return sendResponse({ ok: false, error: "Open the post's own page first." });
            start(Number(message.max));
            sendResponse({ ok: true });
        }
        return false;
    });
})();
