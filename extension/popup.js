// The small window that opens when you click the extension's toolbar button.
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove("hidden");

$("open-tool").onclick = () => chrome.tabs.create({ url: CE_CONFIG.toolUrl });

async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";

    let host = "";
    try { host = new URL(url).hostname; } catch { /* not a web page */ }
    const platform = ceDetectPlatform(host);
    if (!platform) {
        const names = Object.values(CE_PLATFORMS).map(p => p.name);
        $("intro").textContent = `Open a post on ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}, then click this button again.`;
        return;
    }

    let status;
    try {
        status = await chrome.tabs.sendMessage(tab.id, { type: "CE_STATUS" });
    } catch {
        // No answer means the page was open before the extension was installed.
        $("intro").textContent = "";
        show("reload");
        $("reload-btn").onclick = () => { chrome.tabs.reload(tab.id); window.close(); };
        return;
    }

    if (!status?.postId) {
        $("intro").textContent = `${platform.postHint || "Open the post on its own page."} Then click this button again.`;
        return;
    }

    if (status.running) {
        $("intro").textContent = "Already collecting on this page — see the panel in the corner.";
        return;
    }

    $("intro").textContent = status.expected
        ? `This post has about ${status.expected.toLocaleString()} comments.`
        : "Ready to collect this post's comments.";
    $("platform").textContent = status.platform;
    if (platform.fetchAll) $("how").textContent = `${platform.name} publishes whole threads, so this fetches everything in one go — no scrolling needed.`;

    const saved = (await chrome.storage.local.get("ceMax")).ceMax;
    $("max").value = saved || CE_CONFIG.defaultMax;
    show("ready");

    $("start").onclick = async () => {
        const max = Math.min(Math.max(1, parseInt($("max").value, 10) || CE_CONFIG.defaultMax), CE_CONFIG.hardMax);
        await chrome.storage.local.set({ ceMax: max });
        const reply = await chrome.tabs.sendMessage(tab.id, { type: "CE_START", max });
        if (reply?.ok) window.close();
        else $("intro").textContent = reply?.error || "Couldn't start. Reload the page and try again.";
    };
}

init();
