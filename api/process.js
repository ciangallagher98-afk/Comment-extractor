import Groq from "groq-sdk";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: 'Server Misconfiguration: No Groq API Key found.' });
    }

    try {
        const { type, payload } = req.body;
        let messages = [];
        
        // 2026 Stable Text Model
        let model = "llama-3.3-70b-versatile"; 

        if (type === 'extraction') {
            // Updated to the current stable Vision model
            model = "llama-3.2-90b-vision-preview"; 
            messages = [
                {
                    role: "user",
                    content: [
                        { 
                            type: "text", 
                            text: `Analyze this screenshot of a comment section. Extract: 1. Author name 2. Comment text (exact transcription) 3. Relative timestamp (e.g., "2h", "5d"). 4. Like count (number only). Return JSON only: { "comments": [{ "author": "...", "text": "...", "timestamp": "...", "likes": 0 }] }` 
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/png;base64,${payload}`,
                            },
                        },
                    ],
                },
            ];
        } else if (type === 'sentiment') {
            messages = [
                {
                    role: "user",
                    content: `Analyze sentiment for these comments. Classify as 'Positive', 'Negative', or 'Neutral'. Calculate Share of Voice (SOV). Input: ${JSON.stringify(payload)}. Return JSON only: { "sentiments": ["Positive", ...], "sov": { "Positive": 50, "Negative": 20, "Neutral": 30 } }`
                }
            ];
        } else if (type === 'summary') {
            messages = [
                {
                    role: "user",
                    content: `Summarize these comments using Markdown formatting. Input: ${JSON.stringify(payload)}. Return JSON only: { "summary": "## Summary\\n\\n..." }`
                }
            ];
        } else {
            return res.status(400).json({ error: 'Invalid Type' });
        }

        const chatCompletion = await groq.chat.completions.create({
            messages: messages,
            model: model,
            response_format: { type: "json_object" },
            temperature: 0.1, 
        });

        const responseContent = chatCompletion.choices[0]?.message?.content;
        res.status(200).json(JSON.parse(responseContent));

    } catch (error) {
        console.error("Groq API Error:", error);
        res.status(500).json({ error: error.message });
    }
}
