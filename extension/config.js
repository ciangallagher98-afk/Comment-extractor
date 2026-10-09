// Settings shared by every part of the extension.
// If the Comment Extractor website ever moves to a new address, change toolUrl
// here AND the matching address under "content_scripts" in manifest.json.
const CE_CONFIG = {
    toolUrl: "https://comment-extractor-nine.vercel.app/",
    defaultMax: 1000,   // comments collected per run unless changed in the popup
    hardMax: 2000,      // the website analyses at most this many per run
    maxMinutes: 12      // a run stops on its own after this long
};
