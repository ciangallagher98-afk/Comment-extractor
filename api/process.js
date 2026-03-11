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
                You are a data extraction expert. Below is raw OCR text from social media screenshots.
                
                Input Text: "${payload}"

                Instructions:
                1. Extract every individual comment. 
                2. For each, find: Author, Comment Text, Likes (number), and Raw Timestamp (e.g., "2h", "5d", "now").
                3. If a comment is just an image/GIF or illegible, use text "[Image/GIF Only]" and sentiment "Neutral".
                4. Assign Sentiment: "Positive", "Negative", or "Neutral".
                5. Calculate SOV %: (Count of Positive/Negative/Neutral divided by total real-text comments).

                Format as strictly valid JSON:
                {
                    "comments": [{ "author": "...", "text": "...", "likes": 0, "timestamp": "...", "sentiment": "..." }],
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
