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
        
        // Using standard Flash model
        const model = "gemini-1.5-flash"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        let promptText = "";
        let contents = [];

        // --- 1. IMAGE EXTRACTION ---
        if (type === 'extraction') {
            promptText = `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only). Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }`;
            contents = [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/png", data: payload } }] }];
        
        // --- 2. SENTIMENT ANALYSIS ---
        } else if (type === 'sentiment') {
            promptText = `Analyze sentiment. Classify each as 'Positive', 'Negative', or 'Neutral'. Calculate Share of Voice (SOV). Input: ${JSON.stringify(payload)}. Return JSON only: { "sentiments": ["Positive", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`;
            contents = [{ parts: [{ text: promptText }] }];

        // --- 3. NEW: SUMMARIZATION ---
        } else if (type === 'summary') {
            promptText = `Analyze these comments and provide a high-level summary. 
            1. Identify the main topic of discussion.
            2. Summarize the general consensus or debate.
            3. List 3 key recurring themes or complaints.
            Input: ${JSON.stringify(payload)}. 
            Return JSON only: { "summary": "## Executive Summary\\n\\n[Write a professional summary here]\\n\\n### Key Themes\\n* [Theme 1]\\n* [Theme 2]\\n* [Theme 3]" }`;
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
