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
                Clean this OCR text from multiple social media comment screenshots.
                Text: "${payload}"

                Special Instructions:
                1. If a comment block is unreadable or just an image/GIF, set the text to "[Image/GIF Only]" and sentiment to "Neutral".
                2. Extract author, comment text, and like count.
                3. Assign sentiment: "Positive", "Negative", or "Neutral".
                4. Calculate SOV percentages (Exclude [Image/GIF Only] comments from the SOV math).

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
