// One entry per social network. Each one knows:
//   - how to tell which post you're on from the address bar
//   - where the comments are: in the data the site loads for itself (extract),
//     read straight off the page (extractDom), or fetched from the platform's
//     own public data address (fetchAll)
//   - how to reach more comments (scrolling and "view replies" buttons)
//
// Adding a platform means adding one entry here plus its address in
// manifest.json. Every entry below was checked against a live post.

const toISO = seconds => {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
};

// Counts arrive as numbers, "1,234", "4.8M" or "12K" depending on the site.
function parseCount(value) {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    const m = String(value ?? "").replace(/[,\s]/g, "").match(/(\d+(?:\.\d+)?)([kmb])?/i);
    if (!m) return 0;
    const scale = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
    return Math.round(parseFloat(m[1]) * scale);
}
const toInt = parseCount;

// "6 years ago", "2h", "8m", "3 days ago" -> an ISO date, counted back from now.
function relToISO(label, now = Date.now()) {
    const s = String(label ?? "").toLowerCase();
    if (!s) return "";
    if (/just now|^now$/.test(s.trim())) return new Date(now).toISOString();
    const m = s.match(/(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mo|years?|yrs?|s|m|h|d|w|y)\b/);
    if (!m) return "";
    const n = Number(m[1]);
    const unit = m[2];
    const d = new Date(now);
    if (/^mo/.test(unit)) d.setMonth(d.getMonth() - n);
    else if (/^y/.test(unit)) d.setFullYear(d.getFullYear() - n);
    else {
        const ms = /^s/.test(unit) ? 1e3 : /^m/.test(unit) ? 6e4 : /^h/.test(unit) ? 3.6e6 : /^d/.test(unit) ? 8.64e7 : 6.048e8;
        d.setTime(d.getTime() - n * ms);
    }
    return d.toISOString();
}

// LinkedIn (and X) ids carry their creation time in their top bits.
function snowflakeToISO(id, shift = 22n, epoch = 0) {
    try {
        const ms = Number(BigInt(id) >> shift) + epoch;
        return ms > 1.1e12 && ms < 2.5e12 ? new Date(ms).toISOString() : "";
    } catch {
        return "";
    }
}

