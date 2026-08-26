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

Set these in Vercel under Settings → Environment Variables:

| Variable | Required | Default |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | yes | — |
| `DASHSCOPE_BASE_URL` | no | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `VISION_MODEL` | no | `qwen3-vl-plus` |

The key comes from QwenCloud → API Keys (Pay-As-You-Go). QwenCloud exposes an
OpenAI-compatible endpoint, so the standard `openai` client is used with a
custom `baseURL` — swapping to another provider is a base URL and model change.

`VISION_MODEL` is an env var so you can A/B models without redeploying code.
Check the QwenCloud Models page for the exact ids available on your account.

## Notes

Screenshots of a scrolling feed overlap, so the same comment appears in more than
one image. The prompt in `api/process.js` instructs the model to merge duplicates
and keep thread order; share-of-voice is recomputed server-side from the comments
that survive, so the chart can never disagree with the table.
