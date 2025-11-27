export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server Misconfiguration: No API Key found.' });
    }

    try {
        const { type, payload } = req.body;

        // --- STEP 1: DYNAMICALLY FIND A WORKING MODEL ---
        // Instead of guessing, we ask Google what models are valid right now.
        const modelsResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        if (!modelsResponse.ok) throw new Error("Failed to fetch model list from Google.");
        
        const modelsData = await modelsResponse.json();
        
        // Find the newest model that has "flash" in the name and supports content generation
        // This makes the code "Future Proof" against version changes (1.5 -> 2.0 -> 2.5 etc)
        const validModels = modelsData.models.filter(m => 
            m.name.toLowerCase().includes('flash') && 
            m.supportedGenerationMethods.includes('generateContent')
        );

        if (validModels.length === 0) {
            throw new Error("No 'Flash' models found available for your API key.");
        }

        // Sort to get the latest version (usually higher numbers or 'latest' suffix)
        // We prefer '002' or 'latest' over '001'.
        validModels.sort((a, b) => b.name.localeCompare(a.name));
        
        // Pick the best one (remove 'models/' prefix if present)
        const bestModel = validModels[0].name.replace('models/', '');
        console.log("Using Model:", bestModel); // Logs to Vercel console for debugging

        // --- STEP 2: PREPARE THE REQUEST ---
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${bestModel}:generateContent?key=${GEMINI_API_KEY}`;
        let promptText = "";
        let contents = [];

        if (type === 'extraction') {
            promptText = `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only). Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`;
            contents = [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/png", data: payload } }] }];
        } else if (type === 'sentiment') {
            promptText = `Analyze sentiment. Classify each as 'Positive', 'Negative', or 'Neutral'. Calculate Share of Voice (SOV). Input: ${JSON.stringify(payload)}. Return JSON only: { "sentiments": ["Positive", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`;
            contents = [{ parts: [{ text: promptText }] }];
        } else if (type === 'summary') {
            promptText = `Analyze these comments and provide a high-level summary. Input: ${JSON.stringify(payload)}. Return JSON only: { "summary": "## Summary\\n\\n[Text]..." }`;
            contents = [{ parts: [{ text: promptText }] }];
        } else {
            return res.status(400).json({ error: 'Invalid Type' });
        }

        // --- STEP 3: SEND TO GOOGLE ---
        const googleResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: contents,
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        if (!googleResponse.ok) {
            const errorText = await googleResponse.text();
            throw new Error(`Gemini API Error (${bestModel}): ${errorText}`);
        }

        const data = await googleResponse.json();
        const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        res.status(200).json(JSON.parse(jsonText));

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ error: error.message });
    }
}
