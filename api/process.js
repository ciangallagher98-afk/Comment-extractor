import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { payload } = req.body;
        
        // Using Llama 3.3 (2026 Production Standard)
        const chat = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [{
                role: "user",
                content: `
                Clean this OCR text from social media comments and analyze it.
                Text: "${payload}"

                Tasks:
                1. Extract author, comment text, and like count (number).
                2. Assign sentiment: "Positive", "Negative", or "Neutral".
                3. Calculate Share of Voice (SOV) percentages for all three.

                Return ONLY JSON:
                {
                    "comments": [{ "author": "...", "text": "...", "likes": 0, "sentiment": "..." }],
                    "sov": { "Positive": 0, "Negative": 0, "Neutral": 0 }
                }`
            }],
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        res.status(200).json(JSON.parse(chat.choices[0].message.content));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
