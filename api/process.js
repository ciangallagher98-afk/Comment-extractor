export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Vercel automatically loads this from the "Environment Variables" you set in the dashboard
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server Misconfiguration: No API Key found in Vercel Settings.' });
    }

    try {
        const { type, payload } = req.body;
        
        // *** FIX: Updated to the current 2025 standard model ***
        const model = "gemini-2.5-flash"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        let promptText = "";
        let contents = [];

        if (type === 'extraction') {
            promptText = `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only, convert "1.2k" to 1200). If hidden/missing, use 0. Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`;
            contents = [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/png", data: payload } }] }];
        } else if (type === 'sentiment') {
            const commentTexts = payload;
            promptText = `Analyze the sentiment of these comments. 1. Classify each as 'Positive', 'Negative', or 'Neutral'. 2. Calculate Share of Voice (SOV). Input: ${JSON.stringify(commentTexts)}. Return JSON only: { "sentiments": ["Positive", "Neutral", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`;
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
            // Pass the exact error from Google back to the user for debugging
            throw new Error(`Gemini API Error: ${errorText}`);
        }

        const data = await googleResponse.json();
        const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        res.status(200).json(JSON.parse(jsonText));

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ error: error.message });
    }
}
