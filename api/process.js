import Groq from "groq-sdk";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { payload } = req.body;

        const chat = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [{
                role: "user",
                content: `
                Clean and analyze this social media OCR text: "${payload}"

                1. Extract every comment: Author, Text, Likes, and Raw Timestamp (e.g., "2h", "now").
                2. If comment is just an image, use "[Image/GIF Only]" and sentiment "Neutral".
                3. Categorize Sentiment: "Positive", "Negative", or "Neutral".
                4. Create a 2-3 sentence 'summary' of the main conversation topics and mood.
                5. Calculate SOV percentages (Exclude [Image/GIF Only] from math).

                Return ONLY JSON:
                {
                    "comments": [{ "author": "...", "text": "...", "likes": 0, "timestamp": "...", "sentiment": "..." }],
                    "summary": "...",
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
