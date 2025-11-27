export default async function handler(req, res) {
    // 1. Basic Setup
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server Misconfiguration: No API Key found.' });
    }

    // 2. THE FIX: The Priority List
    // We try the newest experimental model first (likely what your key needs),
    // then fall back to the standard ones.
    const MODEL_PRIORITY = [
        "gemini-2.0-flash-exp", // The newest model (Fixes the "learnlm" issue)
        "gemini-1.5-flash",     // Standard fallback
        "gemini-1.5-flash-8b",  // Lightweight fallback
        "gemini-1.5-pro"        // Heavy fallback
    ];

    try {
        const { type, payload } = req.body;
        let successfulData = null;
        let lastError = null;

        // 3. The Loop: Try models until one works
        for (const model of MODEL_PRIORITY) {
            try {
                console.log(`Trying model: ${model}...`);
                
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
                let promptText = "";
                let contents = [];

                // Construct Prompt
                if (type === 'extraction') {
                    promptText = `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only). Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`;
                    contents = [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/png", data: payload } }] }];
                } else if (type === 'sentiment') {
                    promptText = `Analyze sentiment. Classify as 'Positive', 'Negative', or 'Neutral'. Calculate Share of Voice (SOV). Input: ${JSON.stringify(payload)}. Return JSON only: { "sentiments": ["Positive", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`;
                    contents = [{ parts: [{ text: promptText }] }];
                } else if (type === 'summary') {
                    promptText = `Summarize these comments. Input: ${JSON.stringify(payload)}. Return JSON only: { "summary": "## Executive Summary\\n\\n..." }`;
                    contents = [{ parts: [{ text: promptText }] }];
                } else {
                    return res.status(400).json({ error: 'Invalid Type' });
                }

                // Call Google
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: contents,
                        generationConfig: { responseMimeType: "application/json" }
                    })
                });

                if (!response.ok) {
                    const txt = await response.text();
                    throw new Error(`${response.status}: ${txt}`);
                }

                const data = await response.json();
                
                // If we got here, it worked!
                const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!jsonText) throw new Error("Empty response");
                
                successfulData = JSON.parse(jsonText);
                break; // EXIT THE LOOP

            } catch (error) {
                console.warn(`Model ${model} failed: ${error.message}`);
                lastError = error;
                // Continue to the next model in the list
            }
        }

        if (successfulData) {
            return res.status(200).json(successfulData);
        } else {
            throw new Error(`All models failed. Last error: ${lastError.message}`);
        }

    } catch (globalError) {
        console.error("Fatal Error:", globalError);
        res.status(500).json({ error: globalError.message });
    }
}
