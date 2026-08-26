# Comment-extractor

Turns screenshots of a social media comments section into structured, exportable data.

Upload one or more screenshots; a vision model reads them directly, extracts each
comment with its author, text, like count and timestamp, scores sentiment, and
renders a summary, a share-of-voice chart and a CSV-exportable table.

## How it works

| File | Role |
| --- | --- |
| `index.html` | Whole frontend. Downscales screenshots in-browser, POSTs them to the API, renders the dashboard. |
| `api/process.js` | Serverless function. Sends the images to a Qwen vision model and normalises the JSON that comes back. |

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
and keep thread order; share-of-voice is recomputed server-side from the comments
that survive, so the chart can never disagree with the table.
