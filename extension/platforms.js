// One entry per social network. Each one knows:
//   - how to tell which post you're on from the address bar
//   - how to recognise a comment, and the post itself, inside the data the site loads
//   - which on-page data to read when the page first opens
//   - how to reach the comments (scrolling and "view replies" buttons)
//
// Adding a new platform later (Facebook, X, LinkedIn) means adding one more entry
// here plus its address in manifest.json — nothing else changes.

const toISO = seconds => {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
};
const toInt = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

// Walks every object inside a block of data. `parentCommentId` carries the
// nearest comment above the current object, so replies nested inside their
// parent comment are threaded correctly even when they don't name the parent.
function walkData(node, visit, parentCommentId = null, key = "", depth = 0) {
    if (!node || typeof node !== "object" || depth > 80) return;
    if (Array.isArray(node)) {
        for (const item of node) walkData(item, visit, parentCommentId, key, depth + 1);
        return;
    }
    const foundId = visit(node, key, parentCommentId);
    const nextParent = foundId || parentCommentId;
    for (const k in node) {
        const child = node[k];
        if (child && typeof child === "object") walkData(child, visit, nextParent, k, depth + 1);
    }
}

const CE_PLATFORMS = {

    // ── TikTok ───────────────────────────────────────────────────────────
    tiktok: {
        name: "TikTok",
        hosts: ["www.tiktok.com"],

        // e.g. https://www.tiktok.com/@someone/video/7412345678901234567
        postIdFromUrl(url) {
            const m = String(url).match(/\/(?:video|photo)\/(\d{8,})/);
            return m ? m[1] : null;
        },

        initialDataSelectors: ["script#__UNIVERSAL_DATA_FOR_REHYDRATION__", "script#SIGI_STATE"],

        extract(data, ctx) {
            const out = { comments: [], post: null };
            walkData(data, (o, key, parentId) => {
                // A comment: has a comment id, text and a creation time.
                if (o.cid && typeof o.text === "string" && "create_time" in o) {
                    if (o.aweme_id && ctx.postId && String(o.aweme_id) !== ctx.postId) return null;
                    const declaredParent = o.reply_id && String(o.reply_id) !== "0" ? String(o.reply_id) : null;
                    out.comments.push({
                        id: String(o.cid),
                        parentId: declaredParent || parentId,
                        author: o.user?.unique_id || o.user?.nickname || "Unknown",
                        // Sticker- or image-only comments have no text; the website
                        // shows those as "[Image/GIF Only]".
                        text: o.text,
                        likes: toInt(o.digg_count),
                        timestamp: toISO(o.create_time),
                        replyTotal: toInt(o.reply_comment_total)
                    });
                    return String(o.cid);
                }

                // The post (video or photo carousel).
                const id = String(o.id ?? o.aweme_id ?? "");
                if (ctx.postId && id === ctx.postId && typeof o.desc === "string") {
                    const author = typeof o.author === "string"
                        ? o.author
                        : (o.author?.uniqueId || o.author?.unique_id || o.author?.nickname);
                    const stats = o.stats || o.statsV2 || {};
                    const statistics = o.statistics || {};
                    out.post = {
                        author: author || "Unknown",
                        text: o.desc,
                        likes: toInt(stats.diggCount ?? statistics.digg_count),
                        timestamp: toISO(o.createTime ?? o.create_time),
                        commentCount: toInt(stats.commentCount ?? statistics.comment_count)
                    };
                }
                return null;
            });
            return out;
        },

        // TikTok sometimes opens a video on its "creator videos" tab; the
        // comments tab has to be selected before any comments load.
        commentsTabPattern: /^comments?(\s*\(?[\d.,]+[km]?\)?)?$/i,

        expanderPatterns: [
            /^view (all )?\d[\d.,]*[km]? (more )?repl(y|ies)/i,
            /^view (more )?repl(y|ies)/i,
            /^view \d[\d.,]*[km]? more/i,
            /^view more$/i
        ]
    },

    // ── Instagram ────────────────────────────────────────────────────────
    instagram: {
        name: "Instagram",
        hosts: ["www.instagram.com"],

        // e.g. https://www.instagram.com/p/C9AbCdEfGhI/ or /reel/C9AbCdEfGhI/
        postIdFromUrl(url) {
            const m = String(url).match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/);
            return m ? m[1] : null;
        },

        initialDataSelectors: ['script[type="application/json"]'],

        extract(data, ctx) {
            const out = { comments: [], post: null };
            walkData(data, (o, key, parentId) => {
                // The post: matched on its shortcode, which is what's in the address bar.
                const code = o.code || o.shortcode;
                if (ctx.postId && code === ctx.postId && (o.caption !== undefined || o.user || o.owner)) {
                    const captionText = typeof o.caption === "object" && o.caption
                        ? o.caption.text
                        : o.edge_media_to_caption?.edges?.[0]?.node?.text;
                    out.post = {
                        author: o.user?.username || o.owner?.username || "Unknown",
                        text: captionText || "",
                        likes: toInt(o.like_count ?? o.edge_media_preview_like?.count ?? o.edge_liked_by?.count),
                        timestamp: toISO(o.taken_at ?? o.taken_at_timestamp),
                        commentCount: toInt(o.comment_count ?? o.edge_media_to_parent_comment?.count),
                        mediaId: String(o.pk || o.id || "").split("_")[0] || null
                    };
                    return null;
                }

                // The caption has the same shape as a comment, so never count it as one.
                if (key === "caption") return null;

                // Current Instagram comment shape.
                const isComment = (o.pk || o.id) && typeof o.text === "string" && o.created_at
                    && o.user?.username
                    && ("comment_like_count" in o || "child_comment_count" in o || "parent_comment_id" in o);

                // Older shape, still seen on some pages.
                const isOldComment = !isComment && o.id && typeof o.text === "string" && o.created_at
                    && o.owner?.username && ("edge_liked_by" in o || "viewer_has_liked" in o);

                if (!isComment && !isOldComment) return null;

                const mediaId = o.media_id ? String(o.media_id).split("_")[0] : null;
                if (mediaId && ctx.mediaId && mediaId !== ctx.mediaId) return null;

                const id = String(o.pk || o.id);
                out.comments.push({
                    id,
                    parentId: o.parent_comment_id ? String(o.parent_comment_id) : parentId,
                    author: isComment ? o.user.username : o.owner.username,
                    text: o.text,
                    likes: toInt(isComment ? o.comment_like_count : o.edge_liked_by?.count),
                    timestamp: toISO(o.created_at),
                    replyTotal: toInt(o.child_comment_count ?? o.edge_threaded_comments?.count)
                });
                return id;
            });
            return out;
        },

        commentsTabPattern: null,

        expanderPatterns: [
            /^view (all )?\d[\d.,]*[km]? (more )?repl(y|ies)/i,
            /^view repl(y|ies)\s*\(\d[\d.,]*\)/i,
            /^view (more )?repl(y|ies)/i,
            /^(view|load|see) more comments?/i
        ],
        expanderAriaLabels: [/load more comments/i]
    }
};

function ceDetectPlatform(hostname) {
    for (const [key, platform] of Object.entries(CE_PLATFORMS)) {
        if (platform.hosts.includes(hostname)) return { key, ...platform };
    }
    return null;
}
