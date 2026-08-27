// Thin authenticated proxy to Pulsar's first-party-data pusher.
//
// The client's API key arrives per request from the browser and is used once to
// sign the upstream call. It is never stored, never written to a log, and never
// returned in a response — this file must stay that way.
// Two different APIs: searches are created on TRAC (v1), content is pushed to
// the interaction pusher. Both endpoints are known, and overridable.
const PULSAR_URL = process.env.PULSAR_GRAPHQL_URL || "https://interaction-pusher.pulsarplatform.com/graphql";
const TRAC_URL = process.env.PULSAR_TRAC_URL || "https://trac.pulsarplatform.com/graphql";
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

// The pusher API cannot create a search, but TRAC can: a topics search with
// FIRST_PARTY_DATA as its only category, whose payload carries the searchHash
// the pusher then needs.
const CREATE_SEARCH = `mutation CreateFPDSearch($input: CreateTopicsSearchInput!) {
  createTopicsSearch(input: $input) {
    errors { message path }
    search { searchHash name id }
  }
}`;

async function createSearch({ apiKey, name, keywords }) {
    const response = await fetch(TRAC_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            [AUTH_HEADER]: AUTH_SCHEME ? `${AUTH_SCHEME} ${apiKey}` : apiKey
        },
        body: JSON.stringify({
            query: CREATE_SEARCH,
            variables: {
                input: {
                    name,
                    categories: ["FIRST_PARTY_DATA"],
                    // keywords is required by the schema and is a list of lists:
                    // the inner list is OR'd, the outer AND'd.
                    keywords: [keywords]
                }
            }
        }),
        signal: AbortSignal.timeout(45_000)
    });

    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
        const error = new Error('Pulsar rejected the API key.');
        error.status = response.status;
        throw error;
    }

    let body;
    try {
        body = JSON.parse(text);
    } catch {
        const error = new Error(`TRAC returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
        error.status = 502;
        throw error;
    }

    const problems = describeProblems(body);
    const payload = body?.data?.createTopicsSearch;
    const fieldErrors = (payload?.errors || []).map(e =>
        `${(e.path || []).join('.') || 'search'}: ${e.message}`);

    const all = [...problems, ...fieldErrors];
    if (all.length) return { ok: false, stage: 'createSearch', problems: all };

    const searchHash = payload?.search?.searchHash;
    if (!searchHash) {
        return { ok: false, stage: 'createSearch', problems: ['Pulsar created no search and reported no error.'] };
    }

    return { ok: true, stage: 'createSearch', searchHash, name: payload.search.name || name };
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


export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { apiKey, searchHash, mode, interactions, name, keywords } = req.body || {};

        if (!apiKey) return res.status(400).json({ error: 'Enter your Pulsar API key.' });

        if (mode === 'createSearch') {
            const cleanName = String(name || '').trim();
            const cleanKeywords = (Array.isArray(keywords) ? keywords : [])
                .map(k => String(k).trim()).filter(Boolean);

            if (!cleanName) return res.status(400).json({ error: 'Give the new search a name.' });
            if (!cleanKeywords.length) return res.status(400).json({ error: 'Add at least one keyword for the new search.' });

            return res.status(200).json(await createSearch({ apiKey, name: cleanName, keywords: cleanKeywords }));
        }
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
        if (timedOut) {
            return res.status(504).json({ error: 'Pulsar did not respond in time. Try a smaller batch.' });
        }

        // createSearch marks auth and gateway failures with a status; honour it
        // rather than flattening everything to 500.
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
            ? error.status
            : 500;
        return res.status(status).json({ error: error?.message || 'Push failed.' });
    }
}
