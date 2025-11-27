export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server Misconfiguration: No API Key found.' });
    }

    try {
        // ============================================================
        // STEP 1: AUTO-DISCOVERY (The "Stop Guessing" Fix)
        // ============================================================
        
        // Ask Google what models are actually available for this key
        const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        
        if (!listResponse.ok) {
            throw new Error(`Failed to list models: ${listResponse.statusText}`);
        }

        const listData = await listResponse.json();
        
        // Filter the list for models that:
        // 1. Support 'generateContent' (can write text)
        // 2. Are NOT 'learnlm' (the broken one you hit earlier)
        // 3. Are NOT 'vision' specific (we need text+image generic models)
        const validModels = listData.models.filter(m => {
            const name = m.name.toLowerCase();
            const methods = m.supportedGenerationMethods || [];
            return methods.includes('generateContent') && 
                   !name.includes('learnlm') && 
                   !name.includes('vision') &&
                   !name.includes('embedding');
        });

        if (validModels.length === 0) {
            throw new Error("Your API Key has no access to any generative models.");
        }

        // Sort models to prefer 'Flash' first, then 'Pro'
        // This ensures we get the fastest/cheapest model available to you
        validModels.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            if (aName.includes('flash') && !bName.includes('flash')) return -1;
            if (!aName.includes('flash') && bName.includes('flash')) return 1;
            return 0;
        });

        // Pick the top winner
        // IMPORTANT: The API returns names like "models/gemini-1.5-flash". 
        // We use this exact string for the next request.
        const BEST_MODEL = validModels[0].name;
        console.log(`Auto-selected Model: ${BEST_MODEL}`); 

        // ============================================================
        // STEP 2: PERFORM THE REQUEST
        // ============================================================

        const { type, payload } = req.body;
        // Construct URL using the auto-discovered name (remove 'models/' prefix if it exists in base URL logic, 
        // but here we just append the clean name or handle the path correctly)
        
        // Safety: ensure no double 'models/' in URL
        const cleanModelName = BEST_MODEL.replace('models/', '');
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent?key=${GEMINI_API_KEY}`;

        let promptText = "";
        let contents = [];

        if (type === 'extraction') {
            promptText = `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only). Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`;
            contents = [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/png", data: payload } }] }];
        } else if (type === 'sentiment') {
            promptText = `Analyze sentiment. Classify as 'Positive', 'Negative', or 'Neutral'. Calculate Share of Voice (SOV). Input: ${JSON.stringify(payload)}. Return JSON only: { "sentiments": ["Positive", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`;
            contents = [{ parts: [{ text: promptText }] }];
        } else if (type === 'summary') {
            promptText = `Summarize these comments. Input: ${JSON.stringify(payload)}. Return JSON only: { "summary": "## Summary\\n\\n..." }`;
            contents = [{ parts: [{ text: promptText }] }];
        } else {
            return res.status(400).json({ error: 'Invalid Type' });
        }

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
            throw new Error(`Gemini API Error using ${cleanModelName}: ${errorText}`);
        }

        const data = await googleResponse.json();
        const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        res.status(200).json(JSON.parse(jsonText));

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ error: error.message });
    }
}
