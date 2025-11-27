export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server Misconfiguration: No API Key found.' });
    }

    // LIST OF SAFE MODELS TO TRY (In order of preference)
    // We strictly avoid "experimental" or "learnlm" models to prevent 404s.
    const MODEL_CANDIDATES = [
        "gemini-1.5-flash",
        "gemini-1.5-flash-002",
        "gemini-1.5-flash-001",
        "gemini-1.5-pro"
    ];

    try {
        const { type, payload } = req.body;
        let lastError = null;

        // --- LOOP THROUGH MODELS UNTIL ONE WORKS ---
        for (const model of MODEL_CANDIDATES) {
            try {
                console.log(`Attempting model: ${model}`); // Logs to Vercel console
                const result = await callGoogle(model, type, payload, GEMINI_API_KEY);
                
                // If we get here, it worked! Return the data and exit the function.
                return res.status(200).json(result);

            } catch (error) {
                console.warn(`Model ${model} failed:`, error.message);
                lastError = error;
                // If it's a 404 or 400 (Bad Request), we try the next model.
                // If it's a 429 (Quota Limit), we theoretically should stop, but keeping it simple.
                continue; 
            }
        }

        // If we ran out of models and none worked:
        throw new Error(`All models failed. Last error: ${lastError.message}`);

    } catch (globalError) {
        console.error("Backend Fatal Error:", globalError);
        res.status(500).json({ error: globalError.message });
    }
}

// Helper function to perform the actual fetch
async function callGoogle(model, type, payload, apiKey) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    let promptText = "";
    let contents = [];

    if (type === 'extraction') {
        promptText = `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only). Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`;
        contents = [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/png", data: payload } }] }];
    } else if (type === 'sentiment') {
        promptText = `Analyze sentiment. Classify each as 'Positive', 'Negative', or 'Neutral'. Calculate Share of Voice (SOV). Input: ${JSON.stringify(payload)}. Return JSON only: { "sentiments": ["Positive", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`;
        contents = [{ parts: [{ text: promptText }] }];
    } else if (type === 'summary') {
        promptText = `Analyze these comments and provide a high-level summary. Input: ${JSON.stringify(payload)}. Return JSON only: { "summary": "## Summary\\n\\n..." }`;
        contents = [{ parts: [{ text: promptText }] }];
    } else {
        throw new Error('Invalid Request Type');
    }

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: contents,
            generationConfig: { responseMimeType: "application/json" }
        })
    });

    if (!response.ok) {
        // We throw here so the Loop catches it and tries the next model
        const txt = await response.text();
        throw new Error(`Google Error (${response.status}): ${txt}`);
    }

    const data = await response.json();
    const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!jsonText) throw new Error("Empty response from AI");
    
    return JSON.parse(jsonText);
}
