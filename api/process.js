// Any provider exposing an OpenAI-compatible /chat/completions endpoint works;
// only these three values change. Gemini's documented base URL carries a
// trailing slash, so strip it or every request would go to //chat/completions.
// Trimmed because a key pasted into a dashboard often carries a trailing
// newline, which makes the Authorization header invalid in a way that reads as
// a rejected key rather than a malformed one.
const KEY_SOURCE = process.env.VISION_API_KEY ? "VISION_API_KEY"
    : process.env.DASHSCOPE_API_KEY ? "DASHSCOPE_API_KEY (fallback)"
    : null;
const RAW_KEY = process.env.VISION_API_KEY || process.env.DASHSCOPE_API_KEY || "";
const API_KEY = RAW_KEY.trim();
const BASE_URL = (process.env.VISION_BASE_URL || process.env.DASHSCOPE_BASE_URL
    || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");
const MODEL = process.env.VISION_MODEL || "gemini-2.5-flash";

// Reading several screenshots takes well over the 10s default Vercel allows.
export const maxDuration = 60;

// The openai SDK raised APIConnectionError against this endpoint while a plain
// fetch to the identical URL returned a clean JSON response, so the SDK is not
// used here. One POST is all this needs, which also leaves the project with no
// runtime dependencies.
// 429 and 5xx are transient — Gemini's free tier returns 503 under load — so
// they are worth retrying. Everything else (400, 403, 404) is a real answer and
// retrying it just burns the function's time budget.
const RETRIABLE = new Set([429, 500, 502, 503, 504]);

async function callOnce(payload, timeoutMs) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
    });

    const text = await response.text();

    if (!response.ok) {
        // Surface the provider's own wording — "AccessDenied.Unpurchased" says
        // far more than a bare status code.
        let message = text.slice(0, 300);
        try {
            const body = JSON.parse(text);
            message = body?.error?.message || body?.message || message;
        } catch {
            // non-JSON body; the raw slice is the best we have
        }
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    return JSON.parse(text);
}

// Retries are bounded by a wall-clock deadline rather than a fixed count,
// because the function itself is killed at maxDuration. A retry is only started
// when enough of the budget remains for it to plausibly finish.
async function callChat(payload, budgetMs = 50_000) {
    const deadline = Date.now() + budgetMs;

    for (let attempt = 1; ; attempt++) {
        const remaining = deadline - Date.now();
        try {
            return await callOnce(payload, Math.min(remaining, 45_000));
        } catch (error) {
            const backoff = 800 * attempt;
            const canRetry = RETRIABLE.has(error?.status)
                && attempt < 3
                && (deadline - Date.now()) > backoff + 12_000;

            if (!canRetry) throw error;
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
}
const MAX_IMAGES = 6;
const MAX_PAYLOAD_BYTES = 4_000_000; // Vercel caps serverless request bodies around 4.5MB.

const INSTRUCTIONS = `You are reading screenshots of a social media post and its comments section. Extract the post and every comment you can actually see.

Rules:
1. Read the images in the order given. They are sequential scroll captures of the SAME thread, so they overlap: a comment visible at the bottom of one image often reappears at the top of the next. Emit each distinct comment EXACTLY ONCE, in the order it appears in the thread.
2. Two entries are the same comment when the author and the text match, even if the like count differs slightly between captures. Keep the larger like count.
3. THE POST: the original post sits above the comments, usually in the first image. Put its author, full text, like count and timestamp in "post". Transcribe the post text in full. If the post is not visible in any image, set post to null rather than guessing.
4. Transcribe "text" verbatim. Do not fix typos, translate, summarise, or complete text that is cut off at an image edge — transcribe the part you can read.
5. If a comment has no text (image, GIF, or sticker only), set "text" to "[Image/GIF Only]" and "sentiment" to "Neutral".
6. "likes" is an integer. Expand abbreviated counts ("1.2K" -> 1200). If no like count is shown, use 0. Never guess a number you cannot read.
7. "timestamp" is the raw relative label as displayed ("5h", "2d", "now"). If none is visible, use "".
8. "replies" indent under a parent comment. Include them as normal entries in thread order; set "isReply" true for them and false for top-level comments.
9. Ignore UI chrome: nav bars, the comment composer, "View more replies" buttons, ads.
10. "sentiment" is exactly one of "Positive", "Negative", "Neutral", judged on the comment's own text.
11. "summary" is 2-3 sentences on what the conversation is actually about, including any dominant themes or disagreements.
12. "themes" is 3 to 6 recurring topics across the comments. For each: "label" (2-4 words), "mentions" (how many comments touch it), and "sentiment" (the dominant sentiment of those comments). Order by mentions, highest first. Themes must describe what people are TALKING ABOUT, not how they feel.
13. "standout" is up to 3 comments that best represent the conversation — the most liked, the most critical, and the most representative. For each give "author", "text" (verbatim) and "why" (a short phrase, e.g. "most liked", "sharpest criticism").
14. "sov" holds whole integer percentages for Positive/Negative/Neutral across the extracted comments. They must sum to 100.

Return ONLY a JSON object, no markdown fences and no commentary:
{
  "post": { "author": "...", "text": "...", "likes": 0, "timestamp": "..." },
  "comments": [{ "author": "...", "text": "...", "likes": 0, "timestamp": "...", "sentiment": "...", "isReply": false }],
  "summary": "...",
  "themes": [{ "label": "...", "mentions": 0, "sentiment": "..." }],
  "standout": [{ "author": "...", "text": "...", "why": "..." }],
  "sov": { "Positive": 0, "Negative": 0, "Neutral": 0 }
}`;

// The model is told to return bare JSON, but VL models still wrap it in fences
// often enough that a tolerant parse is worth the few lines.
// Returns the open bracket stack for a JSON prefix, ignoring brackets that sit
// inside string literals.
function openBrackets(text) {
    const stack = [];
    let inString = false;
    let escaped = false;

    for (const ch of text) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') stack.pop();
    }
    return stack;
}

// A response cut off mid-array is still mostly good data. Trim back to the last
// value that actually closed, then shut the structures that are still open, so a
// truncated run yields the comments it did manage rather than nothing at all.
function repairTruncated(text) {
    let inString = false;
    let escaped = false;
    let lastClose = -1;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { if (inString) escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '}' || ch === ']') lastClose = i;
    }
    if (lastClose < 0) return null;

    const prefix = text.slice(0, lastClose + 1);
    const stack = openBrackets(prefix);
    if (!stack.length) return null;

    const closers = stack.reverse().map(b => (b === '{' ? '}' : ']')).join('');
    return prefix + closers;
}

