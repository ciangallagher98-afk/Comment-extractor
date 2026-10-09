# Comment Extractor — Chrome extension

Collects a post and all its comments from **TikTok, Instagram, Facebook, X,
LinkedIn, YouTube, Threads, Bluesky and Reddit** and sends them straight to the [Comment Extractor](https://comment-extractor-nine.vercel.app/)
website — no screenshots. You get exact text, authors, like counts, real dates
and reply threads.

## Install (2 minutes, no coding)

1. On the [Comment Extractor](https://comment-extractor-nine.vercel.app/) website,
   click **Get the Chrome extension** and download it. Unzip it and keep the
   `comment-extractor-extension` folder somewhere permanent (e.g. Documents).
   Chrome loads it from there, so don't delete it afterwards.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (switch in the top-right corner).
4. Click **Load unpacked** and choose the folder from step 1 (the one that
   contains `manifest.json`).
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Comment Extractor**
   so its button is always visible.
6. **Reload** any social media tabs that were already open.

## Use it

1. Open the post on its own page (click its date or timestamp). The popup tells
   you if you're not on a post page yet.
2. Click the Comment Extractor button and choose how many comments to collect
   (up to 2,000).
3. Press **Start collecting**. A panel in the bottom-right corner shows progress
   while it scrolls the comments and opens the replies. Keep the tab open.
4. When it finishes, Comment Extractor opens in a new tab and analyses the
   comments automatically. From there, export CSV / PDF or push to Pulsar as usual.

Press **Stop & send** at any time to send what's been collected so far.

## How each platform is collected

| Platform | How | Notes |
| --- | --- | --- |
| TikTok, Instagram, X, Facebook, YouTube, Threads | Copies the comment data the site loads while it scrolls and opens replies | Facebook's "Most relevant" filter is switched to "All comments" (or "Newest") automatically |
| LinkedIn | Reads the comments off the page while it clicks "Load more comments" and opens replies | Exact dates come from each comment's id |
| Bluesky, Reddit | Fetches the whole thread in one go from the platform's own data address | No scrolling; Reddit's hidden "more replies" are fetched too |

## Good to know

- It collects what a normal logged-in visitor can see. If the site hides some
  replies, they won't be collected.
- It scrolls at a normal human pace on purpose, so very large posts take a few
  minutes.
- It uses your own browser session. Nothing is stored or sent anywhere except
  to the Comment Extractor website when you finish.
- Logged-out visitors see fewer comments on some sites (Threads, X), so stay
  logged in for the fullest results.
- If a platform changes its site and collecting stops working there, the
  translator for that platform lives in `platforms.js`.

## Updating

The website's header shows **Extension update available** when a newer version
is out. Download it from the same button, replace the folder's files with the
new version, then go to `chrome://extensions` and click the circular **reload**
arrow on the Comment Extractor card.

**For whoever maintains it:** after changing anything here, bump `version` in
`manifest.json`, run `scripts/build-extension.sh`, and commit the files it
writes to `downloads/`. That's what the website's download button serves.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Name, permissions, and which sites each script runs on |
| `config.js` | Website address and limits — the only file you'd normally edit |
| `catcher.js` | Copies the comment data the site downloads for itself |
| `platforms.js` | One translator per platform |
| `collector.js` | Stores comments, scrolls, opens replies, shows the progress panel |
| `background.js` | Opens the website when collecting finishes |
| `bridge.js` | Hands the comments to the website page |
| `popup.html` / `popup.js` | The window that opens from the toolbar button |
