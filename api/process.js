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
                content: `Analyze this raw OCR text from social media screenshots: "${payload}"

                1. Extract every individual comment.
                2. Data points: Author (as "author"), Text (as "text"), Likes (as "likes"), and Raw Timestamp (as "timestamp" e.g., "5h", "now").
                3. Handle images/GIFs: If no text, set text to "[Image/GIF Only]" and sentiment to "Neutral".
                4. Sentiment: Categorize as "Positive", "Negative", or "Neutral".
                5. Summary: Write a 2-3 sentence overview of the conversation (as "summary").
                6. SOV: Calculate % for "Positive", "Negative", "Neutral" as whole integers (as "sov").

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