// Finds the first value under a given key anywhere inside an object (bounded).
function deepFind(node, key, depth = 0) {
    if (!node || typeof node !== "object" || depth > 25) return undefined;
    if (key in node && node[key] != null) return node[key];
    for (const k in node) {
        const v = node[k];
        if (v && typeof v === "object") {
            const found = deepFind(v, key, depth + 1);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

const textOf = el => (el ? (el.innerText || el.textContent || "").trim() : "");

// Walks every object inside a block of data. `parentCommentId` carries the
// nearest comment above the current object, so replies nested inside their
// parent comment are threaded correctly even when they don't name the parent.
function walkData(node, visit, parentCommentId = null, key = "", depth = 0) {
    if (!node || typeof node !== "object" || depth > 160) return;
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
        ],
        postHint: "Open the video on its own page — the address should contain /video/ or /photo/."
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
        expanderAriaLabels: [/load more comments/i],
        postHint: "Open the post on its own page — the address should contain /p/ or /reel/."
    },

    // ── X (Twitter) ──────────────────────────────────────────────────────
    // Each reply arrives as a "Tweet" record. Replies to replies name the
    // tweet they answer, so nested threads are kept.
    x: {
        name: "X",
        hosts: ["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"],
        postIdFromUrl(url) {
            const m = String(url).match(/\/status(?:es)?\/(\d{6,})/);
            return m ? m[1] : null;
        },
        initialDataSelectors: [],
        scrollWindow: true,

        extract(data, ctx) {
            const out = { comments: [], post: null };
            walkData(data, o => {
                const t = o.__typename === "TweetWithVisibilityResults" ? o.tweet : o;
                if (!t || !t.legacy || !t.rest_id || typeof t.legacy.full_text !== "string") return null;
                if (o.__typename !== "Tweet" && o.__typename !== "TweetWithVisibilityResults" && o.__typename !== undefined) return null;

                const legacy = t.legacy;
                const user = t.core?.user_results?.result;
                const author = user?.core?.screen_name || user?.legacy?.screen_name || "Unknown";
                const longText = t.note_tweet?.note_tweet_results?.result?.text;
                // Drop the automatic "@name @name" prefix a reply carries.
                const range = Array.isArray(legacy.display_text_range) ? legacy.display_text_range : null;
                const shortText = range ? Array.from(legacy.full_text).slice(range[0]).join("") : legacy.full_text;
                const text = (longText ? longText.replace(/^(@\w+\s+)+/, "") : shortText).trim();
                const timestamp = legacy.created_at ? new Date(legacy.created_at).toISOString() : "";

                if (t.rest_id === ctx.postId) {
                    out.post = {
                        author, text: longText || legacy.full_text,
                        likes: parseCount(legacy.favorite_count),
                        timestamp,
                        commentCount: parseCount(legacy.reply_count)
                    };
                    return null;
                }
                // Only replies in this post's conversation (not quotes, ads or the sidebar).
                if (!ctx.postId || legacy.conversation_id_str !== ctx.postId) return null;
                const replyTo = legacy.in_reply_to_status_id_str;
                out.comments.push({
                    id: t.rest_id,
                    parentId: replyTo && replyTo !== ctx.postId ? replyTo : null,
                    author, text,
                    likes: parseCount(legacy.favorite_count),
                    timestamp,
                    replyTotal: parseCount(legacy.reply_count)
                });
                return null;
            });
            return out;
        },

        expanderPatterns: [/^show( more| additional)? replies$/i, /^show more$/i],
        postHint: "Open the post itself — the address should contain /status/."
    },

    // ── Facebook ─────────────────────────────────────────────────────────
    // Comments arrive as "Comment" records. Each comment's id contains the id
    // of the post it belongs to, which is used to keep only this post's comments
    // when the page has also loaded others (the feed behind a post dialog).
    facebook: {
        name: "Facebook",
        hosts: ["www.facebook.com", "web.facebook.com", "m.facebook.com"],
        postIdFromUrl(url) {
            const s = String(url);
            const m = s.match(/\/posts\/([A-Za-z0-9]+)/)
                || s.match(/[?&](?:story_fbid|fbid|v)=([A-Za-z0-9]+)/)
                || s.match(/\/(?:videos|reel|photos)\/(?:[^/?]+\/)?(\d{6,})/)
                || s.match(/\/permalink\/(\d+)/)
                || s.match(/\/share\/(?:p|r|v)\/([A-Za-z0-9]+)/);
            return m ? m[1] : null;
        },
        initialDataSelectors: ['script[type="application/json"]'],
        scrollWindow: true,

        extract(data) {
            const out = { comments: [], posts: [] };
            const decode = id => { try { return atob(id); } catch { return ""; } };
            walkData(data, (o, key, parentId) => {
                if (o.__typename === "Comment" && typeof o.body?.text === "string" && o.id) {
                    // "comment:<postId>_<commentId>"
                    const decoded = decode(o.id).match(/^comment:(\d+)_/);
                    out.comments.push({
                        id: o.id,
                        parentId: o.comment_direct_parent?.id || (o.depth > 0 ? parentId : null),
                        author: o.author?.name || "Unknown",
                        text: o.body.text,
                        likes: parseCount(o.feedback?.reactors?.count_reduced ?? o.feedback?.reactors?.count),
                        timestamp: toISO(o.created_time),
                        replyTotal: parseCount(o.feedback?.replies_fields?.total_count),
                        groupKey: decoded ? decoded[1] : null
                    });
                    return o.id;
                }
                if (o.__typename === "Story" && o.post_id && (o.comet_sections || o.message)) {
                    const text = o.comet_sections?.content?.story?.message?.text || o.message?.text || "";
                    out.posts.push({
                        groupKey: String(o.post_id),
                        author: o.actors?.[0]?.name || "Unknown",
                        text,
                        timestamp: toISO(o.creation_time),
                        likes: parseCount(deepFind(o, "reaction_count")?.count),
                        commentCount: parseCount(deepFind(o, "total_comment_count") ?? deepFind(o, "comment_rendering_instance")?.comments?.total_count)
                    });
                }
                return null;
            });
            return out;
        },

        expanderPatterns: [
            /^view (all )?\d[\d.,]*[km]? (more )?repl(y|ies)/i,
            /^\d[\d.,]*[km]? repl(y|ies)$/i,
            /^view (more|previous) comments$/i,
            /^view \d[\d.,]*[km]? more comments?$/i,
            /^see more comments$/i
        ],
        // Facebook hides some comments under "Most relevant"; switch the filter
        // to show everything before collecting.
        sortSwitch: { current: /^(most relevant|top comments)$/i, prefer: [/^all comments/i, /^newest/i] },
        postHint: "Open the post itself (click its date) so the address contains /posts/, /videos/ or /reel/."
    },

    // ── LinkedIn ─────────────────────────────────────────────────────────
    // Read straight from the page: every comment on screen carries its id,
    // and the id encodes the exact time it was posted.
    linkedin: {
        name: "LinkedIn",
        hosts: ["www.linkedin.com"],
        postIdFromUrl(url) {
            const s = decodeURIComponent(String(url));
            const m = s.match(/urn:li:(?:activity|ugcPost|share):(\d+)/) || s.match(/-(?:activity|ugcPost|share)-(\d+)/);
            return m ? m[1] : null;
        },
        initialDataSelectors: [],
        scrollWindow: true,

        extractDom() {
            const out = { comments: [], post: null };
            const articles = document.querySelectorAll("article.comments-comment-entity[data-id]");
            for (const a of articles) {
                const urn = a.getAttribute("data-id") || "";
                const nums = urn.match(/\d{10,}/g) || [];
                const own = sel => Array.from(a.querySelectorAll(sel)).find(el => el.closest("article.comments-comment-entity") === a);
                const parentArticle = a.parentElement?.closest("article.comments-comment-entity[data-id]");
                const textEl = own(".comments-comment-item__main-content") || own(".update-components-text");
                out.comments.push({
                    id: urn,
                    parentId: parentArticle ? parentArticle.getAttribute("data-id") : null,
                    author: textOf(own(".comments-comment-meta__description-title")) || textOf(own(".comments-post-meta__name-text")).split("\n")[0] || "Unknown",
                    text: textOf(textEl),
                    likes: parseCount(textOf(own(".comments-comment-social-bar__reactions-count--cr, .comments-comment-social-bar__reactions-count"))),
                    timestamp: snowflakeToISO(nums[nums.length - 1]) || relToISO(textOf(own("time"))),
                    groupKey: nums.length > 1 ? nums[0] : null
                });
            }

            const actor = document.querySelector(".update-components-actor__title");
            const postText = Array.from(document.querySelectorAll(".update-components-text"))
                .find(el => !el.closest(".comments-comment-entity, .comments-comments-list"));
            if (actor || postText) {
                const commentsBtn = Array.from(document.querySelectorAll("button, a"))
                    .map(textOf).find(t => /^\d[\d,.]*[km]? comments?$/i.test(t));
                out.post = {
                    author: textOf(actor).split("\n")[0] || "Unknown",
                    text: textOf(postText),
                    likes: parseCount(textOf(document.querySelector(".social-details-social-counts__reactions-count"))),
                    timestamp: snowflakeToISO(this.postIdFromUrl(location.href)),
                    commentCount: parseCount(commentsBtn)
                };
            }
            return out;
        },

        expanderPatterns: [
            /^load more comments$/i,
            /^show more comments$/i,
            /^see previous replies$/i,
            /^(view|see|load) (\d+ )?(more|previous) repl(y|ies)/i
        ],
        postHint: "Open the post on its own page (click its timestamp) — the address should contain /feed/update/ or /posts/."
    },

    // ── YouTube ──────────────────────────────────────────────────────────
    // Comments arrive as "comment entity" records. A reply's id is
    // "<parent id>.<reply id>", which gives the thread.
    youtube: {
        name: "YouTube",
        hosts: ["www.youtube.com", "m.youtube.com"],
        postIdFromUrl(url) {
            const m = String(url).match(/[?&]v=([\w-]{11})/) || String(url).match(/\/shorts\/([\w-]{11})/);
            return m ? m[1] : null;
        },
        initialDataSelectors: [],
        scrollWindow: true,

        extract(data) {
            const out = { comments: [] };
            const now = Date.now();
            walkData(data, o => {
                const p = o.properties;
                if (!p?.commentId || !p.content || !o.author) return null;
                const id = String(p.commentId);
                out.comments.push({
                    id,
                    parentId: id.includes(".") ? id.split(".")[0] : null,
                    author: o.author.displayName || "Unknown",
                    text: p.content.content || "",
                    likes: parseCount(o.toolbar?.likeCountNotliked),
                    timestamp: relToISO(p.publishedTime, now),
                    replyTotal: parseCount(o.toolbar?.replyCount)
                });
                return null;
            });
            return out;
        },

        // The video's own details come from the page. The upload date is only
        // trusted when the page's metadata belongs to this video (YouTube can
        // leave the previous video's metadata behind when you click between videos).
        extractDom(ctx) {
            const title = textOf(document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata"));
            if (!title) return { comments: [], post: null };
            const metaId = document.querySelector('meta[itemprop="identifier"]')?.content;
            const published = metaId && metaId === ctx?.postId
                ? document.querySelector('meta[itemprop="datePublished"], meta[itemprop="uploadDate"]')?.content
                : "";
            const likeBtn = document.querySelector("like-button-view-model button, #segmented-like-button button");
            return {
                comments: [],
                post: {
                    author: textOf(document.querySelector("ytd-watch-metadata #owner ytd-channel-name a, #owner #channel-name a")) || "Unknown",
                    text: title,
                    likes: parseCount(likeBtn?.getAttribute("aria-label")?.match(/[\d,.]+[kmb]?/i)?.[0] || textOf(likeBtn)),
                    timestamp: published ? new Date(published).toISOString() : "",
                    commentCount: parseCount(textOf(document.querySelector("ytd-comments-header-renderer #count")))
                }
            };
        },

        expanderPatterns: [/^\d[\d.,]*[km]? repl(y|ies)$/i, /^show more replies$/i],
        postHint: "Open the video itself — the address should contain watch?v= or /shorts/."
    },

    // ── Threads ──────────────────────────────────────────────────────────
    // Replies are posts nested under the original post's "direct replies".
    threads: {
        name: "Threads",
        hosts: ["www.threads.com", "www.threads.net", "threads.com", "threads.net"],
        postIdFromUrl(url) {
            const m = String(url).match(/\/post\/([A-Za-z0-9_-]{5,})/);
            return m ? m[1] : null;
        },
        initialDataSelectors: ['script[type="application/json"]'],
        scrollWindow: true,

        extract(data, ctx) {
            const out = { comments: [], post: null };
            let rootPk = ctx.mediaId || null;
            walkData(data, (o, key, parentId) => {
                if (!o.code || !o.user?.username || o.caption === undefined || !("like_count" in o)) return null;
                const pk = String(o.pk || o.id || o.code);
                const base = {
                    author: o.user.username,
                    text: o.caption?.text || "",
                    likes: parseCount(o.like_count),
                    timestamp: toISO(o.taken_at)
                };
                if (o.code === ctx.postId) {
                    rootPk = pk;
                    out.post = { ...base, mediaId: pk, commentCount: parseCount(o.text_post_app_info?.direct_reply_count) };
                    return pk;
                }
                if (o.text_post_app_info?.is_reply !== true) return null;
                out.comments.push({
                    id: pk,
                    parentId: parentId && parentId !== rootPk ? parentId : null,
                    ...base,
                    replyTotal: parseCount(o.text_post_app_info?.direct_reply_count)
                });
                return pk;
            });
            return out;
        },

        expanderPatterns: [],
        postHint: "Open the post itself — the address should contain /post/."
    },

    // ── Bluesky ──────────────────────────────────────────────────────────
    // Bluesky publishes every thread openly, so the whole thread (all nested
    // replies) is fetched in one go — no scrolling needed.
    bluesky: {
        name: "Bluesky",
        hosts: ["bsky.app"],
        postIdFromUrl(url) {
            const m = String(url).match(/\/profile\/([^/]+)\/post\/([a-z0-9]+)/i);
            return m ? `${m[1]}/${m[2]}` : null;
        },
        initialDataSelectors: [],

        async fetchAll(ctx, max) {
            const api = "https://public.api.bsky.app/xrpc/";
            let [actor, rkey] = ctx.postId.split("/");
            if (!actor.startsWith("did:")) {
                const r = await fetch(`${api}com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`);
                if (!r.ok) throw new Error("Couldn't look up that Bluesky account.");
                actor = (await r.json()).did;
            }
            const uri = `at://${actor}/app.bsky.feed.post/${rkey}`;
            const r = await fetch(`${api}app.bsky.feed.getPostThread?depth=1000&parentHeight=0&uri=${encodeURIComponent(uri)}`);
            if (!r.ok) throw new Error(`Bluesky returned ${r.status}.`);
            const { thread } = await r.json();
            if (!thread?.post) throw new Error("That Bluesky post couldn't be loaded (it may be deleted or private).");

            const toEntry = p => ({
                author: p.author?.handle || "Unknown",
                text: p.record?.text || "",
                likes: parseCount(p.likeCount),
                timestamp: p.record?.createdAt ? new Date(p.record.createdAt).toISOString() : ""
            });
            const comments = [];
            const visit = (node, parentUri) => {
                for (const child of node.replies || []) {
                    if (!child.post || comments.length >= max) continue;
                    comments.push({ id: child.post.uri, parentId: parentUri, ...toEntry(child.post), replyTotal: parseCount(child.post.replyCount) });
                    visit(child, child.post.uri);
                }
            };
            visit(thread, null);
            return { post: { ...toEntry(thread.post), commentCount: parseCount(thread.post.replyCount) }, comments };
        },

        expanderPatterns: [],
        postHint: "Open the post itself — the address should contain /post/."
    },

    // ── Reddit ───────────────────────────────────────────────────────────
    // Reddit serves any thread as data at its own address + ".json", using
    // your normal session. "More replies" stubs are fetched in batches.
    reddit: {
        name: "Reddit",
        hosts: ["www.reddit.com", "old.reddit.com", "reddit.com", "new.reddit.com"],
        postIdFromUrl(url) {
            const m = String(url).match(/\/comments\/([a-z0-9]+)/i);
            return m ? m[1] : null;
        },
        initialDataSelectors: [],

        async fetchAll(ctx, max) {
            const getJSON = async url => {
                const r = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
                if (!r.ok) throw new Error(`Reddit returned ${r.status}.`);
                return r.json();
            };
            const thread = await getJSON(`/comments/${ctx.postId}.json?limit=500&depth=10&raw_json=1`);
            const p = thread?.[0]?.data?.children?.[0]?.data;
            if (!p) throw new Error("That Reddit post couldn't be loaded.");

            const comments = [];
            const moreIds = [];
            const parentOf = id => (id && id.startsWith("t1_") ? id : null);
            const visit = children => {
                for (const child of children || []) {
                    if (child.kind === "more") { moreIds.push(...(child.data?.children || [])); continue; }
                    if (child.kind !== "t1" || comments.length >= max) continue;
                    const c = child.data;
                    comments.push({
                        id: c.name || `t1_${c.id}`,
                        parentId: parentOf(c.parent_id),
                        author: c.author || "[deleted]",
                        text: c.body || "",
                        likes: parseCount(c.score),
                        timestamp: toISO(c.created_utc),
                        replyTotal: 0
                    });
                    if (c.replies && typeof c.replies === "object") visit(c.replies.data?.children);
                }
            };
            visit(thread?.[1]?.data?.children);

            // Up to 10 extra batches of hidden replies.
            for (let i = 0; i < 10 && moreIds.length && comments.length < max; i++) {
                const batch = moreIds.splice(0, 100);
                try {
                    const more = await getJSON(`/api/morechildren.json?api_type=json&raw_json=1&link_id=t3_${ctx.postId}&children=${batch.join(",")}`);
                    const things = more?.json?.data?.things || [];
                    things.forEach(t => { if (t.kind === "more") moreIds.push(...(t.data?.children || [])); });
                    visit(things.filter(t => t.kind === "t1"));
                } catch {
                    break;
                }
            }

            return {
                post: {
                    author: p.author || "Unknown",
                    text: [p.title, p.selftext].filter(Boolean).join("\n\n"),
                    likes: parseCount(p.score),
                    timestamp: toISO(p.created_utc),
                    commentCount: parseCount(p.num_comments)
                },
                comments
            };
        },

        expanderPatterns: [],
        postHint: "Open the post itself — the address should contain /comments/."
    }
};

function ceDetectPlatform(hostname) {
    for (const [key, platform] of Object.entries(CE_PLATFORMS)) {
        if (platform.hosts.includes(hostname)) return { key, ...platform };
    }
    return null;
}