function parseJSON(raw) {
    const text = String(raw || "").trim();
    const candidates = [text];

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) candidates.push(fenced[1]);

    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

    for (const candidate of candidates) {
        try {
            return { value: JSON.parse(candidate.trim()), repaired: false };
        } catch {
            // try the next shape
        }
    }

    const repaired = repairTruncated(text.startsWith("{") ? text : text.slice(Math.max(0, first)));
    if (repaired) {
        try {
            return { value: JSON.parse(repaired), repaired: true };
        } catch {
            // fall through to the error below
        }
    }

    const preview = text.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Model did not return valid JSON. It began: "${preview}"`);
}

const SENTIMENTS = ["Positive", "Negative", "Neutral"];

// The prompt asks for expanded integers, but models routinely hand back the
// label as shown ("1.2K", "3,400"). Losing those to NaN would silently zero out
// the like counts, so parse them here as a safety net.
function parseLikes(value) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));

    const s = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
    const match = s.match(/^(\d+(?:\.\d+)?)\s*([km])?/);
    if (!match) return 0;

    const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
    return Math.max(0, Math.round(parseFloat(match[1]) * scale));
}

function normalise(parsed) {
    const comments = (Array.isArray(parsed?.comments) ? parsed.comments : []).map(c => {
        const sentiment = SENTIMENTS.find(s => s.toLowerCase() === String(c?.sentiment || "").toLowerCase());
        return {
            author: String(c?.author ?? "Unknown"),
            text: String(c?.text ?? ""),
            likes: parseLikes(c?.likes),
            timestamp: String(c?.timestamp ?? ""),
            sentiment: sentiment || "Neutral",
            isReply: Boolean(c?.isReply)
        };
    });

    // Recompute SOV from the comments we actually kept so the chart can never
    // disagree with the table.
    const counted = comments.filter(c => c.text !== "[Image/GIF Only]");
    const sov = { Positive: 0, Negative: 0, Neutral: 0 };
    if (counted.length) {
        const tally = { Positive: 0, Negative: 0, Neutral: 0 };
        counted.forEach(c => { tally[c.sentiment] += 1; });

        let allocated = 0;
        SENTIMENTS.slice(0, -1).forEach(key => {
            sov[key] = Math.round((tally[key] / counted.length) * 100);
            allocated += sov[key];
        });
        sov.Neutral = Math.max(0, 100 - allocated);
    }

    const post = parsed?.post && typeof parsed.post === 'object' ? {
        author: String(parsed.post.author ?? "Unknown"),
        text: String(parsed.post.text ?? ""),
        likes: parseLikes(parsed.post.likes),
        timestamp: String(parsed.post.timestamp ?? "")
    } : null;

    // Counts are arithmetic, so derive them here rather than trusting the model
    // to add up — same reason SOV is recomputed above.
    const totalLikes = comments.reduce((sum, c) => sum + c.likes, 0);
    const replies = comments.filter(c => c.isReply).length;
    const topComment = comments.reduce((best, c) => (!best || c.likes > best.likes ? c : best), null);

    const themes = (Array.isArray(parsed?.themes) ? parsed.themes : [])
        .map(t => ({
            label: String(t?.label ?? "").trim(),
            mentions: Math.max(0, Math.round(Number(t?.mentions)) || 0),
            sentiment: SENTIMENTS.find(s => s.toLowerCase() === String(t?.sentiment || "").toLowerCase()) || "Neutral"
        }))
        .filter(t => t.label)
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, 6);

    const standout = (Array.isArray(parsed?.standout) ? parsed.standout : [])
        .map(s => ({
            author: String(s?.author ?? "Unknown"),
            text: String(s?.text ?? ""),
            why: String(s?.why ?? "").trim()
        }))
        .filter(s => s.text)
        .slice(0, 3);

    return {
        post,
        comments,
        summary: String(parsed?.summary ?? ""),
        sov,
        themes,
        standout,
        stats: {
            total: comments.length,
            topLevel: comments.length - replies,
            replies,
            totalLikes,
            avgLikes: comments.length ? Math.round(totalLikes / comments.length) : 0,
            topComment: topComment && topComment.likes > 0
                ? { author: topComment.author, likes: topComment.likes }
                : null
        }
    };
}

// "Connection error." on its own says nothing actionable. Walk both the cause
// chain and AggregateError.errors — when every resolved IP for a host fails,
// undici throws an AggregateError whose children hold the real socket codes and
// whose own .code is undefined, so a cause-only walk reports nothing.
function collectCodes(error) {
    const codes = [];
    const seen = new Set();
    const stack = [error];

    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);

        const code = current.code || current.errno;
        if (code && !codes.includes(String(code))) codes.push(String(code));

        if (current.cause) stack.push(current.cause);
        if (Array.isArray(current.errors)) stack.push(...current.errors);
    }
    return codes;
}

function describeError(error) {
    const codes = collectCodes(error);
    const suffix = codes.length ? ` (${codes.join(', ')})` : '';
    return `${error?.message || 'Analysis failed.'}${suffix}`;
}

// Raw fetch, no SDK in the way, so the unwrapped failure is visible. A status
// alone does not say why the server refused, so capture the response body too —
// that is where Alibaba puts the actual error code.
async function probe(url, init = {}, wantBody = false, bodyLimit = 600) {
    const started = Date.now();
    try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
        const result = { reached: true, status: response.status, ms: Date.now() - started };
        if (wantBody) {
            result.contentType = response.headers.get('content-type');
            result.requestId = response.headers.get('x-request-id') || response.headers.get('x-acs-request-id');
            // bodyLimit must be large enough to keep the body parseable when the
            // caller intends to parse it — truncating first makes JSON.parse fail.
            result.body = (await response.text()).slice(0, bodyLimit);
        }
        return result;
    } catch (error) {
        return { reached: false, ms: Date.now() - started, error: describeError(error) };
    }
}

// GET /api/process runs a tiny text-only request against the same client. It
// separates "cannot reach the endpoint at all" from "endpoint is fine, the image
// payload is the problem", and reports the config actually in use. Never returns
// the key itself, only whether one is present.
// A /models listing shows a provider's catalogue, not what this account may
// call — DashScope listed qwen3-vl-plus and still answered 403
// AccessDenied.Unpurchased. Entitlement is only observable by calling a model,
// so probe a shortlist and report which ones answer.
const VISION_SHORTLIST = [
    // Current generation, named by the 404s the retired 2.x ids now return.
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    // Works today but is legacy: no longer offered to new users.
    "gemini-2.5-flash"
];

async function probeModel(model) {
    const started = Date.now();
    try {
        const reply = await callChat({
            model,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the word OK." }]
        });
        return { model, usable: true, ms: Date.now() - started, reply: reply.choices?.[0]?.message?.content ?? "" };
    } catch (error) {
        return { model, usable: false, ms: Date.now() - started, status: error?.status ?? null, error: describeError(error) };
    }
}

async function diagnose(req, res) {
    // Enough of the key to tell providers apart, never enough to use. Gemini keys
    // begin "AIza"; a "sk-" prefix here means a leftover key is being sent to
    // Google, which reports it as simply invalid.
    const config = {
        baseURL: BASE_URL,
        model: MODEL,
        apiKeySet: Boolean(API_KEY),
        keySource: KEY_SOURCE,
        keyPrefix: API_KEY ? `${API_KEY.slice(0, 4)}...` : null,
        keyLength: API_KEY.length,
        keyHadWhitespace: RAW_KEY !== RAW_KEY.trim()
    };

    if (!config.apiKeySet) {
        return res.status(200).json({ ...config, ok: false, error: 'VISION_API_KEY is not set on the server.' });
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const only = url.searchParams.get('model');

    // ?model=<id> tests one specific id; otherwise walk the shortlist. The
    // configured model is always included so its status is never ambiguous.
    const candidates = only
        ? [only]
        : [...new Set([MODEL, ...VISION_SHORTLIST])];

    const results = await Promise.all(candidates.map(probeModel));
    const usable = results.filter(r => r.usable).map(r => r.model);

    const payload = {
        ...config,
        ok: usable.includes(MODEL),
        usable,
        results: results.sort((a, b) => Number(b.usable) - Number(a.usable))
    };

    // The full catalogue is long and we already know it lists unentitled models,
    // so only return it on request.
    if (url.searchParams.get('full') === '1') {
        const auth = { "Authorization": `Bearer ${API_KEY}` };
        const models = await probe(`${BASE_URL}/models`, { headers: auth }, true, 500_000);
        try {
            payload.available = JSON.parse(models.body)?.data?.map(m => m.id).filter(Boolean) ?? null;
        } catch (error) {
            payload.available = null;
            payload.availableError = describeError(error);
        }
    }

    return res.status(200).json(payload);
}

export default async function handler(req, res) {
    if (req.method === 'GET') return diagnose(req, res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    if (!API_KEY) {
        return res.status(500).json({ error: 'VISION_API_KEY is not set on the server.' });
    }

    try {
        const { images } = req.body || {};

        if (!Array.isArray(images) || images.length === 0) {
            return res.status(400).json({ error: 'Send an "images" array of data URLs.' });
        }
        if (images.length > MAX_IMAGES) {
            return res.status(400).json({ error: `Too many images (${images.length}). Maximum is ${MAX_IMAGES} per run.` });
        }

        const bytes = images.reduce((sum, img) => sum + String(img).length, 0);
        if (bytes > MAX_PAYLOAD_BYTES) {
            return res.status(413).json({ error: 'Images are too large. Try fewer screenshots per run.' });
        }
        if (!images.every(img => typeof img === 'string' && img.startsWith('data:image/'))) {
            return res.status(400).json({ error: 'Every image must be an image data URL.' });
        }

        const request = {
            model: MODEL,
            temperature: 0.1,
            max_tokens: 16000,
            messages: [{
                role: "user",
                content: [
                    ...images.map(url => ({ type: "image_url", image_url: { url } })),
                    { type: "text", text: INSTRUCTIONS }
                ]
            }]
        };

        // Gemini 2.5 spends output tokens and wall-clock time reasoning before it
        // writes anything, which is wasted on faithful transcription and was
        // pushing runs past the timeout — so ask for none. Providers that reject
        // either option answer 400, and each rung drops one and retries; a 400
        // comes back fast, so the ladder costs little.
        const OPTION_LADDER = [
            { response_format: { type: "json_object" }, reasoning_effort: "none" },
            { response_format: { type: "json_object" } },
            {}
        ];

        let completion;
        for (let i = 0; i < OPTION_LADDER.length; i++) {
            try {
                completion = await callChat({ ...request, ...OPTION_LADDER[i] });
                break;
            } catch (err) {
                const isLast = i === OPTION_LADDER.length - 1;
                if (err?.status !== 400 || isLast) throw err;
            }
        }

        const choice = completion.choices?.[0];
        const { value, repaired } = parseJSON(choice?.message?.content);
        const truncated = repaired || choice?.finish_reason === 'length';

        res.status(200).json({ ...normalise(value), truncated });
    } catch (error) {
        const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : 500;

        const timedOut = error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '');
        const message = timedOut
            ? `The model took too long to read ${(req.body?.images || []).length} screenshots. Try 3 or fewer per run, then combine the CSV exports.`
            : describeError(error);

        res.status(timedOut ? 504 : status).json({ error: message, model: MODEL });
    }
}
