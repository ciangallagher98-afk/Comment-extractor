import OpenAI from "openai";

const BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const MODEL = process.env.VISION_MODEL || "qwen3-vl-plus";

// Reading several screenshots takes well over the 10s default Vercel allows.
export const maxDuration = 60;

// QwenCloud / DashScope exposes an OpenAI-compatible endpoint, so the standard
// openai client works unchanged apart from the baseURL. Retries are capped at 1
// because a retry re-uploads the whole multi-megabyte image payload; the default
// of 2 turns one slow failure into three and can outlast the function itself.
const client = new OpenAI({
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL: BASE_URL,
    timeout: 50_000,
    maxRetries: 1
});
const MAX_IMAGES = 8;
const MAX_PAYLOAD_BYTES = 4_000_000; // Vercel caps serverless request bodies around 4.5MB.

const INSTRUCTIONS = `You are reading screenshots of a social media comments section. Extract every comment you can actually see.

Rules:
1. Read the images in the order given. They are sequential scroll captures of the SAME thread, so they overlap: a comment visible at the bottom of one image often reappears at the top of the next. Emit each distinct comment EXACTLY ONCE, in the order it appears in the thread.
2. Two entries are the same comment when the author and the text match, even if the like count differs slightly between captures. Keep the larger like count.
3. Transcribe "text" verbatim. Do not fix typos, translate, summarise, or complete text that is cut off at an image edge — transcribe the part you can read.
4. If a comment has no text (image, GIF, or sticker only), set "text" to "[Image/GIF Only]" and "sentiment" to "Neutral".
5. "likes" is an integer. Expand abbreviated counts ("1.2K" -> 1200). If no like count is shown, use 0. Never guess a number you cannot read.
6. "timestamp" is the raw relative label as displayed ("5h", "2d", "now"). If none is visible, use "".
7. "replies" indent under a parent comment. Include them as normal entries in thread order; set "isReply" true for them and false for top-level comments.
8. Ignore UI chrome: the post itself, nav bars, the comment composer, "View more replies" buttons, ads.
9. "sentiment" is exactly one of "Positive", "Negative", "Neutral", judged on the comment's own text.
10. "summary" is 2-3 sentences on what the conversation is actually about, including any dominant themes or disagreements.
11. "sov" holds whole integer percentages for Positive/Negative/Neutral across the extracted comments. They must sum to 100.

Return ONLY a JSON object, no markdown fences and no commentary:
{
  "comments": [{ "author": "...", "text": "...", "likes": 0, "timestamp": "...", "sentiment": "...", "isReply": false }],
  "summary": "...",
  "sov": { "Positive": 0, "Negative": 0, "Neutral": 0 }
}`;

// The model is told to return bare JSON, but VL models still wrap it in fences
// often enough that a tolerant parse is worth the few lines.
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
            return JSON.parse(candidate.trim());
        } catch {
            // try the next shape
        }
    }
    throw new Error("Model did not return valid JSON.");
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

    return { comments, summary: String(parsed?.summary ?? ""), sov };
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

// Raw fetch, no SDK in the way, so the unwrapped failure is visible.
async function probe(url, init = {}) {
    const started = Date.now();
    try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
        return { reached: true, status: response.status, ms: Date.now() - started };
    } catch (error) {
        return { reached: false, ms: Date.now() - started, error: describeError(error) };
    }
}

// GET /api/process runs a tiny text-only request against the same client. It
// separates "cannot reach the endpoint at all" from "endpoint is fine, the image
// payload is the problem", and reports the config actually in use. Never returns
// the key itself, only whether one is present.
async function diagnose(res) {
    const config = { baseURL: BASE_URL, model: MODEL, apiKeySet: Boolean(process.env.DASHSCOPE_API_KEY) };

    if (!config.apiKeySet) {
        return res.status(200).json({ ...config, ok: false, error: 'DASHSCOPE_API_KEY is not set on the server.' });
    }

    // Control probe first: if this fails too, the function has no outbound
    // egress at all and the problem is not DashScope-specific.
    const [control, direct] = await Promise.all([
        probe("https://example.com"),
        probe(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.DASHSCOPE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ model: MODEL, max_tokens: 8, messages: [{ role: "user", content: "Reply with the word OK." }] })
        })
    ]);

    try {
        const sdk = await client.chat.completions.create({
            model: MODEL,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the word OK." }]
        });
        return res.status(200).json({ ...config, ok: true, control, direct, reply: sdk.choices?.[0]?.message?.content ?? "" });
    } catch (error) {
        return res.status(200).json({
            ...config, ok: false, control, direct,
            status: error?.status ?? null,
            error: describeError(error)
        });
    }
}

export default async function handler(req, res) {
    if (req.method === 'GET') return diagnose(res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    if (!process.env.DASHSCOPE_API_KEY) {
        return res.status(500).json({ error: 'DASHSCOPE_API_KEY is not set on the server.' });
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
            max_tokens: 8000,
            messages: [{
                role: "user",
                content: [
                    ...images.map(url => ({ type: "image_url", image_url: { url } })),
                    { type: "text", text: INSTRUCTIONS }
                ]
            }]
        };

        let completion;
        try {
            completion = await client.chat.completions.create({
                ...request,
                response_format: { type: "json_object" }
            });
        } catch (err) {
            // Not every vision model on DashScope accepts response_format; the
            // prompt plus tolerant parsing covers us when it doesn't.
            if (!/response_format/i.test(err?.message || "")) throw err;
            completion = await client.chat.completions.create(request);
        }

        res.status(200).json(normalise(parseJSON(completion.choices?.[0]?.message?.content)));
    } catch (error) {
        const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : 500;
        res.status(status).json({ error: describeError(error), baseURL: BASE_URL, model: MODEL });
    }
}
