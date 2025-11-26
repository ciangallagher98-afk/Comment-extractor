// Vercel Serverless Function
export default async function handler(req, res) {
    // 1. Security: Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 2. Get the Secret Key from the Server Environment
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server Misconfiguration: No API Key found.' });
    }

    try {
        const { type, payload } = req.body;
        const model = "gemini-1.5-flash"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        let promptText = "";
        let contents = [];

        // 3. Construct the request based on what the user wants (Extraction vs Sentiment)
        if (type === 'extraction') {
            promptText = `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only, convert "1.2k" to 1200). If hidden/missing, use 0. Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`;
            contents = [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/png", data: payload } }] }];
        } else if (type === 'sentiment') {
            const commentTexts = payload; // Payload is array of strings here
            promptText = `Analyze the sentiment of these comments. 1. Classify each as 'Positive', 'Negative', or 'Neutral'. 2. Calculate Share of Voice (SOV). Input: ${JSON.stringify(commentTexts)}. Return JSON only: { "sentiments": ["Positive", "Neutral", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`;
            contents = [{ parts: [{ text: promptText }] }];
        } else {
            return res.status(400).json({ error: 'Invalid Type' });
        }

        // 4. Call Google Gemini (Server to Server)
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
            throw new Error(`Gemini API Error: ${errorText}`);
        }

        const data = await googleResponse.json();
        const jsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        // 5. Send clean data back to the user
        res.status(200).json(JSON.parse(jsonText));

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}