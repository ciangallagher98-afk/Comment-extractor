// Thin authenticated proxy to Pulsar's first-party-data pusher.
//
// The client's API key arrives per request from the browser and is used once to
// sign the upstream call. It is never stored, never written to a log, and never
// returned in a response — this file must stay that way.
const PULSAR_URL = process.env.PULSAR_GRAPHQL_URL;
const AUTH_HEADER = process.env.PULSAR_AUTH_HEADER || "Authorization";
const AUTH_SCHEME = process.env.PULSAR_AUTH_SCHEME ?? "Bearer";

export const maxDuration = 60;

const MUTATIONS = {
    validate: `mutation FPDValidate($interactions: [Interaction!]!, $searches: [String!]!) {
  validateInteraction(interactions: $interactions, searches: $searches) { errors message status }
}`,
    store: `mutation FPDStore($interactions: [Interaction!]!, $searches: [String!]!) {
  storeInteraction(interactions: $interactions, searches: $searches) { errors message status }
}`
};

const CONTENT_TYPES = new Set(["post", "comment"]);
const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// The pusher rejects a whole batch on any single bad row, so anything we can
// catch here saves a round trip and names the row rather than the byte offset.
function findLocalProblems(interactions) {
    const problems = [];

    interactions.forEach((item, i) => {
        const row = `row ${i + 1}`;
        const content = item?.content;

        if (!content?.body) problems.push(`${row}: content.body is empty`);
        if (!content?.remoteId) problems.push(`${row}: content.remoteId is missing`);
        if (!CONTENT_TYPES.has(content?.type)) {
            problems.push(`${row}: content.type is "${content?.type}" — must be post or comment`);
        }
        // Date.parse accepts "2020", which the pusher rejects as not coercible to
        // ISO8601DateTime, so match the full form rather than merely parseable.
        if (!ISO8601.test(String(content?.publishedAt ?? ''))) {
            problems.push(`${row}: content.publishedAt "${content?.publishedAt}" is not a full ISO8601 datetime`);
        }
        if (!item?.author?.screenName) problems.push(`${row}: author.screenName is missing`);
    });

    return problems;
}

// GraphQL reports a bad variable with a path like [1, "content", "type"]. Turn
// that into "row 2 · content.type", which points at something the user can see.
function describeProblems(body) {
    const out = [];

    for (const error of body?.errors || []) {
        const problems = error?.extensions?.problems;
        if (Array.isArray(problems) && problems.length) {
            for (const p of problems) {
                const [index, ...rest] = p.path || [];
                const where = Number.isInteger(index)
                    ? `row ${index + 1}${rest.length ? ` · ${rest.join('.')}` : ''}`
                    : (p.path || []).join('.');
                out.push(`${where}: ${p.explanation}`);
            }
        } else if (error?.message) {
            out.push(error.message);
        }
    }
    return out;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    if (!PULSAR_URL) {
        return res.status(500).json({
            error: 'PULSAR_GRAPHQL_URL is not set on the server. Set it to the Pulsar GraphQL v2 endpoint.'
        });
    }

    try {
        const { apiKey, searchHash, mode, interactions } = req.body || {};

        if (!apiKey) return res.status(400).json({ error: 'Enter your Pulsar API key.' });
        if (!searchHash) return res.status(400).json({ error: 'Enter the search hash to push into.' });
        if (!MUTATIONS[mode]) return res.status(400).json({ error: 'mode must be "validate" or "store".' });
        if (!Array.isArray(interactions) || !interactions.length) {
            return res.status(400).json({ error: 'No interactions to send.' });
        }

        const local = findLocalProblems(interactions);
        if (local.length) {
            return res.status(200).json({ ok: false, stage: 'local', problems: local });
        }

        const upstream = await fetch(PULSAR_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [AUTH_HEADER]: AUTH_SCHEME ? `${AUTH_SCHEME} ${apiKey}` : apiKey
            },
            body: JSON.stringify({
                query: MUTATIONS[mode],
                variables: { interactions, searches: [searchHash] }
            }),
            signal: AbortSignal.timeout(45_000)
        });

        const text = await upstream.text();

        if (upstream.status === 401 || upstream.status === 403) {
            return res.status(upstream.status).json({ error: 'Pulsar rejected the API key.' });
        }

        let body;
        try {
            body = JSON.parse(text);
        } catch {
            return res.status(502).json({
                error: `Pulsar returned a non-JSON response (HTTP ${upstream.status}): ${text.slice(0, 200)}`
            });
        }

        // A failed batch comes back as HTTP 200 with a top-level errors array,
        // so status alone does not tell us whether it worked.
        const problems = describeProblems(body);
        if (problems.length) {
            return res.status(200).json({ ok: false, stage: mode, problems });
        }

        const payload = body?.data?.validateInteraction || body?.data?.storeInteraction || {};
        const fieldErrors = Array.isArray(payload.errors) ? payload.errors : [];

        return res.status(200).json({
            ok: fieldErrors.length === 0,
            stage: mode,
            status: payload.status ?? null,
            message: payload.message ?? '',
            problems: fieldErrors.map(String),
            count: interactions.length
        });

    } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '');
        return res.status(timedOut ? 504 : 500).json({
            error: timedOut ? 'Pulsar did not respond in time. Try a smaller batch.' : (error?.message || 'Push failed.')
        });
    }
}
