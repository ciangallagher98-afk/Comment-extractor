# Comment-extractor

Turns screenshots of a social media comments section into structured, exportable data.

Upload one or more screenshots; a vision model reads them directly, extracts each
comment with its author, text, like count and timestamp, scores sentiment, and
renders a summary, a share-of-voice chart and a CSV-exportable table.

## How it works

| File | Role |
| --- | --- |
| `index.html` | Whole frontend. Downscales screenshots in-browser, POSTs them to the API, renders the dashboard. |
| `api/process.js` | Serverless function. Sends the images to a vision model and normalises the JSON that comes back. |
| `api/pulsar.js` | Authenticated proxy to Pulsar's first-party-data pusher. |

Images are downscaled to 1080px wide as JPEG before upload — full-resolution
screenshots exceed Vercel's ~4.5MB request body limit. Limit is 8 screenshots
per run (`MAX_IMAGES`, kept in sync between both files).

## Setup

Set these in Vercel under Settings -> Environment Variables:

| Variable | Required | Default |
| --- | --- | --- |
| `VISION_API_KEY` | yes | — |
| `VISION_BASE_URL` | no | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `VISION_MODEL` | no | `gemini-2.5-flash` |
| `PULSAR_GRAPHQL_URL` | only for the Pulsar push | — |
| `PULSAR_AUTH_HEADER` | no | `Authorization` |
| `PULSAR_AUTH_SCHEME` | no | `Bearer` |

The default is Google's Gemini API, whose free tier needs no card — get a key
at [aistudio.google.com](https://aistudio.google.com). Any provider exposing an
OpenAI-compatible `/chat/completions` endpoint works; switching providers is a
change to these three values, not to code. A trailing slash on the base URL is
stripped, so either form is fine.

`GET /api/process` is a diagnostic. It sends a tiny request to a shortlist of
vision models and reports which ones the account can actually call — a provider
listing its catalogue does not mean the key is entitled to any of it. Append
`?model=<id>` to test one specific model, or `?full=1` to dump the catalogue.

`VISION_API_KEY` falls back to `DASHSCOPE_API_KEY`, and `VISION_BASE_URL` to
`DASHSCOPE_BASE_URL`, so an older deployment keeps working.

## Notes

Screenshots of a scrolling feed overlap, so the same comment appears in more than
one image. The prompt in `api/process.js` instructs the model to merge duplicates
and keep thread order.

Anything the model is asked to *count* is recomputed server-side from the comments
that survive — share of voice, totals, averages — so the charts can never disagree
with the table.

Sentiment is an ordered scale, so it renders as a diverging stacked bar (negative
-> neutral -> positive) rather than a pie. The positive pole is blue, not green:
green against red measures deltaE 4.1 under deuteranopia, which is indistinguishable
for red-green colourblind readers. Every segment is labelled as well, so colour is
never the only carrier of meaning.

PDF export goes through the browser's own print pipeline (`window.print()` plus a
print stylesheet) rather than a rendering library, so the text stays selectable
and there is no dependency to keep current.

## Pushing to Pulsar

`api/pulsar.js` sends extracted comments to Pulsar's first-party-data pusher as
`Interaction` records: the original post as `type: "post"`, each comment as
`type: "comment"`, with `counters.likes` and an ISO8601 `publishedAt`.

Set `PULSAR_GRAPHQL_URL` to the GraphQL v2 endpoint. If the API expects
something other than `Authorization: Bearer <key>`, override
`PULSAR_AUTH_HEADER` and `PULSAR_AUTH_SCHEME`; an empty scheme sends the key
bare.

The pusher cannot create a search — that is REST API v3 only — so the search
must exist and its hash is pasted into the tool.

A batch is all-or-nothing: one bad row rejects the whole call. So every batch is
validated with `validateInteraction` before any is sent to `storeInteraction`,
and rows are checked locally first, which names the offending row without a
round trip.

`content.remoteId` is derived from the content itself rather than randomly, so
re-pushing the same thread updates those rows instead of duplicating them. This
is deliberately *not* the CSV's per-row UUID, which is random by design and would
duplicate on every push.

The client's API key is supplied per request from the browser, used once to sign
the upstream call, and never stored or logged. It is held in `sessionStorage`,
so it lives in that tab only.
